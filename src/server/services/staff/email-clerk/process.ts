/**
 * The `email_clerk:process` sweep (every minute; docs/ai-staff.md → "Email inbox"): every stored
 * email is claimed (a 5-minute lease; status → processing, attempts + 1, conditional on what we
 * read), fetched if the webhook couldn't, classified (rules, then the model, then keywords), acted
 * on, and its attachments kept. A failed pass is retried after 10 minutes, 3 tries in all. Then
 * the alerts held overnight go out (08:00–21:00).
 *
 *   forwarding confirmation → the code + steps to the owner (any hour; links never clicked)
 *   customer                → customer.ts (contact, message_log, consent, draft → email_reply)
 *   bid invite              → owner text as it arrives + an owner task
 *   supplier about our PO   → owner text as it arrives (other supplier mail → the digest)
 *   bill / other            → the 16:00 digest (digest.ts)
 *   auto-reply / bounce / newsletter / no-reply / spam → stored, counted in the digest, nothing else
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { getPack } from "@/server/services/packs";
import { parseAppliedIndustryPack } from "@/server/services/packs/types";
import { createTask } from "@/server/services/tasks";
import { ctxFor } from "@/server/services/owner-channel/common";
import { classifyEmail } from "./ai";
import { alertForEmail, flushHeldAlerts, textOwner } from "./alerts";
import { classifyByRules, fallbackCategory, type ClassifyContext, type EmailFacts } from "./classify";
import { findContactByEmail, handleCustomerEmail } from "./customer";
import type { Db, EmailCategory, EmailDetail, EmailInboxRow, InboundEmailRow } from "./db-types";
import { emailClerkDeps } from "./deps";
import { forwardingText } from "./format";
import { fetchContent } from "./intake";
import { loadInboxById } from "./inboxes";
import { clean, firstAsk, normalizeAddress, poNumbersIn } from "./parse";
import { emailClerkOn, inboundConfigured, inboundDomain, loadEmailClerkCompany, type EmailClerkCompany } from "./settings";
import { attachmentPathFor, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, normalizeAttachmentType } from "./storage";
import { localDateOf } from "./time";

export const LEASE_MS = 5 * 60_000;
export const RETRY_AFTER_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 3;
const BATCH = 25;

/** Categories whose attachments are worth keeping. */
const KEEP_FILES: EmailCategory[] = ["customer", "supplier", "bid_invite", "bill", "other"];

/** Can this row be claimed now? PURE. (The sweep's queries filter the same way in SQL.) */
export function claimable(row: Pick<InboundEmailRow, "status" | "attempts" | "locked_until" | "updated_at">, nowMs: number): boolean {
  if (row.status === "new" || row.status === "received") return row.attempts < MAX_ATTEMPTS;
  if (row.status === "processing") return !row.locked_until || Date.parse(row.locked_until) <= nowMs;
  if (row.status === "failed") return row.attempts < MAX_ATTEMPTS && nowMs - Date.parse(row.updated_at) >= RETRY_AFTER_MS;
  return false;
}

/**
 * Take the row (status → processing, attempts + 1, a lease from the real clock, not the pass's
 * start). A row whose tries are used up (a worker died holding its last lease) becomes `dead`.
 */
async function claim(admin: AdminClient, row: InboundEmailRow): Promise<InboundEmailRow | null> {
  const db = admin as Db;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  if (row.attempts >= MAX_ATTEMPTS) {
    await db.from("inbound_emails").update({ status: "dead", locked_until: null, last_error: row.last_error ?? "gave up after 3 tries", updated_at: nowIso }).eq("id", row.id).eq("status", row.status).eq("updated_at", row.updated_at);
    return null;
  }
  const fields = { status: "processing", locked_until: new Date(nowMs + LEASE_MS).toISOString(), attempts: row.attempts + 1, updated_at: nowIso };
  const { data } = await db.from("inbound_emails").update(fields).eq("id", row.id).eq("status", row.status).eq("updated_at", row.updated_at).select("*");
  const hit = ((data ?? []) as InboundEmailRow[])[0];
  return hit ? { ...row, ...hit, status: "processing" } : null;
}

async function finish(admin: AdminClient, id: string, status: "done" | "failed" | "ignored" | "dead", nowMs: number, error?: string | null): Promise<void> {
  const nowIso = new Date(nowMs).toISOString();
  await (admin as Db)
    .from("inbound_emails")
    .update({ status, locked_until: null, last_error: error ? error.slice(0, 500) : null, updated_at: nowIso, ...(status === "done" ? { processed_at: nowIso } : {}) })
    .eq("id", id)
    .eq("status", "processing");
}

