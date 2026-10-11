/**
 * Every text the Dispatcher sends goes through dispatch_messages: one row per (company, kind,
 * dedupe key) is the claim (a unique-key insert — a second worker gets 23505 and sends
 * nothing), and the queue for customer texts that must wait for the company's customer hours
 * (default 09:00–20:00 local). Sending is always deliverMessage from the company's number.
 *
 * Customer texts about the customer's own booking (on our way, your visit moved) are
 * transactional: opt-out is always respected, implied-consent expiry is not applied. A gap
 * offer ("a spot opened up earlier") is an offer, so deliverMessage's full CASL consent check
 * runs (consentContact). Crew texts go to team members (no contact, no consent).
 */
import type { Tables } from "@/server/db/database.types";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { ctxFor } from "@/server/services/owner-channel/common";
import { deliverMessage } from "@/server/services/workflow-engine/messaging";
import type { DispatchCompany } from "./company";
import type { Db, DispatchMessageKind, DispatchMessageRow } from "./db-types";
import { nextLocalTime, withinLocalHours } from "./time";

export type Audience = "customer" | "crew";

export interface NewDispatchMessage {
  kind: DispatchMessageKind;
  dedupeKey: string;
  to: string | null;
  body: string;
  audience: Audience;
  /** Customer offers: run deliverMessage's CASL consent check. */
  consent?: boolean;
  bookingId?: string | null;
  contactId?: string | null;
  profileId?: string | null;
  approvalId?: string | null;
  /** Don't send after this (a stale "spot opened up" is worse than none). */
  expiresAt?: Date | null;
  payload?: Record<string, unknown>;
}

export type SendOutcome = "sent" | "queued" | "skipped" | "failed" | "blocked" | "duplicate";

const MAX_ATTEMPTS = 3;
const RETRY_MS = 10 * 60_000;

/** When may this audience be texted now? Customers: customer hours. Crew: 06:00–21:00. */
export function sendWindow(company: Pick<DispatchCompany, "settings">, audience: Audience): { from: string; until: string } {
  return audience === "customer" ? company.settings.customerHours : { from: "06:00", until: "21:00" };
}

function isDuplicate(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "23505");
}

/** Insert the claim row. Null when another worker already claimed this (company, kind, key). */
export async function claimDispatchMessage(
  admin: AdminClient,
  company: Pick<DispatchCompany, "organizationId" | "companyId">,
  input: NewDispatchMessage,
  status: "queued" | "sending" | "skipped",
  extra: { notBefore?: Date | null; reason?: string | null } = {},
): Promise<DispatchMessageRow | null> {
  const { data, error } = await (admin as Db)
    .from("dispatch_messages")
    .insert({
      organization_id: company.organizationId,
      company_id: company.companyId,
      kind: input.kind,
      dedupe_key: input.dedupeKey,
      booking_id: input.bookingId ?? null,
      contact_id: input.contactId ?? null,
      profile_id: input.profileId ?? null,
      approval_id: input.approvalId ?? null,
      to_phone: input.to,
      body: input.body,
      status,
      reason: extra.reason ?? null,
      not_before: extra.notBefore ? extra.notBefore.toISOString() : null,
      expires_at: input.expiresAt ? input.expiresAt.toISOString() : null,
      attempts: 0,
      payload: { ...(input.payload ?? {}), audience: input.audience, consent: input.consent === true },
    })
    .select("*")
    .single();
  if (error) {
    if (isDuplicate(error)) return null;
    throw error;
  }
  return data as DispatchMessageRow;
}

type ContactRow = Pick<Tables<"contacts">, "id" | "phone" | "sms_opt_out_at" | "email_opt_out_at" | "sms_consent_at" | "consent_source">;

async function scopedContact(admin: AdminClient, company: Pick<DispatchCompany, "organizationId" | "companyId">, contactId: string): Promise<ContactRow | null> {
  const { data } = await (admin as Db)
    .from("contacts")
    .select("id, phone, sms_opt_out_at, email_opt_out_at, sms_consent_at, consent_source")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .eq("id", contactId)
    .maybeSingle();
  return (data as ContactRow | null) ?? null;
}

async function finish(admin: AdminClient, row: DispatchMessageRow, patch: Record<string, unknown>): Promise<void> {
  const { error } = await (admin as Db).from("dispatch_messages").update(patch).eq("id", row.id).eq("company_id", row.company_id);
  if (error) console.error("[dispatcher] message update failed", row.id, error.message);
}

