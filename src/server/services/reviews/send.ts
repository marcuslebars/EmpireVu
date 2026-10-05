/**
 * SANCTIONED EXCEPTION (service role, delivery only): send review requests.
 *
 *  - sweepReviewRequests: run by the worker scheduler. A background job has no session;
 *    it reads due rows across tenants and sends each one pinned to that row's own
 *    organization_id / company_id / contact_id (every query filters by them).
 *  - sendReviewRequestNow: the manual "Ask for a review" button. The caller (service.ts)
 *    has already created the row under its own RLS session; this only sends that row,
 *    pinned to the caller's organization.
 *
 * At most once: a row is claimed (scheduled → sending) before anything is sent, so two
 * workers — or a worker and a click — can never text a customer twice. A row stuck in
 * "sending" (a crash mid-send) is marked failed, never retried.
 * Listed in docs/EMPIREVU_RUNBOOK.md (service-role surfaces).
 */
import type { Tables } from "@/server/db/database.types";
import { isEmailSendConfigured } from "@/server/outbound/email";
import { quotePublicBaseUrlFor } from "@/server/services/quotes/config";
import type { TenantServiceContext } from "@/server/services/shared";
import { deliverMessage } from "@/server/services/workflow-engine/messaging";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { parseReviewSettings, planSend, renderReviewTemplate, reviewTimeZone } from "./rules";

type Row = Tables<"review_requests">;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

const STALE_SENDING_MS = 30 * 60_000;

export function reviewLink(company: { quote_public_base_url?: string | null } | null, token: string): string {
  return `${quotePublicBaseUrlFor(company)}/r/${token}`;
}

export interface ReviewSendOutcome {
  status: "sent" | "skipped" | "failed" | "cancelled" | "deferred" | "busy";
  reason: string | null;
  channel: "sms" | "email" | null;
  to: string | null;
}

async function finish(db: Admin, row: Row, patch: Partial<Row>): Promise<void> {
  const { error } = await db
    .from("review_requests")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("organization_id", row.organization_id);
  if (error) console.error("[reviews] could not record outcome:", error.message);
}

/** Send (or skip / defer) one claimed-or-claimable row. */
async function process(db: Admin, row: Row, now: Date, channelOverride: "sms" | "email" | null): Promise<ReviewSendOutcome> {
  const org = row.organization_id;
  const [companyRes, contactRes] = await Promise.all([
    db
      .from("companies")
      .select("id, name, brand_from_name, brand_reply_email, brand_review_url, quote_public_base_url, timezone, review_settings")
      .eq("organization_id", org)
      .eq("id", row.company_id)
      .maybeSingle(),
    db
      .from("contacts")
      .select("id, first_name, phone, email, sms_opt_out_at, email_opt_out_at, sms_consent_at, consent_source")
      .eq("organization_id", org)
      .eq("id", row.contact_id)
      .maybeSingle(),
  ]);
  if (companyRes.error) throw companyRes.error;
  if (contactRes.error) throw contactRes.error;
  const company = companyRes.data;
  const contact = contactRes.data;
  if (!company || !contact) {
    await finish(db, row, { status: "skipped", reason: "The customer or company no longer exists." });
    return { status: "skipped", reason: "The customer or company no longer exists.", channel: null, to: null };
  }
  const settings = parseReviewSettings(company.review_settings);
  const timeZone = reviewTimeZone(company);

  // Is the reason for asking still true?
  let stillValid = true;
  let relationshipAt = row.created_at;
  if (row.source === "job_done" && row.booking_id) {
    const { data: b } = await db.from("bookings").select("status, completed_at").eq("organization_id", org).eq("id", row.booking_id).maybeSingle();
    stillValid = b?.status === "completed";
    relationshipAt = b?.completed_at ?? relationshipAt;
  } else if (row.source === "invoice_paid" && row.invoice_id) {
    const { data: inv } = await db.from("invoices").select("status, paid_at").eq("organization_id", org).eq("id", row.invoice_id).maybeSingle();
    stillValid = inv?.status === "paid";
    relationshipAt = inv?.paid_at ?? relationshipAt;
  }

  let askedRecently = false;
  if (settings.cooldownDays > 0) {
    const since = new Date(now.getTime() - settings.cooldownDays * 86_400_000).toISOString();
    const { data: recent } = await db
      .from("review_requests")
      .select("id")
      .eq("organization_id", org)
      .eq("company_id", row.company_id)
      .eq("contact_id", row.contact_id)
      .eq("status", "sent")
      .gte("sent_at", since)
      .neq("id", row.id)
      .limit(1);
    askedRecently = (recent ?? []).length > 0;
  }

  const plan = planSend(
    { source: row.source as "job_done" | "invoice_paid" | "manual", channel: channelOverride },
    {
      settings,
      reviewUrl: company.brand_review_url?.trim() || null,
      contact: { phone: contact.phone, email: contact.email, smsOptOut: Boolean(contact.sms_opt_out_at), emailOptOut: Boolean(contact.email_opt_out_at) },
      stillValid,
      askedRecently,
      emailConfigured: isEmailSendConfigured(),
      nowMs: now.getTime(),
      timeZone,
    },
  );

  if (plan.action === "defer") {
    await finish(db, row, { status: "scheduled", scheduled_for: new Date(plan.until).toISOString() });
    return { status: "deferred", reason: null, channel: null, to: null };
  }
  if (plan.action === "skip" || plan.action === "cancel") {
    const status = plan.action === "skip" ? "skipped" : "cancelled";
    await finish(db, row, { status, reason: plan.reason });
    return { status, reason: plan.reason, channel: null, to: null };
  }

  const brandName = company.brand_from_name?.trim() || company.name;
  const link = reviewLink(company, row.token);
  const vars = { firstName: contact.first_name, company: brandName, link };
  const body = plan.channel === "sms" ? renderReviewTemplate(settings.smsTemplate, vars) : renderReviewTemplate(settings.emailTemplate, vars);
  // A finished job or a payment is an existing business relationship (CASL implied consent);
  // an opt-out still always wins inside deliverMessage.
  const consentAt = [contact.sms_consent_at, relationshipAt].filter(Boolean).sort().pop() ?? null;

  const result = await deliverMessage({
    context: { organizationId: org, actorProfileId: row.created_by, supabase: db as never } as TenantServiceContext,
    channel: plan.channel,
    to: plan.to,
    body,
    subject: plan.channel === "email" ? renderReviewTemplate(settings.emailSubject, vars) : null,
    fromName: brandName,
    replyTo: company.brand_reply_email ?? null,
    companyId: row.company_id,
    contactId: row.contact_id,
    consentContact: {
      sms_opt_out_at: contact.sms_opt_out_at,
      email_opt_out_at: contact.email_opt_out_at,
      sms_consent_at: consentAt,
      consent_source: contact.consent_source,
    },
  });

  if (result.status === "sent") {
    await finish(db, row, { status: "sent", sent_at: now.toISOString(), channel: plan.channel, sent_to: plan.to, reason: null });
    return { status: "sent", reason: null, channel: plan.channel, to: plan.to };
  }
  const reason = result.status === "blocked" ? `Not sent: ${humanBlock(result.reason)}` : `Couldn't send: ${result.reason ?? "unknown error"}`;
  await finish(db, row, { status: result.status === "blocked" ? "skipped" : "failed", channel: plan.channel, sent_to: plan.to, reason });
  return { status: result.status === "blocked" ? "skipped" : "failed", reason, channel: plan.channel, to: plan.to };
}

