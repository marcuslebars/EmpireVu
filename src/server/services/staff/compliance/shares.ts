/**
 * Sending a certificate to a customer or GC who asked for it ("send me your insurance").
 *
 *   1. The texting assistant's tool share_compliance_doc finds the business's own current document
 *      of that kind and asks the owner (`share_compliance_doc` approval, the exact text shown).
 *      It never sends anything itself and never says a document exists that isn't on file.
 *   2. Y (executeShareDoc): a compliance_shares row (unique approval_id = the claim) with a fresh
 *      token, good for 7 days, texted from the company's number (09:00–20:00 local, else queued).
 *   3. The link is our own route, /api/public/compliance/doc/:token: while the share is live it
 *      logs the open (IP, browser) and redirects to a 60-second signed URL for that one file.
 *      Revoked (Settings, owner tool stop_sharing), expired, or Compliance switched off → a plain
 *      "this link has expired" page. Every open and revoke is a compliance_events row.
 */
import { randomBytes } from "node:crypto";

import { prettyPhone } from "@/server/services/front-desk/approval-text";
import type { AdminClient, ApprovalDecision, ExecuteResult, OwnerApprovalRow } from "@/server/services/front-desk/contracts";
import { markOwnerTakeover } from "@/server/services/sms-agent/takeover";
import { appBaseUrlFor } from "@/server/services/platform-brand";
import { createComplianceApproval, pendingApproval, SHARE_DOC_KIND, SHARE_LINK_TTL_MS } from "./approvals";
import type { ComplianceDocumentRow, ComplianceKind, Db, ShareRow } from "./db-types";
import { complianceDeps } from "./deps";
import { loadDocument, logEvent } from "./documents";
import { firstName } from "./holders";
import { cleanText, kindLabel, prettyDate } from "./kinds";
import { sendText } from "./outbound";
import { isLinkToken, newLinkToken } from "./requests";
import { loadComplianceCompany, type ComplianceCompany } from "./settings";
import { inSendWindow, localDate, nextWindowLabel, nextWindowStart } from "./time";

const LINK_PLACEHOLDER = "[link]";
const OPEN_URL_TTL_SECONDS = 60;

export function shareLinkFor(platformBrand: string | null, token: string): string {
  return `${appBaseUrlFor(platformBrand === "crankleads" ? "crankleads" : "empirevu")}/api/public/compliance/doc/${token}`;
}

/** Kinds a customer may ask for, and what else counts ("WSIB" → a clearance, else the account letter). */
const FALLBACKS: Partial<Record<ComplianceKind, ComplianceKind[]>> = {
  wsib_clearance: ["wsib_account"],
  wsib_account: ["wsib_clearance"],
};

/** The business's own live document of a kind (newest expiry first), or null. */
export async function shareableDocument(admin: AdminClient, company: ComplianceCompany, kind: ComplianceKind, nowMs: number): Promise<ComplianceDocumentRow | null> {
  const today = localDate(nowMs, company.timeZone);
  for (const k of [kind, ...(FALLBACKS[kind] ?? [])]) {
    const { data, error } = await (admin as Db)
      .from("compliance_documents")
      .select("*")
      .eq("organization_id", company.organizationId)
      .eq("company_id", company.companyId)
      .eq("holder_type", "company")
      .eq("kind", k)
      .in("status", ["current", "expiring"])
      .limit(20);
    if (error) throw error;
    const live = ((data ?? []) as ComplianceDocumentRow[])
      .filter((d) => d.file_path && (!d.expires_on || d.expires_on >= today))
      .sort((a, b) => (b.expires_on ?? "9999").localeCompare(a.expires_on ?? "9999"));
    if (live[0]) return live[0];
  }
  return null;
}

/** "certificate" wording for the customer ("liability insurance certificate"). PURE. */
export function shareLabel(doc: Pick<ComplianceDocumentRow, "kind" | "title">): string {
  const label = kindLabel(doc.kind, doc.title);
  return doc.kind === "liability_insurance" || doc.kind === "vehicle_insurance" ? `${label} certificate` : label;
}

