/**
 * Post-job check-ins (docs/ai-staff.md → "Customer care & warranty"). One text per completed job:
 *
 *   "Hi Dana, it's Northshore Roofing - how did the roof replacement go? Reply 1-5 (5 = great),
 *    or tell us anything we missed."
 *
 * Planning (`customer_care:jobs`): `booking.completed` activity events from the last 3 days, for
 * companies where the role works (CrankLeads + the SMS agent on; house orgs only if they opted in).
 * Each job gets ONE care_checkins row (unique booking_id: the claim) — scheduled, or skipped with
 * the reason — and its job_warranties row. Callback / warranty visits get neither.
 *
 * Timing: `delay_days` (1) after the job at `time` (10:00) local, inside 09:00–20:00. If a review
 * request for that customer is scheduled (or went out) within 24 h of the check-in, the check-in
 * moves a day (at most 3 times, then it's skipped). That is the ONLY link to reviews, and it only
 * ever moves the check-in: review requests are never skipped, delayed or chosen because of a
 * check-in or its answer (Google's policy against selectively asking happy customers).
 *
 * Sending (`customer_care:checkins`): claimed scheduled → sending, then re-checked: still on, a
 * cell, not opted out, the customer hasn't texted in the last 24 h, no check-in to them in the last
 * 7 days, no open care case. From the company's own number only, consent via deliverMessage (the
 * job as a purchase), message_log.sent_by 'customer_care'.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { BOOKING_COLUMNS, CONTACT_COLUMNS, type CareBooking, type CareCheckinRow, type CareContact, type Db } from "./db-types";
import { careDeps, consentFor, SENT_BY, tenant } from "./outbox";
import type { CareCompany } from "./settings";
import { checkinText, firstNameOf, jobLabelOf } from "./texts";
import { addDays, inCustomerWindow, localDate, nextCustomerOpening, zonedInstant } from "./time";
import { ensureJobWarranty } from "./warranty";

const DAY = 86_400_000;
export const LOOKBACK_MS = 3 * DAY;
/** A check-in this late (a long outage) isn't sent at all. */
export const STALE_MS = 36 * 3_600_000;
export const MAX_PUSHES = 3;
const REVIEW_GAP_MS = 24 * 3_600_000;

type Scope = { organizationId: string; companyId: string };

interface CompletionEvent {
  organization_id: string;
  company_id: string | null;
  entity_id: string | null;
  occurred_at: string;
}

/** Recent job completions of these companies (newest first). */
export async function recentCompletions(admin: AdminClient, companies: CareCompany[], nowMs: number): Promise<CompletionEvent[]> {
  const orgIds = [...new Set(companies.map((c) => c.organizationId))];
  const out: CompletionEvent[] = [];
  for (let i = 0; i < orgIds.length; i += 150) {
    const { data, error } = await (admin as Db)
      .from("activity_events")
      .select("organization_id, company_id, entity_id, occurred_at")
      .in("organization_id", orgIds.slice(i, i + 150))
      .eq("event_type", "booking.completed")
      .gte("occurred_at", new Date(nowMs - LOOKBACK_MS).toISOString())
      .order("occurred_at", { ascending: false })
      .limit(1000);
    if (error) throw error;
    out.push(...((data ?? []) as CompletionEvent[]));
  }
  return out;
}

/** The job's value before HST: its own price, else its quote's subtotal; null when unknown. */
export async function jobValueCents(admin: AdminClient, scope: Scope, booking: CareBooking): Promise<number | null> {
  if (typeof booking.price_cents === "number" && booking.price_cents > 0) return booking.price_cents;
  if (!booking.quote_id) return null;
  const { data } = await (admin as Db).from("quotes").select("subtotal_cents, company_id").eq("organization_id", scope.organizationId).eq("id", booking.quote_id).maybeSingle();
  const q = data as { subtotal_cents: number | null; company_id: string | null } | null;
  if (!q || (q.company_id && q.company_id !== scope.companyId)) return null;
  return typeof q.subtotal_cents === "number" ? q.subtotal_cents : null;
}

/**
 * Does a review request clash with a check-in at `atMs`? Same local day, or due in the 24 h after
 * it. (A review that went out the day before doesn't hold the check-in up.) PURE.
 */
export function reviewClashes(reviewMs: number, atMs: number, timeZone: string): boolean {
  if (!Number.isFinite(reviewMs)) return false;
  if (localDate(new Date(reviewMs), timeZone) === localDate(new Date(atMs), timeZone)) return true;
  return reviewMs > atMs && reviewMs - atMs < REVIEW_GAP_MS;
}

