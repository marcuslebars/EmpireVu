/**
 * Asking a sub for new paperwork (docs/ai-staff.md → "Compliance"):
 *
 *   1. proposeSubDocsRequest: the expiry chase (a sub's document 7 days out, or expired) or the
 *      owner ("ask Mike's Electric for a new clearance") → a `request_sub_docs` approval showing
 *      the exact text the sub would get. One open ask per sub.
 *   2. Y (executeRequestSubDocs): a compliance_upload_requests row (unique approval_id = the
 *      claim) with a fresh token, good for 14 days, then the text from the company's own number
 *      (or an email when the sub has no cell or opted out). Outside 09:00–20:00 local it's queued
 *      for the outbox sweep.
 *   3. The sub opens /compliance/upload/:token, uploads a photo or PDF; the server reads it, files
 *      it under that sub (replacing the old one) and the owner is texted "Mike's Electric sent a
 *      new WSIB clearance (expires Jan 9)" (owner hours 08:00–21:00; otherwise the outbox sweep
 *      tells them in the morning).
 */
import { isDoneForYou } from "@/lib/product-line";
import { randomBytes } from "node:crypto";

import type { AdminClient, ApprovalDecision, ExecuteResult, OwnerApprovalRow } from "@/server/services/front-desk/contracts";
import { isQuietHours, sendOwnerSms } from "@/server/services/owner-channel/common";
import { appBaseUrlFor } from "@/server/services/platform-brand";
import { ValidationError } from "@/server/organizations/context";
import { createComplianceApproval, pendingApproval, REQUEST_SUB_DOCS_KIND, UPLOAD_LINK_TTL_MS } from "./approvals";
import type { ComplianceDocumentRow, ComplianceKind, Db, SubcontractorRow, UploadRequestRow } from "./db-types";
import { complianceDeps } from "./deps";
import { fileDocument, findBySourceKey, loadDocument, logEvent, trackUpload } from "./documents";
import { firstName, forSub, subLabel } from "./holders";
import { capitalize, daysBetween, isComplianceKind, kindLabel, namesMatch, prettyDate, SUB_CORE_KINDS, statusFor, whenText } from "./kinds";
import { companySmsNumber, phoneOptedOut, sendEmailTo, sendText } from "./outbound";
import { loadComplianceCompany, type ComplianceCompany } from "./settings";
import { DOC_TYPES, isCompanyDocPath, subUploadPathFor } from "./storage";
import { inSendWindow, localDate, nextWindowLabel, nextWindowStart } from "./time";

export const MAX_UPLOADS_PER_LINK = 10;
const LINK_PLACEHOLDER = "[upload link]";

export function newLinkToken(): string {
  return randomBytes(24).toString("base64url");
}

export function isLinkToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,64}$/.test(value);
}

export function uploadLinkFor(platformBrand: string | null, token: string): string {
  return `${appBaseUrlFor(isDoneForYou(platformBrand) ? "crankleads" : "empirevu")}/compliance/upload/${token}`;
}

export async function loadSub(admin: AdminClient, scope: { organizationId: string; companyId: string }, id: string): Promise<SubcontractorRow | null> {
  const { data, error } = await (admin as Db).from("subcontractors").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as SubcontractorRow | null) ?? null;
}

