/**
 * A customer's email (docs/ai-staff.md → "Email inbox"):
 *
 *   1. the contact: matched by email inside this company, else created (consent_source
 *      'inbound_email', implied inquiry consent from now — they wrote to us);
 *   2. message_log: one inbound row (channel 'email'), so it shows in the app inbox and the
 *      conversation thread like any text;
 *   3. inquiry consent stamped on an existing contact, the way a customer's own text does
 *      (twilio/inbound-sms.ts recordInquiryConsent) — never over an email opt-out or express consent;
 *   4. a drafted reply → the owner's `email_reply` approval (always, in v1), or — no model, drafts
 *      off, or they unsubscribed from email — a plain "Email from Dana…" text.
 *
 * Every step is idempotent for a retried pass (the row remembers what's done).
 */
import { insertApproval } from "@/server/services/front-desk/approvals";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Tables } from "@/server/db/database.types";
import { createContact } from "@/server/services/contacts";
import { ctxFor, shortWhen } from "@/server/services/owner-channel/common";
import { loadBusinessFacts } from "@/server/services/sms-agent/facts";
import { emitActivityEventAndDispatch } from "@/server/services/workflow-engine/dispatch";
import { EXPRESS_CONSENT_SOURCES } from "@/server/services/workflow-engine/messaging";
import { draftReply } from "./ai";
import { asksToStop } from "./classify";
import { alertForEmail, fullDraftLink } from "./alerts";
import type { Db, EmailInboxRow, InboundEmailRow } from "./db-types";
import { emailClerkDeps } from "./deps";
import { askOf, EMAIL_REPLY_KIND, replySummary, senderLabel } from "./format";
import { clean, firstNameOf, newText, normalizeAddress, replySubject } from "./parse";
import type { EmailClerkCompany } from "./settings";
import { localDateOf } from "./time";

export const INBOUND_EMAIL_CONSENT_SOURCE = "inbound_email";
export const REPLY_TTL_MS = 48 * 3_600_000;
const MESSAGE_LOG_BODY_CHARS = 5_000;

type Contact = Tables<"contacts">;

/** The company's contact with this email (case-insensitive), oldest first. */
export async function findContactByEmail(admin: AdminClient, scope: { organizationId: string; companyId: string }, address: string): Promise<Contact | null> {
  const email = normalizeAddress(address);
  if (!email) return null;
  const db = admin as Db;
  let q = db.from("contacts").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId);
  // ilike for stored mixed case ("Dana@Example.com"); `_` is a one-character wildcard there, so the
  // exact match is checked below. An address with `%` is only matched exactly.
  q = email.includes("%") ? q.eq("email", email) : q.ilike("email", email);
  const { data, error } = await q.order("created_at", { ascending: true }).limit(10);
  if (error) throw error;
  return ((data ?? []) as Contact[]).find((c) => normalizeAddress(c.email) === email) ?? null;
}

function namesFrom(row: Pick<InboundEmailRow, "from_name" | "from_address">): { first: string; last: string | null } {
  const name = clean(row.from_name, 80);
  if (name && !/@/.test(name)) {
    const parts = name.split(/\s+/).filter(Boolean);
    return { first: parts[0].slice(0, 60), last: parts.length > 1 ? parts.slice(1).join(" ").slice(0, 80) : null };
  }
  const local = (normalizeAddress(row.from_address) ?? "customer").split("@")[0].replace(/[._-]+/g, " ").trim();
  return { first: local.slice(0, 60) || "Customer", last: null };
}

/** An email from a customer is an inquiry: implied consent from now (keeps the source). */
export async function recordEmailInquiryConsent(admin: AdminClient, organizationId: string, contact: Contact, nowMs: number): Promise<void> {
  if (contact.email_opt_out_at) return;
  if (contact.consent_source && EXPRESS_CONSENT_SOURCES.has(contact.consent_source)) return;
  const now = new Date(nowMs).toISOString();
  const consentSource = contact.consent_source ?? INBOUND_EMAIL_CONSENT_SOURCE;
  const update = (admin as Db)
    .from("contacts")
    .update({ sms_consent_at: now, consent_source: consentSource })
    .eq("organization_id", organizationId)
    .eq("id", contact.id)
    .is("email_opt_out_at", null);
  // Only if the source is still what we read (a concurrent opt-in to express is never undone).
  const { error } = await (contact.consent_source ? update.eq("consent_source", contact.consent_source) : update.is("consent_source", null));
  if (error) {
    console.error("[email-clerk] recording inquiry consent failed:", error.message);
    return;
  }
  contact.sms_consent_at = now;
  contact.consent_source = consentSource;
}

