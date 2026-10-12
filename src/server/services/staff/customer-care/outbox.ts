/**
 * Customer texts about a care case (the visit offer, "Mike will call you today", …). Every text is a
 * care_messages row, unique per (company, kind, dedupe key) and claimed queued → sending by a
 * conditional update before deliverMessage, so overlapping workers send it once.
 *
 *   • From the company's own number only (the reply must reach this business and its assistant).
 *   • 09:00–20:00 company local. Outside that the row waits (not_before = the next 09:00) and the
 *     `customer_care:outbox` sweep sends it, after checking the case still wants it.
 *   • CASL: it answers the customer's own message about their job. deliverMessage gets the
 *     contact's consent plus the job as a purchase (last_purchase_at), so an opt-out always wins;
 *     the STOP footer is automatic. message_log.sent_by = 'customer_care'.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { TenantServiceContext } from "@/server/services/shared";
import { deliverMessage, resolveCompanySmsFrom, type ConsentContact, type DeliverMessageInput, type DeliverMessageResult } from "@/server/services/workflow-engine/messaging";
import { CONTACT_COLUMNS, type CareContact, type CareMessageKind, type CareMessageRow, type Db } from "./db-types";
import { nextCustomerOpening } from "./time";

export const SENT_BY = "customer_care";

export interface CareMessageDeps {
  deliver(input: DeliverMessageInput): Promise<DeliverMessageResult>;
  smsFrom(ctx: TenantServiceContext, companyId: string): Promise<string | null>;
}

export const defaultCareMessageDeps: CareMessageDeps = {
  deliver: (input) => deliverMessage(input),
  smsFrom: (ctx, companyId) => resolveCompanySmsFrom(ctx, companyId),
};

let deps: CareMessageDeps = defaultCareMessageDeps;

/** Test hook. */
export function setCareMessageDeps(next: Partial<CareMessageDeps>): void {
  deps = { ...defaultCareMessageDeps, ...next };
}

export function resetCareMessageDeps(): void {
  deps = defaultCareMessageDeps;
}

export function careDeps(): CareMessageDeps {
  return deps;
}

export function tenant(admin: AdminClient, organizationId: string): TenantServiceContext {
  return { organizationId, actorProfileId: null, supabase: admin } as unknown as TenantServiceContext;
}

export async function loadContact(admin: AdminClient, organizationId: string, contactId: string | null): Promise<CareContact | null> {
  if (!contactId) return null;
  const { data, error } = await (admin as Db).from("contacts").select(CONTACT_COLUMNS).eq("organization_id", organizationId).eq("id", contactId).maybeSingle();
  if (error) throw error;
  return (data as CareContact | null) ?? null;
}

/** The contact's consent, plus the job as a purchase relationship when we know when it was done. */
export function consentFor(contact: CareContact, lastPurchaseAt: string | null): ConsentContact {
  return {
    sms_opt_out_at: contact.sms_opt_out_at,
    email_opt_out_at: contact.email_opt_out_at,
    sms_consent_at: contact.sms_consent_at,
    consent_source: contact.consent_source,
    ...(lastPurchaseAt ? { last_purchase_at: lastPurchaseAt } : {}),
  };
}

/** The customer's latest completed job at this company (the CASL purchase date), or null. */
export async function lastPurchaseAt(admin: AdminClient, scope: { organizationId: string; companyId: string }, contactId: string): Promise<string | null> {
  const { data, error } = await (admin as Db)
    .from("bookings")
    .select("completed_at, scheduled_for")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("contact_id", contactId)
    .eq("status", "completed")
    .order("scheduled_for", { ascending: false })
    .limit(1);
  if (error) return null;
  const row = ((data ?? []) as Array<{ completed_at: string | null; scheduled_for: string }>)[0];
  return row ? (row.completed_at ?? row.scheduled_for) : null;
}

export type SendOutcome = "sent" | "queued" | "skipped" | "failed" | "blocked" | "duplicate";

export interface QueueInput {
  scope: { organizationId: string; companyId: string };
  timeZone: string;
  caseId: string | null;
  contactId: string;
  kind: CareMessageKind;
  dedupeKey: string;
  body: string;
  nowMs: number;
}

/**
 * Record the text and send it now when inside 09:00–20:00 (else it waits for the outbox sweep).
 * A second call with the same (kind, dedupe key) sends nothing ("duplicate").
 */