function tradeOf(pack: unknown): string | null {
  const applied = parseAppliedIndustryPack(pack);
  return applied ? getPack(applied.id)?.name ?? null : null;
}

async function classifyContext(admin: AdminClient, company: EmailClerkCompany, row: InboundEmailRow, inbox: EmailInboxRow): Promise<ClassifyContext> {
  const db = admin as Db;
  // Purchasing's tables (Phase 4): read tolerantly — no suppliers or POs just means no match.
  let suppliers: ClassifyContext["suppliers"] = [];
  let purchaseOrders: ClassifyContext["purchaseOrders"] = [];
  try {
    const { data, error } = await db.from("suppliers").select("id, name, branch, email").eq("organization_id", company.organizationId).eq("company_id", company.companyId).eq("active", true).limit(200);
    if (!error) suppliers = (data ?? []) as ClassifyContext["suppliers"];
    const named = poNumbersIn(`${row.subject ?? ""}\n${row.text_body ?? ""}`);
    if (named.length) {
      const res = await db.from("purchase_orders").select("id, po_number, supplier_id, status").eq("organization_id", company.organizationId).eq("company_id", company.companyId).in("po_number", named);
      if (!res.error) purchaseOrders = (res.data ?? []) as ClassifyContext["purchaseOrders"];
    }
  } catch {
    // tolerant
  }
  const known = row.from_address ? Boolean(await findContactByEmail(admin, company, row.from_address)) : false;
  // Our sending address (outbound/email.ts readEmailConfig's), to spot our own mail looping back.
  const outbound = process.env.OUTBOUND_FROM_EMAIL || process.env.LEAD_FROM_EMAIL || null;
  return { inboxAddress: inbox.address, inboundDomain: inboundDomain(), outboundFrom: outbound, ownerEmail: company.ownerEmail, forwardedFrom: inbox.forwarded_from, suppliers, purchaseOrders, knownContact: known };
}

interface Decided {
  category: EmailCategory;
  by: "rules" | "model" | "fallback";
  detail: EmailDetail;
  summary: string | null;
  supplierId: string | null;
  purchaseOrderId: string | null;
  code: string | null;
}

/** Person-to-person mail whose From isn't verified (DKIM/DMARC) is never treated as that person: digest only, labelled. */
function unverifiedCustomer(d: Decided): Decided {
  return { ...d, category: "other", detail: { ...d.detail, reason: "unverified sender" } };
}

async function decide(admin: AdminClient, company: EmailClerkCompany, row: InboundEmailRow, inbox: EmailInboxRow, nowMs: number): Promise<Decided> {
  const facts: EmailFacts = { fromAddress: row.from_address, fromName: row.from_name, subject: row.subject, text: row.text_body ?? "", headers: row.headers ?? {}, auth: row.auth };
  const ctx = await classifyContext(admin, company, row, inbox);
  const result = classifyByRules(facts, ctx);
  const checked = (d: Decided): Decided => (!result.verified && (d.category === "customer" || (d.category === "other" && !d.detail.reason)) ? unverifiedCustomer(d) : d);
  if (result.rule) {
    return checked({
      category: result.rule.category,
      by: "rules",
      detail: result.rule.detail,
      // No model summary for a known customer: their first question / line, not the subject.
      summary: result.rule.category === "customer" ? firstAsk(row.text_body) : null,
      supplierId: result.rule.supplierId ?? null,
      purchaseOrderId: result.rule.purchaseOrderId ?? null,
      code: result.rule.code ?? null,
    });
  }
  const { data: co } = await (admin as Db).from("companies").select("industry_pack").eq("id", company.companyId).maybeSingle();
  const model = await classifyEmail(
    {
      organizationId: company.organizationId,
      companyId: company.companyId,
      businessName: company.name,
      trade: tradeOf((co as { industry_pack?: unknown } | null)?.industry_pack ?? null),
      fromName: row.from_name,
      fromAddress: row.from_address,
      subject: row.subject,
      text: row.text_body ?? "",
      today: localDateOf(nowMs, company.timeZone),
      noReply: result.noReply,
    },
    emailClerkDeps().model,
  );
  if (model) {
    return checked({
      category: model.category,
      by: "model",
      detail: { from_business: model.fromBusiness, amount_cents: model.amountCents, due_on: model.dueOn, project: model.project, po_number: result.po?.po_number ?? null },
      summary: model.summary,
      supplierId: null,
      purchaseOrderId: result.po?.id ?? null,
      code: null,
    });
  }
  const fallback = fallbackCategory(facts, result.noReply);
  return checked({ category: fallback, by: "fallback", detail: {}, summary: fallback === "customer" ? firstAsk(row.text_body) : null, supplierId: null, purchaseOrderId: result.po?.id ?? null, code: null });
}