/** The text the customer gets. PURE. */
export function shareText(input: { businessName: string; customerFirst: string | null; doc: Pick<ComplianceDocumentRow, "kind" | "title" | "expires_on">; link: string; today: string }): string {
  const hi = input.customerFirst ? `Hi ${input.customerFirst}, it's ${input.businessName}.` : `Hi, it's ${input.businessName}.`;
  const valid = input.doc.expires_on ? ` (valid to ${prettyDate(input.doc.expires_on)})` : "";
  return `${hi} Here's our ${shareLabel(input.doc)}${valid}: ${input.link} The link works for 7 days.`;
}

export interface ShareAsk {
  organizationId: string;
  companyId: string;
  contactId: string;
  conversationId: string | null;
  customerName: string;
  customerFirst: string | null;
  customerPhone: string | null;
  customerText: string | null;
  kind: ComplianceKind;
  nowMs: number;
}

export interface ShareAskResult {
  ok: boolean;
  /** Set when ok. */
  approvalId?: string;
  shortCode?: number | null;
  reason?: "off" | "sharing_off" | "not_on_file" | "already_asked";
  label: string;
}

export async function proposeShare(admin: AdminClient, ask: ShareAsk): Promise<ShareAskResult> {
  const company = await loadComplianceCompany(admin, ask);
  const askedLabel = kindLabel(ask.kind);
  if (!company || !company.settings.enabled) return { ok: false, reason: "off", label: askedLabel };
  if (!company.settings.sharing) return { ok: false, reason: "sharing_off", label: askedLabel };
  const doc = await shareableDocument(admin, company, ask.kind, ask.nowMs);
  if (!doc) return { ok: false, reason: "not_on_file", label: askedLabel };
  const label = shareLabel(doc);
  const pending = await pendingApproval(admin, company.companyId, SHARE_DOC_KIND, "contactId", ask.contactId);
  if (pending) return { ok: false, reason: "already_asked", label };
  const today = localDate(ask.nowMs, company.timeZone);
  const text = shareText({ businessName: company.name, customerFirst: ask.customerFirst, doc, link: LINK_PLACEHOLDER, today });
  const who = ask.customerPhone ? `${ask.customerName} (${prettyPhone(ask.customerPhone)})` : ask.customerName;
  const extras = [doc.issuer, doc.expires_on ? `expires ${prettyDate(doc.expires_on)}` : null].filter(Boolean).join(", ");
  const core = `${who} asked for your ${label}${extras ? ` (${extras})` : ""}. Y texts ${ask.customerFirst ?? "them"} a link to it (expires in 7 days): "${text}"`;
  const room = 480 - core.length;
  const theirs = ask.customerText ? cleanText(ask.customerText, Math.min(140, room - 16)) : null;
  const summary = theirs && room > 40 ? `${core} Their text: "${theirs}"` : core;
  const created = await createComplianceApproval(
    admin,
    {
      organizationId: company.organizationId,
      companyId: company.companyId,
      contactId: ask.contactId,
      conversationId: ask.conversationId,
      kind: SHARE_DOC_KIND,
      summary,
      payload: { contactId: ask.contactId, documentId: doc.id, kind: doc.kind, customerName: ask.customerName, customerFirst: ask.customerFirst },
    },
    ask.nowMs,
  );
  return { ok: true, approvalId: created.id, shortCode: created.shortCode, label };
}