/** A review request for this customer (scheduled, sending or sent) that clashes with a check-in at `atMs`? */
export async function reviewNear(admin: AdminClient, scope: Scope, contactId: string, atMs: number, timeZone: string): Promise<boolean> {
  const { data, error } = await (admin as Db)
    .from("review_requests")
    .select("id, status, scheduled_for, sent_at")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("contact_id", contactId)
    .in("status", ["scheduled", "sending", "sent"])
    .gte("scheduled_for", new Date(atMs - 3 * DAY).toISOString())
    .limit(20);
  if (error) return false; // tolerant: no table / no access → no clash known
  return ((data ?? []) as Array<{ scheduled_for: string; sent_at: string | null }>).some((r) => reviewClashes(Date.parse(r.sent_at ?? r.scheduled_for), atMs, timeZone));
}

/** The planned send time: `delayDays` after the job's local day, at the setting's time. PURE. */
export function plannedSendAt(completedMs: number, company: Pick<CareCompany, "timeZone" | "settings">): number {
  const day = addDays(localDate(new Date(completedMs), company.timeZone), company.settings.checkins.delayDays);
  return zonedInstant(day, company.settings.checkins.time, company.timeZone).getTime();
}

async function insertCheckin(admin: AdminClient, company: CareCompany, booking: CareBooking, row: Partial<CareCheckinRow> & { status: CareCheckinRow["status"]; send_at: string }): Promise<boolean> {
  const { error } = await (admin as Db).from("care_checkins").insert({
    organization_id: company.organizationId,
    company_id: company.companyId,
    contact_id: booking.contact_id,
    booking_id: booking.id,
    ...row,
  });
  if (error) {
    if ((error as { code?: string }).code === "23505") return false;
    throw error;
  }
  return true;
}

/** Is this booking a callback / warranty visit? (Those get no check-in and no new warranty.) */
async function careVisitIds(admin: AdminClient, scope: Scope, bookingIds: string[]): Promise<Set<string>> {
  if (bookingIds.length === 0) return new Set();
  const { data, error } = await (admin as Db).from("care_case_bookings").select("booking_id").eq("organization_id", scope.organizationId).in("booking_id", bookingIds);
  if (error) throw error;
  return new Set(((data ?? []) as Array<{ booking_id: string }>).map((r) => r.booking_id));
}

/** Plan one company's new completions: a check-in row (scheduled or skipped) + the job warranty. */
export async function planCompany(admin: AdminClient, company: CareCompany, events: CompletionEvent[], nowMs: number): Promise<number> {
  const scope = { organizationId: company.organizationId, companyId: company.companyId };
  const db = admin as Db;
  const completedAt = new Map<string, string>();
  for (const e of events) if (e.entity_id && !completedAt.has(e.entity_id)) completedAt.set(e.entity_id, e.occurred_at);
  const ids = [...completedAt.keys()];
  if (ids.length === 0) return 0;
  let planned = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    const [{ data: bookings, error: e1 }, { data: done, error: e2 }, visits] = await Promise.all([
      db.from("bookings").select(BOOKING_COLUMNS).eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).in("id", part),
      db.from("care_checkins").select("booking_id").eq("organization_id", scope.organizationId).in("booking_id", part),
      careVisitIds(admin, scope, part),
    ]);
    if (e1) throw e1;
    if (e2) throw e2;
    const seen = new Set(((done ?? []) as Array<{ booking_id: string }>).map((r) => r.booking_id));
    for (const booking of (bookings ?? []) as CareBooking[]) {
      if (seen.has(booking.id) || visits.has(booking.id) || booking.status !== "completed") continue;
      try {
        if (await planOne(admin, company, booking, completedAt.get(booking.id) ?? booking.completed_at ?? booking.scheduled_for, nowMs)) planned++;
      } catch (err) {
        console.error("[customer-care] planning the check-in failed", booking.id, err instanceof Error ? err.message : err);
      }
    }
  }
  return planned;
}