function humanBlock(reason: string | undefined): string {
  if (reason === "opted_out") return "the customer has opted out.";
  if (reason === "no_consent" || reason === "consent_expired") return "no consent on file to message this customer.";
  return reason ?? "blocked.";
}

/** Claim a scheduled row (→ sending). Returns the row, or null if someone else has it. */
async function claim(db: Admin, id: string, organizationId: string): Promise<Row | null> {
  const { data, error } = await db
    .from("review_requests")
    .update({ status: "sending", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .eq("status", "scheduled")
    .select("*");
  if (error) throw error;
  return ((data ?? [])[0] as Row) ?? null;
}

async function runClaimed(db: Admin, row: Row, now: Date, channel: "sms" | "email" | null): Promise<ReviewSendOutcome> {
  try {
    return await process(db, row, now, channel);
  } catch (err) {
    const reason = `Couldn't send: ${err instanceof Error ? err.message : "unknown error"}`;
    await finish(db, row, { status: "failed", reason });
    return { status: "failed", reason, channel: null, to: null };
  }
}

/** The manual button: send this one row now (it was just created as scheduled-for-now). */
export async function sendReviewRequestNow(ctx: TenantServiceContext, requestId: string, channel: "sms" | "email" | null): Promise<ReviewSendOutcome> {
  const db = createSupabaseAdminClient() as Admin;
  const row = await claim(db, requestId, ctx.organizationId);
  if (!row) return { status: "busy", reason: "This request is already being sent.", channel: null, to: null };
  return runClaimed(db, row, new Date(), channel);
}

export interface ReviewSweepResult {
  due: number;
  sent: number;
  skipped: number;
  failed: number;
  deferred: number;
}

/** Worker: send every due automatic ask (and fail any stuck mid-send). */
export async function sweepReviewRequests(now = new Date(), limit = 200, admin?: Admin): Promise<ReviewSweepResult> {
  const db = (admin ?? createSupabaseAdminClient()) as Admin;
  const result: ReviewSweepResult = { due: 0, sent: 0, skipped: 0, failed: 0, deferred: 0 };

  const staleBefore = new Date(now.getTime() - STALE_SENDING_MS).toISOString();
  await db
    .from("review_requests")
    .update({ status: "failed", reason: "Interrupted while sending — not retried, so the customer is never asked twice.", updated_at: now.toISOString() })
    .eq("status", "sending")
    .lt("updated_at", staleBefore);

  const { data, error } = await db
    .from("review_requests")
    .select("id, organization_id")
    .eq("status", "scheduled")
    .lte("scheduled_for", now.toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(limit);
  if (error) throw error;
  for (const due of (data ?? []) as Array<{ id: string; organization_id: string }>) {
    result.due += 1;
    const row = await claim(db, due.id, due.organization_id);
    if (!row) continue;
    const out = await runClaimed(db, row, now, null);
    if (out.status === "sent") result.sent += 1;
    else if (out.status === "deferred") result.deferred += 1;
    else if (out.status === "failed") result.failed += 1;
    else result.skipped += 1;
  }
  return result;
}