export async function executeShareDoc(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision, nowMs: number = Date.now()): Promise<ExecuteResult> {
  const payload = approval.payload ?? {};
  const scope = { organizationId: approval.organization_id, companyId: approval.company_id };
  const contactId = typeof payload.contactId === "string" ? payload.contactId : approval.contact_id;
  const customer = typeof payload.customerName === "string" ? payload.customerName : "the customer";
  const customerFirst = typeof payload.customerFirst === "string" && payload.customerFirst ? payload.customerFirst : null;
  const company = await loadComplianceCompany(admin, scope);
  const doc = typeof payload.documentId === "string" ? await loadDocument(admin, scope, payload.documentId) : null;
  const label = doc ? shareLabel(doc) : "document";

  if (!decision.approved) {
    if (contactId) await markOwnerTakeover(admin, { companyId: scope.companyId, contactId, at: new Date(nowMs) });
    if (decision.decidedVia !== "expiry" && contactId && company && inSendWindow(nowMs, company.timeZone)) {
      const phone = await contactPhone(admin, scope, contactId);
      if (phone) {
        const hi = customerFirst ? `Hi ${customerFirst}` : "Hi";
        await sendText(admin, scope, { to: phone, contactId, body: `${hi}, it's ${company.name}. We'll get back to you directly about the ${label}.` });
      }
    }
    return decision.decidedVia === "expiry"
      ? { ok: true, message: `No answer on #${approval.short_code ?? ""}, so nothing went to ${customer}. The conversation is yours now.` }
      : { ok: true, message: `OK - nothing sent. ${customer} is yours to answer now.` };
  }
  if (decision.ownerNote?.trim()) return { ok: false, message: `Nothing sent: that one only goes out exactly as shown.` };
  if (!company || !company.settings.enabled) return { ok: false, message: "Compliance is off for this business, so nothing was sent." };
  if (!contactId) return { ok: false, message: "I couldn't tell who to send it to, so nothing was sent." };
  if (!doc || doc.status === "replaced" || !doc.file_path) {
    return { ok: false, message: `That ${label} isn't on file any more, so nothing went to ${customer}. Send me the current one and ask again.` };
  }
  const today = localDate(nowMs, company.timeZone);
  if (doc.expires_on && doc.expires_on < today) return { ok: false, message: `Your ${label} expired ${prettyDate(doc.expires_on)}, so nothing went to ${customer}. Text me a photo of the new one.` };
  const phone = await contactPhone(admin, scope, contactId);
  if (!phone) return { ok: false, message: `${customer} has no cell on file, so nothing was sent.` };

  const { data: existing } = await (admin as Db).from("compliance_shares").select("*").eq("approval_id", approval.id).maybeSingle();
  let row = existing as ShareRow | null;
  if (!row) {
    const token = newLinkToken();
    const body = shareText({ businessName: company.name, customerFirst, doc, link: shareLinkFor(company.platformBrand, token), today });
    const inWindow = inSendWindow(nowMs, company.timeZone);
    const { data, error } = await (admin as Db)
      .from("compliance_shares")
      .insert({
        organization_id: company.organizationId,
        company_id: company.companyId,
        document_id: doc.id,
        contact_id: contactId,
        approval_id: approval.id,
        token,
        status: "queued",
        body,
        open_count: 0,
        send_after: new Date(inWindow ? nowMs : nextWindowStart(nowMs, company.timeZone)).toISOString(),
        expires_at: new Date(nowMs + SHARE_LINK_TTL_MS).toISOString(),
      })
      .select("*")
      .single();
    if (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
      const { data: raced } = await (admin as Db).from("compliance_shares").select("*").eq("approval_id", approval.id).maybeSingle();
      row = raced as ShareRow | null;
    } else {
      row = data as ShareRow;
    }
  }
  if (!row) return { ok: false, message: "Couldn't set that up - try again in a minute." };
  if (row.status === "queued" && inSendWindow(nowMs, company.timeZone)) {
    const status = await sendShare(admin, company, row, nowMs);
    if (status !== "sent") return { ok: false, message: `Couldn't text ${customer} (${status}).` };
    return { ok: true, message: `Texted ${customer} the link to your ${label} (works 7 days). You can turn it off in Settings > AI front desk > Compliance.` };
  }
  if (row.status === "queued") return { ok: true, message: `It's late, so I'll text ${customer} the link to your ${label} at ${nextWindowLabel(nowMs, company.timeZone)}.` };
  return { ok: true, message: `Already sent ${customer} the link.` };
}

async function contactPhone(admin: AdminClient, scope: { organizationId: string; companyId: string }, contactId: string): Promise<string | null> {
  const { data } = await (admin as Db).from("contacts").select("phone").eq("organization_id", scope.organizationId).eq("id", contactId).maybeSingle();
  return ((data as { phone: string | null } | null)?.phone ?? null) || null;
}

/** Claim queued → sending, then text. Returns "sent" or why not. */
export async function sendShare(admin: AdminClient, company: ComplianceCompany, row: ShareRow, nowMs: number): Promise<string> {
  const db = admin as Db;
  const { data: claimed, error } = await db.from("compliance_shares").update({ status: "sending" }).eq("id", row.id).eq("status", "queued").select("id");
  if (error) throw error;
  if (((claimed ?? []) as unknown[]).length === 0) return "already";
  const phone = row.contact_id ? await contactPhone(admin, company, row.contact_id) : null;
  const result = phone ? await sendText(admin, company, { to: phone, body: row.body ?? "", contactId: row.contact_id }) : { status: "blocked", reason: "no_phone" };
  const status = result.status === "sent" ? "sent" : result.status === "blocked" ? "blocked" : "failed";
  await db
    .from("compliance_shares")
    .update({ status, sent_at: status === "sent" ? new Date(nowMs).toISOString() : null, last_error: status === "sent" ? null : result.reason ?? status })
    .eq("id", row.id);
  await logEvent(admin, { organizationId: company.organizationId, companyId: company.companyId, event: `share_${status}`, shareId: row.id, documentId: row.document_id, actor: "system" });
  return status === "sent" ? "sent" : result.reason ?? status;
}