/** Send a row this worker holds (status 'sending'). Records the outcome on the row. */
export async function sendClaimedMessage(admin: AdminClient, company: DispatchCompany, row: DispatchMessageRow, nowMs: number): Promise<SendOutcome> {
  const payload = row.payload ?? {};
  const audience: Audience = payload.audience === "crew" ? "crew" : "customer";
  if (row.expires_at && Date.parse(row.expires_at) <= nowMs) {
    await finish(admin, row, { status: "skipped", reason: "expired" });
    return "skipped";
  }
  let to = row.to_phone;
  let consentContact: ContactRow | null = null;
  if (audience === "customer") {
    const contact = row.contact_id ? await scopedContact(admin, company, row.contact_id) : null;
    if (!contact || !contact.phone) {
      await finish(admin, row, { status: "skipped", reason: "no_phone" });
      return "skipped";
    }
    if (contact.sms_opt_out_at) {
      await finish(admin, row, { status: "blocked", reason: "opted_out" });
      return "blocked";
    }
    to = contact.phone;
    if (payload.consent === true) consentContact = contact;
  }
  if (!to || !row.body) {
    await finish(admin, row, { status: "skipped", reason: "no_phone" });
    return "skipped";
  }
  const result = await deliverMessage({
    context: ctxFor(admin, company.organizationId),
    channel: "sms",
    to,
    body: row.body,
    companyId: company.companyId,
    contactId: audience === "customer" ? row.contact_id : null,
    consentContact,
    smsFrom: "company",
  });
  if (result.status === "sent") {
    await finish(admin, row, { status: "sent", sent_at: new Date(nowMs).toISOString(), to_phone: to, body: result.body, attempts: row.attempts + 1 });
    return "sent";
  }
  if (result.status === "blocked") {
    await finish(admin, row, { status: "blocked", reason: result.reason ?? "blocked", attempts: row.attempts + 1 });
    return "blocked";
  }
  const attempts = row.attempts + 1;
  await finish(
    admin,
    row,
    attempts < MAX_ATTEMPTS
      ? { status: "queued", reason: result.reason ?? "failed", attempts, not_before: new Date(nowMs + RETRY_MS).toISOString() }
      : { status: "failed", reason: result.reason ?? "failed", attempts },
  );
  return "failed";
}

/**
 * Claim and send now if the audience's hours allow, else queue for the next opening (the queue
 * sweep sends it). "duplicate" when this (kind, key) was already claimed.
 */
export async function sendOrQueue(admin: AdminClient, company: DispatchCompany, input: NewDispatchMessage, nowMs: number): Promise<SendOutcome> {
  const window = sendWindow(company, input.audience);
  if (!withinLocalHours(nowMs, company.timeZone, window.from, window.until)) {
    const notBefore = nextLocalTime(nowMs, company.timeZone, window.from);
    if (input.expiresAt && input.expiresAt.getTime() <= notBefore.getTime()) {
      const skipped = await claimDispatchMessage(admin, company, input, "skipped", { reason: "outside_hours" });
      return skipped ? "skipped" : "duplicate";
    }
    const queued = await claimDispatchMessage(admin, company, input, "queued", { notBefore });
    return queued ? "queued" : "duplicate";
  }
  const row = await claimDispatchMessage(admin, company, input, "sending");
  if (!row) return "duplicate";
  return sendClaimedMessage(admin, company, row, nowMs);
}

/**
 * The queue sweep: queued rows whose time has come, inside their audience's hours. Each row is
 * claimed (queued → sending, conditional) before sending, so overlapping workers can't double it.
 */
export async function flushQueuedMessages(admin: AdminClient, nowMs: number, companies: Map<string, DispatchCompany>): Promise<number> {
  const db = admin as Db;
  const { data, error } = await db
    .from("dispatch_messages")
    .select("*")
    .eq("status", "queued")
    .lte("not_before", new Date(nowMs).toISOString())
    .order("not_before", { ascending: true })
    .limit(100);
  if (error) throw error;
  let sent = 0;
  for (const row of (data ?? []) as DispatchMessageRow[]) {
    const company = companies.get(row.company_id);
    if (!company || company.organizationId !== row.organization_id) continue;
    const audience: Audience = row.payload?.audience === "crew" ? "crew" : "customer";
    const window = sendWindow(company, audience);
    if (!withinLocalHours(nowMs, company.timeZone, window.from, window.until)) continue;
    const { data: claimed } = await db
      .from("dispatch_messages")
      .update({ status: "sending" })
      .eq("id", row.id)
      .eq("company_id", row.company_id)
      .eq("status", "queued")
      .select("*");
    const mine = ((claimed ?? []) as DispatchMessageRow[])[0];
    if (!mine) continue;
    if ((await sendClaimedMessage(admin, company, mine, nowMs)) === "sent") sent++;
  }
  return sent;
}

// ── Text helpers ─────────────────────────────────────────────────────────────

/** First name for a greeting ("Hi Sam,"), or empty. */
export function firstName(contact: { first_name?: string | null } | null | undefined): string {
  const name = (contact?.first_name ?? "").trim();
  return name && !/^\+?\d[\d\s()-]+$/.test(name) ? name.split(/\s+/)[0] : "";
}

export function greeting(name: string): string {
  return name ? `Hi ${name}` : "Hi";
}

/** "Seasonal cleanup" → "seasonal cleanup" (unless it looks like a proper noun / acronym). */
export function jobPhrase(title: string | null | undefined): string {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "visit";
  const clipped = t.length > 60 ? `${t.slice(0, 57).trimEnd()}...` : t;
  return /^[A-Z][a-z]/.test(clipped) && !/^[A-Z][a-z]+ [A-Z]/.test(clipped) ? clipped.charAt(0).toLowerCase() + clipped.slice(1) : clipped;
}