/** Keep the email's files (allowlisted types, ≤ 10 MB, not inline pictures, ≤ 10). Never throws. */
export async function storeAttachments(admin: AdminClient, company: EmailClerkCompany, row: InboundEmailRow): Promise<number> {
  const db = admin as Db;
  let stored = 0;
  const deps = emailClerkDeps();
  for (const meta of (row.attachments_meta ?? []).filter((a) => !a.inline).slice(0, MAX_ATTACHMENTS)) {
    try {
      const { data: existing } = await db.from("email_attachments").select("id").eq("inbound_email_id", row.id).eq("provider_attachment_id", meta.id).maybeSingle();
      if (existing) continue;
      const base = { organization_id: company.organizationId, company_id: company.companyId, inbound_email_id: row.id, provider_attachment_id: meta.id, filename: meta.filename, content_type: meta.content_type, size_bytes: meta.size };
      const type = normalizeAttachmentType(meta.content_type);
      if (!type) {
        await db.from("email_attachments").insert({ ...base, status: "skipped_type" });
        continue;
      }
      if (typeof meta.size === "number" && meta.size > MAX_ATTACHMENT_BYTES) {
        await db.from("email_attachments").insert({ ...base, status: "skipped_size" });
        continue;
      }
      const file = await deps.provider.fetchAttachment(row.provider_email_id, meta.id, MAX_ATTACHMENT_BYTES);
      if (!file) {
        await db.from("email_attachments").insert({ ...base, status: "skipped_size" });
        continue;
      }
      const path = attachmentPathFor(company.organizationId, company.companyId, row.id, type);
      if (!path) continue;
      await deps.storage(admin).upload(path, file.bytes, type);
      const { error } = await db.from("email_attachments").insert({ ...base, content_type: type, size_bytes: file.bytes.byteLength, storage_path: path, status: "stored" });
      if (error && (error as { code?: string }).code !== "23505") throw error;
      stored += 1;
    } catch (err) {
      console.error("[email-clerk] attachment failed:", err instanceof Error ? err.message : err);
    }
  }
  return stored;
}