// ── The link ─────────────────────────────────────────────────────────────────────────

export interface OpenResult {
  ok: boolean;
  /** Set when ok: where to send the visitor. */
  url?: string;
  status?: 404 | 410;
  businessName?: string | null;
}

export async function openShare(admin: AdminClient, token: string, meta: { ip: string | null; userAgent: string | null }, nowMs: number = Date.now()): Promise<OpenResult> {
  if (!isLinkToken(token)) return { ok: false, status: 404, businessName: null };
  const db = admin as Db;
  const { data, error } = await db.from("compliance_shares").select("*").eq("token", token).maybeSingle();
  if (error) throw error;
  const row = data as ShareRow | null;
  if (!row) return { ok: false, status: 404, businessName: null };
  const company = await loadComplianceCompany(admin, { organizationId: row.organization_id, companyId: row.company_id });
  const gone = (reason: string): OpenResult => {
    void logEvent(admin, { organizationId: row.organization_id, companyId: row.company_id, event: "share_open_refused", shareId: row.id, documentId: row.document_id, actor: "visitor", ip: meta.ip, userAgent: meta.userAgent, detail: { reason } });
    return { ok: false, status: 410, businessName: company?.name ?? null };
  };
  if (row.status !== "sent") return gone(row.status);
  if (Date.parse(row.expires_at) <= nowMs) return gone("expired");
  if (!company || !company.settings.enabled || !company.settings.sharing) return gone("off");
  const doc = await loadDocument(admin, company, row.document_id);
  if (!doc?.file_path) return gone("no_file");
  const name = `${company.name} - ${shareLabel(doc)}`.replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 80) + extFor(doc.file_content_type);
  const url = await complianceDeps().storage(admin).signedUrl(doc.file_path, OPEN_URL_TTL_SECONDS, name);
  if (!url) return gone("storage");
  await db.from("compliance_shares").update({ open_count: (row.open_count ?? 0) + 1, last_opened_at: new Date(nowMs).toISOString() }).eq("id", row.id);
  await logEvent(admin, { organizationId: row.organization_id, companyId: row.company_id, event: "share_opened", shareId: row.id, documentId: row.document_id, actor: "visitor", ip: meta.ip, userAgent: meta.userAgent });
  return { ok: true, url };
}

function extFor(contentType: string | null): string {
  if (contentType === "application/pdf") return ".pdf";
  if (contentType === "image/png") return ".png";
  if (contentType === "image/webp") return ".webp";
  return ".jpg";
}

/** Turn links off: one share, a customer's, or every live one. Returns how many. */
export async function revokeShares(
  admin: AdminClient,
  scope: { organizationId: string; companyId: string },
  which: { shareId?: string | null; contactId?: string | null },
  by: string,
  nowMs: number,
): Promise<number> {
  const db = admin as Db;
  let query = db
    .from("compliance_shares")
    .update({ status: "revoked", revoked_at: new Date(nowMs).toISOString(), revoked_by: by })
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .in("status", ["queued", "sending", "sent"])
    .gt("expires_at", new Date(nowMs).toISOString());
  if (which.shareId) query = query.eq("id", which.shareId);
  if (which.contactId) query = query.eq("contact_id", which.contactId);
  const { data, error } = await query.select("id, document_id");
  if (error) throw error;
  const rows = (data ?? []) as Array<{ id: string; document_id: string }>;
  for (const r of rows) await logEvent(admin, { organizationId: scope.organizationId, companyId: scope.companyId, event: "share_revoked", shareId: r.id, documentId: r.document_id, actor: by });
  return rows.length;
}

/** First name for a customer, unless the "name" is really a phone number. PURE. */
export function customerFirstName(first: string | null | undefined): string | null {
  const f = firstName(first);
  return f && !/^\+?\d/.test(f) ? f : null;
}