async function planOne(admin: AdminClient, company: CareCompany, booking: CareBooking, completedIso: string, nowMs: number): Promise<boolean> {
  const scope = { organizationId: company.organizationId, companyId: company.companyId };
  const db = admin as Db;
  const contact = booking.contact_id
    ? ((await db.from("contacts").select(CONTACT_COLUMNS).eq("organization_id", scope.organizationId).eq("id", booking.contact_id).maybeSingle()).data as CareContact | null)
    : null;
  const label = jobLabelOf(booking.title, contact);
  const completedMs = Number.isFinite(Date.parse(completedIso)) ? Date.parse(completedIso) : nowMs;
  const withCompleted = { ...booking, completed_at: booking.completed_at ?? new Date(completedMs).toISOString() };
  // The workmanship warranty is recorded whatever happens to the check-in.
  await ensureJobWarranty(admin, company, withCompleted, label);

  const skip = (reason: string) => insertCheckin(admin, company, booking, { status: "skipped", reason, send_at: new Date(nowMs).toISOString(), job_label: label });
  if (!company.settings.checkins.enabled) return skip("check-ins are off");
  if (!contact?.phone) return skip("no cell on file");
  if (contact.sms_opt_out_at) return skip("opted out");
  const min = company.settings.checkins.minJobCents;
  if (min > 0) {
    const value = await jobValueCents(admin, scope, booking);
    if (value == null || value < min) return skip(value == null ? "no price on the job" : "under the minimum job size");
  }
  if (!(await careDeps().smsFrom(tenant(admin, scope.organizationId), scope.companyId))) return skip("no business texting number");

  let sendAt = plannedSendAt(completedMs, company);
  if (sendAt < nowMs) {
    if (nowMs - sendAt > STALE_MS) return skip("job finished too long ago");
    sendAt = nextCustomerOpening(nowMs, company.timeZone);
  }
  let pushes = 0;
  while (pushes < MAX_PUSHES && contact.id && (await reviewNear(admin, scope, contact.id, sendAt, company.timeZone))) {
    // The next local day at the setting's time (DST-safe), never earlier than the next opening.
    sendAt = Math.max(zonedInstant(addDays(localDate(new Date(sendAt), company.timeZone), 1), company.settings.checkins.time, company.timeZone).getTime(), nextCustomerOpening(sendAt + 12 * 3_600_000, company.timeZone));
    pushes++;
  }
  return insertCheckin(admin, company, booking, {
    status: "scheduled",
    send_at: new Date(sendAt).toISOString(),
    pushes,
    job_label: label,
    created_at: new Date(nowMs).toISOString(),
  } as Partial<CareCheckinRow> & { status: "scheduled"; send_at: string });
}

/** Did the customer text the business in the last 24 h? */
async function textedRecently(admin: AdminClient, scope: Scope, contactId: string, nowMs: number): Promise<boolean> {
  const { data, error } = await (admin as Db)
    .from("message_log")
    .select("id")
    .eq("organization_id", scope.organizationId)
    .eq("contact_id", contactId)
    .eq("direction", "inbound")
    .gte("created_at", new Date(nowMs - DAY).toISOString())
    .limit(1);
  if (error) throw error;
  return ((data ?? []) as unknown[]).length > 0;
}

async function checkinSentRecently(admin: AdminClient, scope: Scope, contactId: string, nowMs: number): Promise<boolean> {
  const { data, error } = await (admin as Db)
    .from("care_checkins")
    .select("id")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("contact_id", contactId)
    .eq("status", "sent")
    .gte("sent_at", new Date(nowMs - 7 * DAY).toISOString())
    .limit(1);
  if (error) throw error;
  return ((data ?? []) as unknown[]).length > 0;
}

async function openCaseFor(admin: AdminClient, scope: Scope, contactId: string): Promise<boolean> {
  const { data, error } = await (admin as Db)
    .from("care_cases")
    .select("id")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("contact_id", contactId)
    .in("status", ["open", "scheduled"])
    .limit(1);
  if (error) throw error;
  return ((data ?? []) as unknown[]).length > 0;
}

async function finish(admin: AdminClient, row: CareCheckinRow, patch: Partial<CareCheckinRow>): Promise<void> {
  await (admin as Db).from("care_checkins").update(patch).eq("id", row.id).eq("organization_id", row.organization_id).eq("status", "sending");
}

export type CheckinOutcome = "sent" | "skipped" | "blocked" | "failed" | "moved" | "waiting" | "duplicate";

