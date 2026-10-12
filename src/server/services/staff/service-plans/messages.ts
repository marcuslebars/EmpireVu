/**
 * Customer texts (confirmation, renewal link, renewed, visit heads-up, declined). Every text is a
 * service_plan_messages row, unique per (company, kind, dedupe key) and claimed queued → sending
 * by a conditional update before deliverMessage, so overlapping workers send it once.
 *
 *   • From the company's own number only (a reply must reach this business).
 *   • 09:00–20:00 company local. Outside that, the row waits (not_before = the next 09:00) and the
 *     `service-plans:queue` sweep sends it, after re-checking it still makes sense.
 *   • CASL: the customer is on a plan they signed up / paid for — a purchase relationship.
 *     deliverMessage gets `consentContact` with last_purchase_at = when the plan started, so an
 *     opt-out always wins and consent is checked; the STOP footer is automatic.
 */
import { addDays, localDate, zonedInstant } from "@/server/services/booking-windows";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { localHour } from "@/server/services/owner-channel/common";
import type { TenantServiceContext } from "@/server/services/shared";
import { deliverMessage, resolveCompanySmsFrom, type ConsentContact, type DeliverMessageInput, type DeliverMessageResult } from "@/server/services/workflow-engine/messaging";
import { CONTACT_COLUMNS, type Db, type PlanContact, type PlanMessageKind, type PlanMessageRow, type ServiceAgreementRow } from "./db-types";
import type { PlanCompany } from "./settings";

export const SENT_BY = "service_plans";
export const SEND_FROM_HOUR = 9;
export const SEND_UNTIL_HOUR = 20;

export interface PlanMessageDeps {
  deliver(input: DeliverMessageInput): Promise<DeliverMessageResult>;
  smsFrom(ctx: TenantServiceContext, companyId: string): Promise<string | null>;
}

export const defaultPlanMessageDeps: PlanMessageDeps = {
  deliver: (input) => deliverMessage(input),
  smsFrom: (ctx, companyId) => resolveCompanySmsFrom(ctx, companyId),
};

export function tenant(admin: AdminClient, organizationId: string): TenantServiceContext {
  return { organizationId, actorProfileId: null, supabase: admin } as unknown as TenantServiceContext;
}

export function inCustomerWindow(nowMs: number, timeZone: string): boolean {
  const h = localHour(nowMs, timeZone);
  return h >= SEND_FROM_HOUR && h < SEND_UNTIL_HOUR;
}

/** The next moment customer texts may go (now when inside the window). */
export function nextOpening(nowMs: number, timeZone: string): number {
  if (inCustomerWindow(nowMs, timeZone)) return nowMs;
  const today = localDate(new Date(nowMs), timeZone);
  const day = localHour(nowMs, timeZone) < SEND_FROM_HOUR ? today : addDays(today, 1);
  return zonedInstant(day, `${String(SEND_FROM_HOUR).padStart(2, "0")}:00`, timeZone).getTime();
}

export async function loadContact(admin: AdminClient, organizationId: string, contactId: string | null): Promise<PlanContact | null> {
  if (!contactId) return null;
  const { data, error } = await (admin as Db).from("contacts").select(CONTACT_COLUMNS).eq("organization_id", organizationId).eq("id", contactId).maybeSingle();
  if (error) throw error;
  return (data as PlanContact | null) ?? null;
}

/** CASL: a plan the customer signed up for is a purchase relationship from when it started. */
export function consentFor(contact: PlanContact, agreement: Pick<ServiceAgreementRow, "activated_at" | "term_start" | "created_at">): ConsentContact {
  return {
    sms_opt_out_at: contact.sms_opt_out_at,
    email_opt_out_at: contact.email_opt_out_at,
    sms_consent_at: contact.sms_consent_at,
    consent_source: contact.consent_source,
    last_purchase_at: agreement.activated_at ?? (agreement.term_start ? `${agreement.term_start}T12:00:00Z` : agreement.created_at),
  };
}

export interface QueueInput {
  company: PlanCompany;
  agreement: ServiceAgreementRow;
  bookingId?: string | null;
  kind: PlanMessageKind;
  dedupeKey: string;
  body: string;
  nowMs: number;
}