async function contactFor(admin: AdminClient, company: EmailClerkCompany, row: InboundEmailRow, nowMs: number, optOut: boolean): Promise<Contact> {
  const db = admin as Db;
  if (row.contact_id) {
    const { data } = await db.from("contacts").select("*").eq("organization_id", company.organizationId).eq("id", row.contact_id).maybeSingle();
    if (data) return data as Contact;
  }
  const found = await findContactByEmail(admin, company, row.from_address ?? "");
  if (found) {
    // "Unsubscribe" is never an inquiry: no consent stamped.
    if (!optOut) await recordEmailInquiryConsent(admin, company.organizationId, found, nowMs);
    return found;
  }
  const names = namesFrom(row);
  if (optOut) {
    return createContact(
      ctxFor(admin, company.organizationId),
      { companyId: company.companyId, firstName: names.first, lastName: names.last, email: normalizeAddress(row.from_address) },
      { dispatchWorkflow: false },
    );
  }
  return createContact(
    ctxFor(admin, company.organizationId),
    {
      companyId: company.companyId,
      firstName: names.first,
      lastName: names.last,
      email: normalizeAddress(row.from_address),
      consentSource: INBOUND_EMAIL_CONSENT_SOURCE,
      smsConsentAt: new Date(nowMs).toISOString(),
    },
    { dispatchWorkflow: false },
  );
}

/** The inbound message_log row (once — a retried pass finds it by the provider id). */
async function logInbound(admin: AdminClient, company: EmailClerkCompany, row: InboundEmailRow, inbox: EmailInboxRow, contact: Contact): Promise<string> {
  const db = admin as Db;
  const { data: existing } = await db
    .from("message_log")
    .select("id")
    .eq("organization_id", company.organizationId)
    .eq("channel", "email")
    .eq("direction", "inbound")
    .eq("provider_ref", row.provider_email_id)
    .limit(1);
  const found = ((existing ?? []) as Array<{ id: string }>)[0];
  if (found) return found.id;
  const body = (newText(row.text_body) || row.text_body || "").slice(0, MESSAGE_LOG_BODY_CHARS);
  const { data, error } = await db
    .from("message_log")
    .insert({
      organization_id: company.organizationId,
      company_id: company.companyId,
      contact_id: contact.id,
      channel: "email",
      direction: "inbound",
      from_addr: row.from_address,
      to_addr: inbox.address,
      subject: row.subject,
      provider: row.provider,
      provider_ref: row.provider_email_id,
      status: "received",
      body: body || "(no text)",
    })
    .select("id")
    .single();
  if (error) throw error;
  try {
    await emitActivityEventAndDispatch(
      ctxFor(admin, company.organizationId),
      { companyId: company.companyId, entityType: "contact", entityId: contact.id, eventType: "contact.email_received", metadata: { from: row.from_address, subject: clean(row.subject, 140) } },
      { emitOnly: true },
    );
  } catch (err) {
    console.error("[email-clerk] activity event failed:", err instanceof Error ? err.message : err);
  }
  return (data as { id: string }).id;
}