async function bidTask(admin: AdminClient, company: EmailClerkCompany, row: InboundEmailRow): Promise<string | null> {
  if (row.task_id) return row.task_id;
  try {
    const d = row.detail ?? {};
    const gc = clean(d.from_business, 40) || clean(row.from_name, 40) || clean(row.from_address, 60);
    const task = await createTask(ctxFor(admin, company.organizationId), {
      companyId: company.companyId,
      title: `Bid: ${gc} - ${clean(d.project, 60) || clean(row.subject, 60) || "project"}`.slice(0, 200),
      description: `Bid invite emailed by ${clean(row.from_name, 60) || "?"} <${clean(row.from_address, 120)}>: "${clean(row.subject, 160)}". ${clean(row.ai_summary, 200)}`.slice(0, 1000),
      ...(d.due_on ? { dueAt: `${d.due_on}T12:00:00.000Z` } : {}),
      priority: "high",
    });
    // Two workers on one row (a lease ran out mid-pass): only one task is kept.
    const { data: linked } = await (admin as Db).from("inbound_emails").update({ task_id: task.id }).eq("id", row.id).is("task_id", null).select("id");
    if (((linked ?? []) as unknown[]).length === 0) {
      await (admin as Db).from("tasks").delete().eq("organization_id", company.organizationId).eq("id", task.id);
      const { data: current } = await (admin as Db).from("inbound_emails").select("task_id").eq("id", row.id).maybeSingle();
      return (current as { task_id: string | null } | null)?.task_id ?? null;
    }
    return task.id;
  } catch (err) {
    console.error("[email-clerk] bid task failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Mail that says nothing about whether forwarding works. */
const NOT_FORWARD_EVIDENCE: EmailCategory[] = ["forwarding_confirmation", "spam", "bounce", "no_reply", "auto_reply"];

/** "Code: 123456789" → "Code: [code]" (the confirmation code isn't kept). PURE. */
export function redactCode(text: string | null, code: string): string | null {
  return text == null ? null : text.split(code).join("[code]");
}

function addressesIn(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(/[\s,;]+/)
    .map((p) => normalizeAddress(p))
    .filter((a): a is string => Boolean(a));
}

/**
 * Did this email reach us through the owner's forwarding? With a recorded mailbox: it was addressed
 * to that mailbox (To / Cc, or the forwarding headers X-Forwarded-For / X-Forwarded-To /
 * X-Original-To / Delivered-To). Without one: it wasn't addressed to our inbox directly, and the
 * mailbox is read from those headers (never just the first To). PURE.
 */
export function forwardedVia(
  row: Pick<InboundEmailRow, "to_addresses" | "cc_addresses" | "headers">,
  inbox: Pick<EmailInboxRow, "address" | "forwarded_from">,
  ourDomain: string | null,
): { from: string | null } | null {
  const ours = (a: string) => a === inbox.address || Boolean(ourDomain && a.endsWith(`@${ourDomain}`));
  const recipients = [...(row.to_addresses ?? []), ...(row.cc_addresses ?? [])].map((a) => normalizeAddress(a)).filter((a): a is string => Boolean(a));
  const h = row.headers ?? {};
  const envelope = [h["x-forwarded-for"], h["x-forwarded-to"], h["x-original-to"], h["delivered-to"]].flatMap(addressesIn).filter((a) => !ours(a));
  const recorded = normalizeAddress(inbox.forwarded_from);
  if (recorded) return recipients.includes(recorded) || envelope.includes(recorded) ? { from: recorded } : null;
  if (recipients.some(ours)) return null;
  return { from: envelope[0] ?? null };
}

/** One claimed email, start to finish. Throws on a failure worth retrying. */
export async function processEmail(admin: AdminClient, company: EmailClerkCompany, claimed: InboundEmailRow, nowMs: number): Promise<InboundEmailRow> {
  const db = admin as Db;
  let row = claimed;
  // Headers are only null until the content was fetched (the webhook couldn't): fetch it now.
  if (row.headers == null) {
    if (!(await fetchContent(admin, row, { duringPass: true }))) throw new Error("content not fetched yet");
    const { data } = await db.from("inbound_emails").select("*").eq("id", row.id).maybeSingle();
    if (!data) throw new Error("email gone");
    row = { ...(data as InboundEmailRow), status: "processing" };
  }
  const inbox = await loadInboxById(admin, row.inbox_id);
  if (!inbox) throw new Error("inbox gone");

  if (!row.category) {
    const decided = await decide(admin, company, row, inbox, nowMs);
    const fields: Partial<InboundEmailRow> = {
      category: decided.category,
      classified_by: decided.by,
      detail: decided.detail,
      ai_summary: decided.summary,
      supplier_id: decided.supplierId,
      purchase_order_id: decided.purchaseOrderId,
      // The forwarding code is texted to the owner and kept nowhere.
      ...(decided.category === "forwarding_confirmation" && decided.code
        ? { text_body: redactCode(row.text_body, decided.code), subject: redactCode(row.subject, decided.code), html_excerpt: redactCode(row.html_excerpt, decided.code) }
        : {}),
    };
    await db.from("inbound_emails").update(fields).eq("id", row.id);
    row = { ...row, ...fields };
    if (decided.category === "forwarding_confirmation") {
      // The code goes to the owner and nowhere else (never stored).
      const asked = normalizeAddress(decided.detail.forwarded_from);
      const fwd = await textOwner(admin, company, forwardingText({ provider: decided.detail.provider ?? null, code: decided.code, address: inbox.address, forwardedFrom: asked }), nowMs, { anyHour: true });
      await db.from("inbound_emails").update({ owner_alert_status: fwd, owner_alerted_at: fwd === "sent" ? new Date(nowMs).toISOString() : null }).eq("id", row.id);
      // The mailbox that asked is the one that forwards here (Gmail names it).
      await db
        .from("email_inboxes")
        .update({ forwarding_requested_at: new Date(nowMs).toISOString(), ...(asked ? { forwarded_from: asked, forwarding_confirmed_at: null } : {}) })
        .eq("id", inbox.id);
      return { ...row, owner_alert_status: fwd };
    }
  }

  // Real mail that came through the owner's forwarding: forwarding works.
  if (!inbox.forwarding_confirmed_at && row.category && !NOT_FORWARD_EVIDENCE.includes(row.category)) {
    const via = forwardedVia(row, inbox, inboundDomain());
    if (via) {
      await db
        .from("email_inboxes")
        .update({ forwarding_confirmed_at: new Date(nowMs).toISOString(), ...(via.from && !inbox.forwarded_from ? { forwarded_from: via.from } : {}) })
        .eq("id", inbox.id)
        .is("forwarding_confirmed_at", null);
    }
  }

  switch (row.category) {
    case "customer":
      row = await handleCustomerEmail(admin, company, row, inbox, nowMs);
      break;
    case "bid_invite": {
      const taskId = await bidTask(admin, company, row);
      row = { ...row, task_id: taskId };
      row = { ...row, owner_alert_status: await alertForEmail(admin, company, row, nowMs) };
      break;
    }
    case "supplier":
      if (row.purchase_order_id) row = { ...row, owner_alert_status: await alertForEmail(admin, company, row, nowMs) };
      break;
    default:
      break;
  }
  if (row.category && KEEP_FILES.includes(row.category)) await storeAttachments(admin, company, row);
  return row;
}

/** The sweep. Returns how many emails were finished / failed this pass. */
export async function sweepInbound(admin: AdminClient, nowMs: number): Promise<{ done: number; failed: number }> {
  if (!inboundConfigured()) return { done: 0, failed: 0 };
  const db = admin as Db;
  // Only what can be claimed now, filtered in SQL, so rows that keep failing never crowd out new mail.
  const nowIso = new Date(nowMs).toISOString();
  const page = (q: Db) => q.order("created_at", { ascending: true }).limit(BATCH);
  const reads = await Promise.all([
    page(db.from("inbound_emails").select("*").in("status", ["new", "received"]).lt("attempts", MAX_ATTEMPTS)),
    page(db.from("inbound_emails").select("*").eq("status", "failed").lt("attempts", MAX_ATTEMPTS).lt("updated_at", new Date(nowMs - RETRY_AFTER_MS).toISOString())),
    page(db.from("inbound_emails").select("*").eq("status", "processing").lt("locked_until", nowIso)),
  ]);
  const seenIds = new Set<string>();
  const found: InboundEmailRow[] = [];
  for (const { data, error } of reads as Array<{ data: unknown; error: unknown }>) {
    if (error) throw error;
    for (const r of (data ?? []) as InboundEmailRow[]) {
      if (seenIds.has(r.id)) continue;
      seenIds.add(r.id);
      found.push(r);
    }
  }
  const due = found.sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, BATCH);
  const companies = new Map<string, EmailClerkCompany | null>();
  let done = 0;
  let failed = 0;
  for (const row of due) {
    if (!companies.has(row.company_id)) companies.set(row.company_id, await loadEmailClerkCompany(admin, row.organization_id, row.company_id).catch(() => null));
    const company = companies.get(row.company_id) ?? null;
    const claimed = await claim(admin, row);
    if (!claimed) continue;
    if (!emailClerkOn(company)) {
      await finish(admin, row.id, "ignored", nowMs, "Email inbox is off for this business");
      continue;
    }
    try {
      await processEmail(admin, company, claimed, nowMs);
      await finish(admin, row.id, "done", nowMs);
      done += 1;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error("[email-clerk] processing failed", row.id, reason);
      // The last try failed → dead (kept for the record, never picked up again).
      await finish(admin, row.id, claimed.attempts >= MAX_ATTEMPTS ? "dead" : "failed", nowMs, reason);
      failed += 1;
    }
  }
  // Alerts held overnight, for every company that has any.
  const { data: held } = await db.from("inbound_emails").select("organization_id, company_id").eq("owner_alert_status", "held").limit(500);
  const seen = new Set<string>();
  for (const h of (held ?? []) as Array<{ organization_id: string; company_id: string }>) {
    if (seen.has(h.company_id)) continue;
    seen.add(h.company_id);
    try {
      const company = companies.get(h.company_id) ?? (await loadEmailClerkCompany(admin, h.organization_id, h.company_id));
      if (emailClerkOn(company)) await flushHeldAlerts(admin, company, nowMs);
    } catch (err) {
      console.error("[email-clerk] held alerts failed", h.company_id, err instanceof Error ? err.message : err);
    }
  }
  return { done, failed };
}