/** "a new WSIB clearance + insurance" style list of what's asked. PURE. */
export function kindsPhrase(kinds: ComplianceKind[], short = false): string {
  const names = kinds.map((k) => (short ? shortKind(k) : kindLabel(k)));
  if (names.length <= 1) return names[0] ?? "documents";
  return short ? names.join(" + ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function shortKind(kind: ComplianceKind): string {
  if (kind === "wsib_clearance") return "clearance";
  if (kind === "liability_insurance") return "insurance";
  return kindLabel(kind);
}

/** What to ask a sub for: the document that's running out, plus whichever core ones aren't good for 30+ days. PURE. */
export function kindsToRequest(trigger: ComplianceKind | null, subDocs: Array<Pick<ComplianceDocumentRow, "kind" | "status" | "expires_on">>, today: string): ComplianceKind[] {
  const out: ComplianceKind[] = trigger ? [trigger] : [];
  for (const kind of SUB_CORE_KINDS) {
    if (out.includes(kind)) continue;
    const good = subDocs.some((d) => d.kind === kind && d.status !== "replaced" && d.status !== "pending" && (!d.expires_on || daysBetween(today, d.expires_on) > 30));
    if (!good) out.push(kind);
  }
  return out.length ? out : [...SUB_CORE_KINDS];
}

/** The text the sub gets (the link is `link`, or a placeholder in the owner's preview). PURE. */
export function subRequestText(input: { businessName: string; sub: Pick<SubcontractorRow, "name" | "business_name">; kinds: ComplianceKind[]; trigger: Pick<ComplianceDocumentRow, "kind" | "title" | "expires_on"> | null; today: string; link: string }): string {
  const hi = firstName(input.sub.name) || subLabel(input.sub);
  const ask = input.kinds.map((k, i) => (i === 0 && input.trigger?.kind === k ? `a new ${kindLabel(k)}` : `your ${kindLabel(k)}`));
  const list = ask.length <= 1 ? ask[0] : `${ask.slice(0, -1).join(", ")} and ${ask.at(-1)}`;
  let why = "";
  if (input.trigger?.expires_on) {
    const days = daysBetween(input.today, input.trigger.expires_on);
    const label = kindLabel(input.trigger.kind, input.trigger.title);
    why = days < 0 ? ` Your ${label} on file with us expired ${prettyDate(input.trigger.expires_on, input.today)}.` : ` Your ${label} on file with us expires ${whenText(input.trigger.expires_on, input.today)}.`;
  }
  const asked = input.trigger ? list : list.replace(/^your /, "your current ");
  return `Hi ${hi}, it's ${input.businessName}.${why} Please upload ${asked} here: ${input.link} (the link works for 14 days). Thanks!`;
}

/** Why texting this sub won't work (null = it will). */
async function smsProblem(admin: AdminClient, company: ComplianceCompany, sub: SubcontractorRow): Promise<string | null> {
  if (!sub.phone_e164) return `I don't have a cell for ${subLabel(sub)}`;
  if (!(await companySmsNumber(admin, company))) return "your business has no texting number of its own yet";
  if (await phoneOptedOut(admin, company, sub.phone_e164)) return `${subLabel(sub)} has opted out of texts from you`;
  return null;
}

/** Text when we can (from the company's own number), else email; else an owner-facing reason. */
export async function pickChannel(admin: AdminClient, company: ComplianceCompany, sub: SubcontractorRow): Promise<{ channel: "sms" | "email" | null; problem: string | null }> {
  const sms = await smsProblem(admin, company, sub);
  if (!sms) return { channel: "sms", problem: null };
  if (sub.email) return { channel: "email", problem: null };
  return { channel: null, problem: `${sms[0].toUpperCase()}${sms.slice(1)} and there's no email for ${subLabel(sub)}, so I can't send them a link. Add their email (or cell) in Settings > AI front desk > Compliance.` };
}

export interface ProposeResult {
  ok: boolean;
  reason?: "sub_not_found" | "inactive" | "no_contact" | "no_channel" | "already_asked" | "link_open";
  /** Owner-facing why, for no_channel. */
  message?: string;
  approvalId?: string;
  shortCode?: number | null;
  summary?: string;
  channel?: "sms" | "email";
}

export async function proposeSubDocsRequest(
  admin: AdminClient,
  company: ComplianceCompany,
  subId: string,
  options: { documentId?: string | null; askedInlineTo?: string | null; nowMs: number },
): Promise<ProposeResult> {
  const sub = await loadSub(admin, company, subId);
  if (!sub) return { ok: false, reason: "sub_not_found" };
  if (!sub.active) return { ok: false, reason: "inactive" };
  if (!sub.phone_e164 && !sub.email) return { ok: false, reason: "no_contact" };
  const pending = await pendingApproval(admin, company.companyId, REQUEST_SUB_DOCS_KIND, "subcontractorId", sub.id);
  if (pending) return { ok: false, reason: "already_asked", approvalId: pending.id, shortCode: pending.short_code };
  // A link sent in the last 14 days that the sub hasn't used yet is still good.
  const { data: open, error: openErr } = await (admin as Db)
    .from("compliance_upload_requests")
    .select("id, status, expires_at, uploads")
    .eq("company_id", company.companyId)
    .eq("subcontractor_id", sub.id)
    .in("status", ["queued", "sending", "sent"])
    .gt("expires_at", new Date(options.nowMs).toISOString())
    .limit(5);
  if (openErr) throw openErr;
  if (((open ?? []) as Array<{ uploads: number }>).some((r) => r.uploads === 0) && !options.askedInlineTo) return { ok: false, reason: "link_open" };

  const today = localDate(options.nowMs, company.timeZone);
  const trigger = options.documentId ? await loadDocument(admin, company, options.documentId) : null;
  const { data: docs, error } = await (admin as Db)
    .from("compliance_documents")
    .select("kind, status, expires_on")
    .eq("company_id", company.companyId)
    .eq("subcontractor_id", sub.id)
    .limit(200);
  if (error) throw error;
  const kinds = kindsToRequest(trigger?.kind ?? null, (docs ?? []) as ComplianceDocumentRow[], today);
  const picked = await pickChannel(admin, company, sub);
  if (!picked.channel) return { ok: false, reason: "no_channel", message: picked.problem ?? undefined };
  const channel = picked.channel;
  const name = subLabel(sub);
  const who = firstName(sub.name) || name;
  const text = subRequestText({ businessName: company.name, sub, kinds, trigger, today, link: LINK_PLACEHOLDER });
  const headline = trigger?.expires_on
    ? `${name}'s ${kindLabel(trigger.kind, trigger.title)} ${daysBetween(today, trigger.expires_on) < 0 ? `expired ${prettyDate(trigger.expires_on, today)}` : `expires ${whenText(trigger.expires_on, today)}`}.`
    : `Ask ${name} for ${kindsPhrase(kinds)}?`;
  const how = channel === "sms" ? `texts ${who}` : `emails ${who} (${sub.email})`;
  const summary = `${headline} Y ${how} a link to upload a new ${kindsPhrase(kinds, true)}. They'd get: "${text}"`;
  const created = await createComplianceApproval(
    admin,
    {
      organizationId: company.organizationId,
      companyId: company.companyId,
      kind: REQUEST_SUB_DOCS_KIND,
      summary,
      payload: { subcontractorId: sub.id, documentId: trigger?.id ?? null, kinds, channel },
      askedInlineTo: options.askedInlineTo ?? null,
    },
    options.nowMs,
  );
  return { ok: true, approvalId: created.id, shortCode: created.shortCode, summary: created.summary, channel };
}

export async function executeRequestSubDocs(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision, nowMs: number = Date.now()): Promise<ExecuteResult> {
  const payload = approval.payload ?? {};
  const scope = { organizationId: approval.organization_id, companyId: approval.company_id };
  const company = await loadComplianceCompany(admin, scope);
  const sub = typeof payload.subcontractorId === "string" && company ? await loadSub(admin, scope, payload.subcontractorId) : null;
  const name = sub ? subLabel(sub) : "the sub";
  if (!decision.approved) {
    return decision.decidedVia === "expiry"
      ? { ok: true, message: `No answer on #${approval.short_code ?? ""}, so I didn't ask ${name} for new documents. Text me "ask ${name} for documents" any time.` }
      : { ok: true, message: `OK - I won't ask ${name}.` };
  }
  if (decision.ownerNote?.trim()) {
    return { ok: false, message: `Nothing sent: that one only goes out exactly as shown. Text me "ask ${name} for documents" to start again.` };
  }
  if (!company || !company.settings.enabled) return { ok: false, message: "Compliance is off for this business, so nothing was sent." };
  if (!sub || !sub.active) return { ok: false, message: `${name} isn't on your subs list any more, so nothing was sent.` };
  if (!sub.phone_e164 && !sub.email) return { ok: false, message: `I don't have a cell or email for ${name}. Add one in Settings > AI front desk > Compliance and ask again.` };

  // Claim: one upload request per approval.
  const { data: existing } = await (admin as Db).from("compliance_upload_requests").select("*").eq("approval_id", approval.id).maybeSingle();
  let row = existing as UploadRequestRow | null;
  if (!row) {
    const today = localDate(nowMs, company.timeZone);
    const kinds = (Array.isArray(payload.kinds) ? payload.kinds : []).filter(isComplianceKind);
    const trigger = typeof payload.documentId === "string" ? await loadDocument(admin, scope, payload.documentId) : null;
    const token = newLinkToken();
    // The channel the owner approved is locked: if it no longer works, say so — never switch.
    const channel: "sms" | "email" = payload.channel === "email" ? "email" : "sms";
    if (channel === "sms") {
      const problem = await smsProblem(admin, company, sub);
      if (problem) return { ok: false, message: `Nothing sent: I was going to text ${name}, but ${problem}. Text me "ask ${name} for documents" to try again.` };
    } else if (!sub.email) {
      return { ok: false, message: `Nothing sent: I was going to email ${name}, but there's no email for them any more. Text me "ask ${name} for documents" to try again.` };
    }
    const finalKinds = kinds.length ? kinds : [...SUB_CORE_KINDS];
    const body = subRequestText({ businessName: company.name, sub, kinds: finalKinds, trigger, today, link: uploadLinkFor(company.platformBrand, token) });
    const inWindow = inSendWindow(nowMs, company.timeZone);
    const { data, error } = await (admin as Db)
      .from("compliance_upload_requests")
      .insert({
        organization_id: company.organizationId,
        company_id: company.companyId,
        subcontractor_id: sub.id,
        document_id: trigger?.id ?? null,
        approval_id: approval.id,
        token,
        kinds: finalKinds,
        channel,
        status: "queued",
        body,
        uploads: 0,
        send_after: new Date(inWindow ? nowMs : nextWindowStart(nowMs, company.timeZone)).toISOString(),
        expires_at: new Date(nowMs + UPLOAD_LINK_TTL_MS).toISOString(),
      })
      .select("*")
      .single();
    if (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
      const { data: raced } = await (admin as Db).from("compliance_upload_requests").select("*").eq("approval_id", approval.id).maybeSingle();
      row = raced as UploadRequestRow | null;
    } else {
      row = data as UploadRequestRow;
    }
  }
  if (!row) return { ok: false, message: "Couldn't set that up - try again in a minute." };
  const who = firstName(sub.name) || name;
  const how = row.channel === "sms" ? "Texted" : "Emailed";
  if (row.status === "queued" && inSendWindow(nowMs, company.timeZone)) {
    const sent = await sendUploadRequest(admin, company, sub, row, nowMs);
    if (sent !== "sent") return { ok: false, message: `Couldn't ${row.channel === "sms" ? "text" : "email"} ${who} (${sent}). Check their ${row.channel === "sms" ? "cell" : "email"} in Settings > AI front desk > Compliance.` };
    return { ok: true, message: `${how} ${who} (${name}) a link to upload a new ${kindsPhrase(row.kinds, true)} (works 14 days). I'll tell you when they send it.` };
  }
  if (row.status === "queued") {
    return { ok: true, message: `It's late, so I'll ${row.channel === "sms" ? "text" : "email"} ${who} (${name}) the upload link at ${nextWindowLabel(nowMs, company.timeZone)}.` };
  }
  return { ok: true, message: `Already sent ${who} (${name}) the upload link.` };
}

/** Claim queued → sending, then send. Returns the final status. */
export async function sendUploadRequest(admin: AdminClient, company: ComplianceCompany, sub: SubcontractorRow, row: UploadRequestRow, nowMs: number): Promise<string> {
  const db = admin as Db;
  const { data: claimed, error } = await db.from("compliance_upload_requests").update({ status: "sending" }).eq("id", row.id).eq("status", "queued").select("id");
  if (error) throw error;
  if (((claimed ?? []) as unknown[]).length === 0) return "already";
  const body = row.body ?? "";
  let result: { status: string; reason?: string };
  if (row.channel === "sms" && sub.phone_e164) {
    result = await sendText(admin, company, { to: sub.phone_e164, body });
  } else if (sub.email) {
    result = await sendEmailTo(admin, company, {
      to: sub.email,
      subject: `${company.name}: please upload your ${kindsPhrase(row.kinds)}`,
      body,
      fromName: company.name,
      replyTo: company.ownerEmail,
    });
  } else {
    result = { status: "blocked", reason: "no_contact" };
  }
  const status = result.status === "sent" ? "sent" : result.status === "blocked" ? "blocked" : "failed";
  await db
    .from("compliance_upload_requests")
    .update({ status, sent_at: status === "sent" ? new Date(nowMs).toISOString() : null, last_error: status === "sent" ? null : result.reason ?? status })
    .eq("id", row.id);
  await logEvent(admin, { organizationId: company.organizationId, companyId: company.companyId, event: `upload_link_${status}`, requestId: row.id, actor: "system", detail: { channel: row.channel } });
  return status === "sent" ? "sent" : result.reason ?? status;
}

// ── The sub's page (/compliance/upload/:token) ───────────────────────────────────────

export interface UploadPageView {
  businessName: string;
  subName: string;
  asked: Array<{ kind: ComplianceKind; label: string }>;
  expiresAt: string;
  uploads: Array<{ label: string; expiresOn: string | null; at: string }>;
  canUpload: boolean;
}

async function requestForToken(admin: AdminClient, token: string, nowMs: number): Promise<{ row: UploadRequestRow; company: ComplianceCompany; sub: SubcontractorRow } | null> {
  if (!isLinkToken(token)) return null;
  const { data, error } = await (admin as Db).from("compliance_upload_requests").select("*").eq("token", token).maybeSingle();
  if (error) throw error;
  const row = data as UploadRequestRow | null;
  if (!row || row.status !== "sent" || Date.parse(row.expires_at) <= nowMs) return null;
  const company = await loadComplianceCompany(admin, { organizationId: row.organization_id, companyId: row.company_id });
  if (!company || !company.settings.enabled) return null;
  const sub = await loadSub(admin, company, row.subcontractor_id);
  if (!sub || !sub.active) return null;
  return { row, company, sub };
}

export async function getUploadPageView(admin: AdminClient, token: string, nowMs: number = Date.now()): Promise<UploadPageView | null> {
  const found = await requestForToken(admin, token, nowMs);
  if (!found) return null;
  const { row, company, sub } = found;
  const { data } = await (admin as Db)
    .from("compliance_documents")
    .select("kind, title, expires_on, created_at")
    .eq("company_id", company.companyId)
    .eq("upload_request_id", row.id)
    .order("created_at", { ascending: true })
    .limit(MAX_UPLOADS_PER_LINK);
  return {
    businessName: company.name,
    subName: subLabel(sub),
    asked: row.kinds.map((k) => ({ kind: k, label: capitalize(kindLabel(k)) })),
    expiresAt: row.expires_at,
    uploads: ((data ?? []) as Array<{ kind: ComplianceKind; title: string | null; expires_on: string | null; created_at: string }>).map((d) => ({
      label: capitalize(kindLabel(d.kind, d.title)),
      expiresOn: d.expires_on,
      at: d.created_at,
    })),
    canUpload: row.uploads < MAX_UPLOADS_PER_LINK,
  };
}

export async function createSubUploadUrl(admin: AdminClient, token: string, contentType: string, nowMs: number = Date.now()): Promise<{ path: string; token: string; bucket: string } | null> {
  const found = await requestForToken(admin, token, nowMs);
  if (!found) return null;
  if (found.row.uploads >= MAX_UPLOADS_PER_LINK) throw new ValidationError("That's the most this link takes. Reply to the text if you need to send more.");
  const path = subUploadPathFor(found.company.organizationId, found.company.companyId, found.row.id, contentType);
  if (!path) throw new ValidationError("Upload a photo (JPG, PNG, HEIC) or a PDF.");
  await trackUpload(admin, found.company, path, nowMs);
  const upload = await complianceDeps().storage(admin).createUploadUrl(path);
  return { ...upload, bucket: "compliance-docs" };
}

export interface SubmitResult {
  label: string;
  expiresOn: string | null;
  read: boolean;
}

export async function submitSubUpload(
  admin: AdminClient,
  token: string,
  input: { path: string; contentType: string; kind?: string | null },
  meta: { ip: string | null; userAgent: string | null },
  nowMs: number = Date.now(),
): Promise<{ result: SubmitResult; view: UploadPageView | null } | null> {
  const found = await requestForToken(admin, token, nowMs);
  if (!found) return null;
  const { row, company, sub } = found;
  if (!isCompanyDocPath(company.organizationId, company.companyId, input.path, row.id)) throw new ValidationError("Upload the file again.");
  const contentType = DOC_TYPES[input.contentType] ? input.contentType : null;
  if (!contentType) throw new ValidationError("Upload a photo (JPG, PNG, HEIC) or a PDF.");
  const deps = complianceDeps();
  const storage = deps.storage(admin);
  if (!(await storage.exists(input.path))) throw new ValidationError("The file didn't finish uploading - try again.");

  // The same file sent twice (a double tap, a retry): answer the same way, no second slot.
  const sourceKey = `upload:${input.path}`;
  const again = await findBySourceKey(admin, company.companyId, sourceKey);
  if (again) {
    const read = again.status !== "pending";
    return { result: { label: capitalize(kindLabel(again.kind, again.title)), expiresOn: again.expires_on, read }, view: await getUploadPageView(admin, token, nowMs) };
  }

  // Claim an upload slot (conditional on the count we read).
  const { data: slot, error: slotErr } = await (admin as Db)
    .from("compliance_upload_requests")
    .update({ uploads: row.uploads + 1, last_upload_at: new Date(nowMs).toISOString() })
    .eq("id", row.id)
    .eq("uploads", row.uploads)
    .select("id");
  if (slotErr) throw slotErr;
  if (((slot ?? []) as unknown[]).length === 0) throw new ValidationError("Something else was uploading at the same time - try again.");

  const today = localDate(nowMs, company.timeZone);
  const bytes = await storage.download(input.path);
  const reading = bytes ? await deps.read({ bytes, contentType, today, scope: company }) : null;
  const hinted = isComplianceKind(input.kind) && (row.kinds.includes(input.kind) || input.kind === "other") ? input.kind : null;
  // Only a reading that says "this is a compliance document" is filed under the sub. Anything else
  // (a selfie, a blank page, no model) waits as `pending` with the sub noted: it replaces nothing,
  // the chase keeps running on what's on file, and the owner is asked to look.
  const verified = Boolean(reading?.isComplianceDocument);
  const kind: ComplianceKind = verified && reading?.kind && reading.kind !== "other" ? reading.kind : hinted ?? row.kinds[0] ?? "other";
  const filed = await fileDocument(admin, {
    organizationId: company.organizationId,
    companyId: company.companyId,
    kind,
    title: reading?.title ?? null,
    holder: verified ? forSub(sub) : null,
    pendingSubId: verified ? null : sub.id,
    coverStagesAtSave: false,
    holderName: reading?.holderName ?? null,
    issuer: reading?.issuer ?? null,
    number: reading?.number ?? null,
    issuedOn: reading?.issuedOn ?? null,
    expiresOn: reading?.expiresOn ?? null,
    filePath: input.path,
    fileContentType: contentType,
    uploadedVia: "sub_link",
    uploadedBy: `sub:${sub.id}`,
    sourceKey,
    uploadRequestId: row.id,
    aiRead: reading ? { ...reading } : null,
    today,
    nowMs,
  });
  await logEvent(admin, {
    organizationId: company.organizationId,
    companyId: company.companyId,
    event: "sub_upload",
    documentId: filed.doc.id,
    requestId: row.id,
    actor: `sub:${sub.id}`,
    ip: meta.ip,
    userAgent: meta.userAgent,
    detail: { kind, read: Boolean(reading?.isComplianceDocument) },
  });
  if (!filed.duplicate) await notifyOwnerOfSubUpload(admin, company, filed.doc, sub, nowMs);
  return {
    result: { label: capitalize(kindLabel(kind, filed.doc.title)), expiresOn: filed.doc.expires_on, read: verified },
    view: await getUploadPageView(admin, token, nowMs),
  };
}

/**
 * "Mike's Electric sent a new WSIB clearance (expires Jan 9)." `keptExpiresOn` is set (a date, or
 * "" for none) when it did NOT replace the live one on file (not shown to be newer). PURE.
 */
export function subUploadOwnerLine(
  doc: Pick<ComplianceDocumentRow, "kind" | "title" | "expires_on" | "holder_name" | "status">,
  sub: Pick<SubcontractorRow, "name" | "business_name">,
  today: string,
  keptExpiresOn?: string | null,
): string {
  const name = subLabel(sub);
  const label = kindLabel(doc.kind, doc.title);
  if (doc.status === "pending") {
    return `${name} sent a file for their ${label}, but I couldn't read it as a certificate, so I haven't filed it and what's on file stays as is. Have a look in Settings > AI front desk > Compliance, or text me "it's ${name}'s ${label}, expires" and the date to file it.`;
  }
  let line = `${name} sent a new ${label}`;
  if (doc.expires_on) {
    const status = statusFor(doc.expires_on, today);
    line += status === "expired" ? ` - but it expired ${prettyDate(doc.expires_on, today)}` : ` (expires ${prettyDate(doc.expires_on, today)})`;
  } else {
    line += " (no expiry date on it)";
  }
  line += ".";
  if (keptExpiresOn !== undefined && keptExpiresOn !== null) {
    line += ` It isn't newer than the one on file${keptExpiresOn ? ` (expires ${prettyDate(keptExpiresOn, today)})` : ""}, so that one stays current.`;
  }
  if (doc.holder_name && !namesMatch(doc.holder_name, sub.business_name) && !namesMatch(doc.holder_name, sub.name)) {
    line += ` The name on it is "${doc.holder_name}" - check it's theirs.`;
  }
  return line;
}

/** The live one of the same kind this sub upload didn't replace, if any ("" = it has no date). */
async function keptFor(admin: AdminClient, doc: ComplianceDocumentRow): Promise<string | null | undefined> {
  if (doc.status === "pending" || !doc.subcontractor_id) return undefined;
  const { data } = await (admin as Db).from("compliance_documents").select("id").eq("company_id", doc.company_id).eq("replaced_by", doc.id).limit(1);
  if (((data ?? []) as unknown[]).length) return undefined;
  const { data: live } = await (admin as Db)
    .from("compliance_documents")
    .select("id, expires_on, title")
    .eq("company_id", doc.company_id)
    .eq("subcontractor_id", doc.subcontractor_id)
    .eq("kind", doc.kind)
    .in("status", ["current", "expiring"])
    .limit(20);
  const other = ((live ?? []) as Array<{ id: string; expires_on: string | null }>).filter((d) => d.id !== doc.id)[0];
  return other ? other.expires_on ?? "" : undefined;
}

/** Tell the owner now (08:00–21:00 local), else leave owner_notified_at null for the outbox sweep. */
export async function notifyOwnerOfSubUpload(admin: AdminClient, company: ComplianceCompany, doc: ComplianceDocumentRow, sub: SubcontractorRow, nowMs: number): Promise<boolean> {
  if (!company.ownerPhone || !company.ownerPhoneVerified) return false;
  if (isQuietHours(nowMs, company.timeZone)) return false;
  const { data: claimed } = await (admin as Db).from("compliance_documents").update({ owner_notified_at: new Date(nowMs).toISOString() }).eq("id", doc.id).is("owner_notified_at", null).select("id");
  if (((claimed ?? []) as unknown[]).length === 0) return false;
  const sent = await sendOwnerSms(admin, {
    to: company.ownerPhone,
    body: subUploadOwnerLine(doc, sub, localDate(nowMs, company.timeZone), await keptFor(admin, doc)),
    organizationId: company.organizationId,
    companyId: company.companyId,
    platformBrand: company.platformBrand,
  });
  if (sent.status === "failed") {
    await (admin as Db).from("compliance_documents").update({ owner_notified_at: null }).eq("id", doc.id);
    return false;
  }
  return sent.status === "sent";
}