export type SendOutcome = "sent" | "queued" | "skipped" | "failed" | "blocked" | "duplicate";

/**
 * Record the text and send it now when inside the window (else it waits for the queue sweep).
 * A second call with the same (kind, dedupe key) sends nothing ("duplicate").
 */
export async function queueAndSend(admin: AdminClient, input: QueueInput, deps: PlanMessageDeps = defaultPlanMessageDeps): Promise<SendOutcome> {
  const db = admin as Db;
  const contact = await loadContact(admin, input.company.organizationId, input.agreement.contact_id);
  const notBefore = nextOpening(input.nowMs, input.company.timeZone);
  const { data, error } = await db
    .from("service_plan_messages")
    .insert({
      organization_id: input.company.organizationId,
      company_id: input.company.companyId,
      agreement_id: input.agreement.id,
      booking_id: input.bookingId ?? null,
      kind: input.kind,
      dedupe_key: input.dedupeKey.slice(0, 200),
      status: "queued",
      body: input.body.slice(0, 1000),
      to_phone: contact?.phone ?? null,
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
  return sendClaimed(admin, input.company, data as PlanMessageRow, input.agreement, contact, input.nowMs, deps);
}

async function finish(admin: AdminClient, row: PlanMessageRow, status: Exclude<PlanMessageRow["status"], "queued" | "sending">, nowMs: number, error: string | null): Promise<void> {
  await (admin as Db)
    .from("service_plan_messages")
    .update({ status, sent_at: status === "sent" ? new Date(nowMs).toISOString() : null, error })
    .eq("id", row.id)
    .eq("organization_id", row.organization_id);
}

/** Claim queued → sending, then send. Returns what happened. */
export async function sendClaimed(
  admin: AdminClient,
  company: PlanCompany,
  row: PlanMessageRow,
  agreement: ServiceAgreementRow,
  contact: PlanContact | null,
  nowMs: number,
  deps: PlanMessageDeps = defaultPlanMessageDeps,
): Promise<SendOutcome> {
  const db = admin as Db;
  const { data: claimed } = await db
    .from("service_plan_messages")
    .update({ status: "sending", attempts: (row.attempts ?? 0) + 1 })
    .eq("id", row.id)
    .eq("organization_id", row.organization_id)
    .eq("status", "queued")
    .select("id");
  if (((claimed ?? []) as unknown[]).length === 0) return "duplicate";
  if (!contact?.phone) {
    await finish(admin, row, "skipped", nowMs, "no phone");
    return "skipped";
  }
  if (contact.sms_opt_out_at) {
    await finish(admin, row, "skipped", nowMs, "opted out");
    return "skipped";
  }
  const ctx = tenant(admin, company.organizationId);
  const from = await deps.smsFrom(ctx, company.companyId);
  if (!from) {
    await finish(admin, row, "skipped", nowMs, "no company number");
    return "skipped";
  }
  try {
    const result = await deps.deliver({
      context: ctx,
      channel: "sms",
      to: contact.phone,
      body: row.body,
      companyId: company.companyId,
      contactId: contact.id,
      consentContact: consentFor(contact, agreement),
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

/** Rows due to go out (oldest first), for the queue sweep. */
export async function dueMessages(admin: AdminClient, nowMs: number, limit = 200): Promise<PlanMessageRow[]> {
  const { data, error } = await (admin as Db)
    .from("service_plan_messages")
    .select("*")
    .eq("status", "queued")
    .lte("not_before", new Date(nowMs).toISOString())
    .order("not_before", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as PlanMessageRow[];
}

/** A queued text that no longer makes sense is closed without sending. */
export async function skipMessage(admin: AdminClient, row: PlanMessageRow, reason: string, nowMs: number): Promise<void> {
  await (admin as Db)
    .from("service_plan_messages")
    .update({ status: "skipped", error: reason.slice(0, 300), sent_at: null, updated_at: new Date(nowMs).toISOString() })
    .eq("id", row.id)
    .eq("organization_id", row.organization_id)
    .eq("status", "queued");
}