export async function queueAndSend(admin: AdminClient, input: QueueInput): Promise<SendOutcome> {
  const notBefore = nextCustomerOpening(input.nowMs, input.timeZone);
  const { data, error } = await (admin as Db)
    .from("care_messages")
    .insert({
      organization_id: input.scope.organizationId,
      company_id: input.scope.companyId,
      case_id: input.caseId,
      contact_id: input.contactId,
      kind: input.kind,
      dedupe_key: input.dedupeKey.slice(0, 200),
      status: "queued",
      body: input.body.slice(0, 1000),
      not_before: new Date(notBefore).toISOString(),
      created_at: new Date(input.nowMs).toISOString(),
    })
    .select("*")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") return "duplicate";
    throw error;
  }
  if (notBefore > input.nowMs) return "queued";
  return sendClaimed(admin, data as CareMessageRow, input.nowMs);
}

async function finish(admin: AdminClient, row: CareMessageRow, status: Exclude<CareMessageRow["status"], "queued" | "sending">, nowMs: number, error: string | null): Promise<void> {
  await (admin as Db)
    .from("care_messages")
    .update({ status, sent_at: status === "sent" ? new Date(nowMs).toISOString() : null, error })
    .eq("id", row.id)
    .eq("organization_id", row.organization_id);
}

/** Claim queued → sending, then send from the company's own number. */
export async function sendClaimed(admin: AdminClient, row: CareMessageRow, nowMs: number): Promise<SendOutcome> {
  const db = admin as Db;
  const { data: claimed } = await db
    .from("care_messages")
    .update({ status: "sending", attempts: (row.attempts ?? 0) + 1 })
    .eq("id", row.id)
    .eq("organization_id", row.organization_id)
    .eq("status", "queued")
    .select("id");
  if (((claimed ?? []) as unknown[]).length === 0) return "duplicate";
  const contact = await loadContact(admin, row.organization_id, row.contact_id).catch(() => null);
  if (!contact?.phone) {
    await finish(admin, row, "skipped", nowMs, "no phone");
    return "skipped";
  }
  if (contact.sms_opt_out_at) {
    await finish(admin, row, "skipped", nowMs, "opted out");
    return "skipped";
  }
  const ctx = tenant(admin, row.organization_id);
  const from = await deps.smsFrom(ctx, row.company_id);
  if (!from) {
    await finish(admin, row, "skipped", nowMs, "no company number");
    return "skipped";
  }
  try {
    const purchase = await lastPurchaseAt(admin, { organizationId: row.organization_id, companyId: row.company_id }, contact.id);
    const result = await deps.deliver({
      context: ctx,
      channel: "sms",
      to: contact.phone,
      body: row.body,
      companyId: row.company_id,
      contactId: contact.id,
      consentContact: consentFor(contact, purchase),
      smsFrom: "company",
      sentBy: SENT_BY,
    });
    const status = result.status === "sent" ? "sent" : result.status === "blocked" ? "blocked" : "failed";
    await finish(admin, row, status, nowMs, result.status === "sent" ? null : (result.reason ?? result.status));
    return status;
  } catch (err) {
    await finish(admin, row, "failed", nowMs, err instanceof Error ? err.message.slice(0, 300) : "send failed");
    return "failed";
  }
}

/** Rows due to go out (oldest first), for the outbox sweep. */
export async function dueMessages(admin: AdminClient, nowMs: number, companyIds: string[], limit = 200): Promise<CareMessageRow[]> {
  if (companyIds.length === 0) return [];
  const out: CareMessageRow[] = [];
  for (let i = 0; i < companyIds.length && out.length < limit; i += 200) {
    const { data, error } = await (admin as Db)
      .from("care_messages")
      .select("*")
      .eq("status", "queued")
      .in("company_id", companyIds.slice(i, i + 200))
      .lte("not_before", new Date(nowMs).toISOString())
      .order("not_before", { ascending: true })
      .limit(limit);
    if (error) throw error;
    out.push(...((data ?? []) as CareMessageRow[]));
  }
  return out.slice(0, limit);
}

/** A queued text that no longer makes sense is closed without sending. */
export async function skipMessage(admin: AdminClient, row: CareMessageRow, reason: string): Promise<void> {
  await (admin as Db).from("care_messages").update({ status: "skipped", error: reason.slice(0, 300) }).eq("id", row.id).eq("organization_id", row.organization_id).eq("status", "queued");
}

/** Sending rows stuck for 10 minutes (a crashed worker) are marked failed — never re-sent. */
export async function failStuck(admin: AdminClient, nowMs: number, companyIds: string[]): Promise<void> {
  if (companyIds.length === 0) return;
  for (let i = 0; i < companyIds.length; i += 200) {
    await (admin as Db)
      .from("care_messages")
      .update({ status: "failed", error: "stuck sending" })
      .eq("status", "sending")
      .in("company_id", companyIds.slice(i, i + 200))
      .lt("updated_at", new Date(nowMs - 10 * 60_000).toISOString());
  }
}