async function upcomingBookings(admin: AdminClient, company: EmailClerkCompany, contactId: string, nowMs: number): Promise<Array<{ id: string; line: string }>> {
  const { data } = await (admin as Db)
    .from("bookings")
    .select("id, title, scheduled_for, status")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .eq("contact_id", contactId)
    .in("status", ["pending", "confirmed"])
    .gte("scheduled_for", new Date(nowMs).toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(3);
  return ((data ?? []) as Array<{ id: string; title: string | null; scheduled_for: string }>).map((b) => ({ id: b.id, line: `${shortWhen(b.scheduled_for, company.timeZone)} - ${clean(b.title, 80) || "job"}` }));
}

async function recentHistory(admin: AdminClient, company: EmailClerkCompany, contactId: string, excludeId: string | null): Promise<Array<{ at: string; who: "customer" | "business"; channel: string; body: string }>> {
  const { data } = await (admin as Db)
    .from("message_log")
    .select("id, created_at, direction, channel, body, status")
    .eq("organization_id", company.organizationId)
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(12);
  return ((data ?? []) as Array<{ id: string; created_at: string; direction: string; channel: string; body: string | null; status: string }>)
    .filter((m) => m.id !== excludeId && m.body && (m.direction === "inbound" || m.status === "sent"))
    .slice(0, 10)
    .reverse()
    .map((m) => ({ at: m.created_at ?? "", who: m.direction === "inbound" ? "customer" : "business", channel: m.channel, body: m.body ?? "" }));
}

/** Withdraw an older reply still waiting for this customer (the new draft answers both). */
async function supersedeOlder(admin: AdminClient, company: EmailClerkCompany, contactId: string, keepRowId: string): Promise<void> {
  const db = admin as Db;
  const { data } = await db
    .from("inbound_emails")
    .select("id, approval_id")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .eq("contact_id", contactId)
    .eq("reply_status", "awaiting_owner");
  for (const r of (data ?? []) as Array<{ id: string; approval_id: string | null }>) {
    if (r.id === keepRowId || !r.approval_id) continue;
    const { data: hit } = await db.from("owner_approvals").update({ status: "superseded" }).eq("id", r.approval_id).eq("status", "pending").select("id");
    if (((hit ?? []) as unknown[]).length) await db.from("inbound_emails").update({ reply_status: "superseded" }).eq("id", r.id).eq("reply_status", "awaiting_owner");
  }
}

/** The owner's question: inserted as notified-to-nobody, linked to the email, then opened + texted. */
async function askOwner(admin: AdminClient, company: EmailClerkCompany, row: InboundEmailRow, contact: Contact, draft: { body: string; replaced: boolean }, nowMs: number): Promise<string> {
  const db = admin as Db;
  const now = new Date(nowMs);
  const summary = replySummary({ sender: senderLabel(row), ask: askOf(row), draft: draft.body, link: fullDraftLink(company, row.id), replaced: draft.replaced });
  const approval = await insertApproval(admin, {
    organizationId: company.organizationId,
    companyId: company.companyId,
    contactId: contact.id,
    kind: EMAIL_REPLY_KIND,
    summary,
    payload: { inboundEmailId: row.id, contactId: contact.id },
    requestedBy: "email_clerk",
    createdAt: now,
    expiresAt: new Date(nowMs + REPLY_TTL_MS),
    notifiedAt: now,
    notifiedTo: null,
  });
  const { data: linked } = await db
    .from("inbound_emails")
    .update({ approval_id: approval.id, reply_status: "awaiting_owner", owner_alert_status: "approval" })
    .eq("id", row.id)
    .is("approval_id", null)
    .select("id");
  if (((linked ?? []) as unknown[]).length === 0) {
    await db.from("owner_approvals").update({ status: "superseded" }).eq("id", approval.id).eq("status", "pending");
    throw new Error("Could not link the reply to its approval.");
  }
  await db.from("owner_approvals").update({ notified_at: null, notified_to: null }).eq("id", approval.id).eq("status", "pending");
  try {
    await emailClerkDeps().notify(admin, approval.id, nowMs);
  } catch (err) {
    console.error("[email-clerk] notify failed:", err instanceof Error ? err.message : err);
  }
  return approval.id;
}

export async function handleCustomerEmail(admin: AdminClient, company: EmailClerkCompany, row: InboundEmailRow, inbox: EmailInboxRow, nowMs: number): Promise<InboundEmailRow> {
  const db = admin as Db;
  const optOut = asksToStop(newText(row.text_body) || row.subject);
  const contact = await contactFor(admin, company, row, nowMs, optOut);
  if (optOut && !contact.email_opt_out_at) {
    const at = new Date(nowMs).toISOString();
    await db.from("contacts").update({ email_opt_out_at: at }).eq("organization_id", company.organizationId).eq("id", contact.id).is("email_opt_out_at", null);
    contact.email_opt_out_at = at;
  }
  const messageLogId = row.message_log_id ?? (await logInbound(admin, company, row, inbox, contact));
  const bookings = await upcomingBookings(admin, company, contact.id, nowMs);
  const linkFields = { contact_id: contact.id, message_log_id: messageLogId, booking_id: row.booking_id ?? bookings[0]?.id ?? null };
  await db.from("inbound_emails").update(linkFields).eq("id", row.id);
  let current: InboundEmailRow = { ...row, ...linkFields };
  if (current.approval_id || current.reply_status !== "none") return current;

  const canDraft = company.settings.draftReplies && !contact.email_opt_out_at && Boolean(current.from_address);
  let draft: { body: string; replaced: boolean } | null = current.draft_reply ? { body: current.draft_reply, replaced: false } : null;
  if (canDraft && !draft) {
    const facts = await loadBusinessFacts(admin, company.companyId);
    const result = await draftReply(
      {
        facts,
        customerFirstName: firstNameOf(contact.first_name) ?? firstNameOf(current.from_name),
        subject: current.subject,
        text: newText(current.text_body) || current.text_body || "",
        history: await recentHistory(admin, company, contact.id, messageLogId),
        bookings: bookings.map((b) => b.line),
        today: localDateOf(nowMs, company.timeZone),
      },
      emailClerkDeps().model,
    );
    if (result) {
      draft = { body: result.body, replaced: result.replaced.length > 0 };
      const fields = { draft_reply: result.body, draft_subject: replySubject(current.subject) };
      await db.from("inbound_emails").update(fields).eq("id", row.id);
      current = { ...current, ...fields };
    }
  }
  if (canDraft && draft) {
    await supersedeOlder(admin, company, contact.id, row.id);
    const approvalId = await askOwner(admin, company, current, contact, draft, nowMs);
    return { ...current, approval_id: approvalId, reply_status: "awaiting_owner", owner_alert_status: "approval" };
  }
  await db.from("inbound_emails").update({ reply_status: "no_draft" }).eq("id", row.id);
  current = { ...current, reply_status: "no_draft" };
  const status = await alertForEmail(admin, company, current, nowMs);
  return { ...current, owner_alert_status: status };
}