/** Send one due check-in (claimed first). */
export async function sendCheckin(admin: AdminClient, company: CareCompany, row: CareCheckinRow, nowMs: number): Promise<CheckinOutcome> {
  const db = admin as Db;
  const scope = { organizationId: company.organizationId, companyId: company.companyId };
  if (!inCustomerWindow(nowMs, company.timeZone)) {
    if (nowMs - Date.parse(row.send_at) <= STALE_MS) return "waiting";
  }
  const { data: claimed } = await db.from("care_checkins").update({ status: "sending" }).eq("id", row.id).eq("organization_id", row.organization_id).eq("status", "scheduled").select("id");
  if (((claimed ?? []) as unknown[]).length === 0) return "duplicate";
  const skip = async (reason: string): Promise<CheckinOutcome> => {
    await finish(admin, row, { status: "skipped", reason });
    return "skipped";
  };
  try {
    if (nowMs - Date.parse(row.send_at) > STALE_MS) return await skip("too late to send");
    if (!company.settings.checkins.enabled) return await skip("check-ins are off");
    const { data: b } = await db.from("bookings").select(BOOKING_COLUMNS).eq("organization_id", scope.organizationId).eq("id", row.booking_id).maybeSingle();
    const booking = b as CareBooking | null;
    if (!booking || booking.status !== "completed") return await skip("the job isn't marked done any more");
    const contact = row.contact_id ? ((await db.from("contacts").select(CONTACT_COLUMNS).eq("organization_id", scope.organizationId).eq("id", row.contact_id).maybeSingle()).data as CareContact | null) : null;
    if (!contact?.phone) return await skip("no cell on file");
    if (contact.sms_opt_out_at) return await skip("opted out");
    if (await textedRecently(admin, scope, contact.id, nowMs)) return await skip("the customer texted in the last 24 hours");
    if (await checkinSentRecently(admin, scope, contact.id, nowMs)) return await skip("already checked in with them this week");
    if (await openCaseFor(admin, scope, contact.id)) return await skip("they already have an open care case");
    if (await reviewNear(admin, scope, contact.id, nowMs, company.timeZone)) {
      if ((row.pushes ?? 0) >= MAX_PUSHES) return await skip("a review request kept landing the same day");
      const next = zonedInstant(addDays(localDate(new Date(nowMs), company.timeZone), 1), company.settings.checkins.time, company.timeZone).getTime();
      await db.from("care_checkins").update({ status: "scheduled", send_at: new Date(next).toISOString(), pushes: (row.pushes ?? 0) + 1 }).eq("id", row.id).eq("status", "sending");
      return "moved";
    }
    const ctx = tenant(admin, scope.organizationId);
    if (!(await careDeps().smsFrom(ctx, scope.companyId))) return await skip("no business texting number");
    const body = checkinText(company.name, firstNameOf(contact), row.job_label);
    const result = await careDeps().deliver({
      context: ctx,
      channel: "sms",
      to: contact.phone,
      body,
      companyId: scope.companyId,
      contactId: contact.id,
      consentContact: consentFor(contact, booking.completed_at ?? row.created_at ?? booking.scheduled_for),
      smsFrom: "company",
      sentBy: SENT_BY,
    });
    const status = result.status === "sent" ? "sent" : result.status === "blocked" ? "blocked" : "failed";
    await finish(admin, row, { status, sent_at: status === "sent" ? new Date(nowMs).toISOString() : null, body: result.body ?? body, reason: status === "sent" ? null : (result.reason ?? status) });
    return status;
  } catch (err) {
    await finish(admin, row, { status: "failed", reason: err instanceof Error ? err.message.slice(0, 300) : "send failed" });
    return "failed";
  }
}

/** Due check-ins of these companies (oldest first). */
export async function dueCheckins(admin: AdminClient, companyIds: string[], nowMs: number, limit = 200): Promise<CareCheckinRow[]> {
  const out: CareCheckinRow[] = [];
  for (let i = 0; i < companyIds.length && out.length < limit; i += 200) {
    const { data, error } = await (admin as Db)
      .from("care_checkins")
      .select("*")
      .eq("status", "scheduled")
      .in("company_id", companyIds.slice(i, i + 200))
      .lte("send_at", new Date(nowMs).toISOString())
      .order("send_at", { ascending: true })
      .limit(limit);
    if (error) throw error;
    out.push(...((data ?? []) as CareCheckinRow[]));
  }
  return out.slice(0, limit);
}

/** The check-in this customer is most likely answering: sent in the last 14 days, newest first. */
export async function recentCheckinFor(admin: AdminClient, scope: Scope, contactId: string, nowMs: number): Promise<CareCheckinRow | null> {
  const { data, error } = await (admin as Db)
    .from("care_checkins")
    .select("*")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("contact_id", contactId)
    .eq("status", "sent")
    .gte("sent_at", new Date(nowMs - 14 * DAY).toISOString())
    .order("sent_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return ((data ?? []) as CareCheckinRow[])[0] ?? null;
}
