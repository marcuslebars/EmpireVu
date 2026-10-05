/**
 * SANCTIONED EXCEPTION (service role): the public visit page /v/{token} — confirm, move or
 * cancel a visit.
 *
 * The customer has no session; the unguessable bookings.manage_token IS the credential,
 * exactly as for /q/, /i/ and /p/ links. So every function here:
 *   • looks the booking up ONLY by its exact token,
 *   • reads/writes only that booking's own organization + company + contact (every query is
 *     pinned to the ids on the booking row — never to anything in the request),
 *   • returns the narrowed VisitView (no internal ids, notes, crew or prices),
 *   • re-derives open times on the server and accepts a new time only if it is one of
 *     them, so the request can't book an arbitrary, past or full slot,
 *   • enforces the brand's settings and cutoff on the server.
 * Writes go through the normal booking services (rescheduleBooking / updateBookingStatus)
 * with a context pinned to the booking's organization, so activity, automations and
 * reminder re-timing behave exactly as for a staff change.
 * Listed in docs/EMPIREVU_RUNBOOK.md (service-role surfaces).
 */
import { z } from "zod";

import type { Tables } from "@/server/db/database.types";
import { findOpenWindows, localDate, parseBookingPolicy, type BusyBooking } from "@/server/services/booking-windows";
import { createActivityEvent } from "@/server/services/activity-events";
import { rescheduleBooking, updateBookingStatus } from "@/server/services/bookings";
import { companyTimeZone, loadCompanyForInvoice } from "@/server/services/invoices/common";
import { brandOfCompany, type InvoiceBrand } from "@/server/services/invoices/document";
import { generateAvailability } from "@/server/services/public-booking";
import { notifyVisitChange } from "@/server/services/push/notify";
import type { TenantServiceContext } from "@/server/services/shared";
import { createTask } from "@/server/services/tasks";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { MANAGE_TOKEN_RE, parseVisitSettings, visitActions, visitLabels, visitState, type VisitActions, type VisitState } from "./rules";

type Booking = Tables<"bookings">;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

export class VisitNotFoundError extends Error {}
export class VisitConflictError extends Error {}

export interface VisitView extends VisitActions {
  brand: InvoiceBrand;
  customerName: string;
  title: string;
  date: string;
  time: string;
  /** "in the morning" style label when the visit is booked into a window. */
  windowLabel: string | null;
  location: string | null;
  state: VisitState;
  confirmedAt: string | null;
}

export interface OpenTime {
  startsAt: string;
  /** Local calendar day (YYYY-MM-DD) for grouping. */
  day: string;
  dayLabel: string;
  /** "9:00 a.m." or "Morning". */
  label: string;
  windowKey: string | null;
}

const admin = (): Admin => createSupabaseAdminClient();

function ctxFor(db: Admin, booking: Booking): TenantServiceContext {
  return { organizationId: booking.organization_id, actorProfileId: null, supabase: db } as TenantServiceContext;
}

async function bookingByToken(db: Admin, token: string): Promise<Booking | null> {
  if (!MANAGE_TOKEN_RE.test(token)) return null;
  const { data, error } = await db.from("bookings").select("*").eq("manage_token", token).maybeSingle();
  if (error) throw error;
  return (data as Booking) ?? null;
}

async function load(db: Admin, token: string) {
  const booking = await bookingByToken(db, token);
  if (!booking) throw new VisitNotFoundError("This link isn't valid any more.");
  const [company, contactRes] = await Promise.all([
    loadCompanyForInvoice(db, booking.organization_id, booking.company_id),
    booking.contact_id
      ? db.from("contacts").select("first_name").eq("organization_id", booking.organization_id).eq("id", booking.contact_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const { data: settingsRow } = await db
    .from("companies")
    .select("visit_settings, booking_policy")
    .eq("organization_id", booking.organization_id)
    .eq("id", booking.company_id)
    .maybeSingle();
  return {
    booking,
    company,
    firstName: ((contactRes.data as { first_name?: string | null } | null)?.first_name ?? "").trim() || null,
    settings: parseVisitSettings(settingsRow?.visit_settings),
    policy: parseBookingPolicy(settingsRow?.booking_policy ?? null),
    timeZone: companyTimeZone(company),
  };
}

const facts = (b: Booking) => ({
  status: b.status,
  scheduledFor: b.scheduled_for,
  durationMinutes: b.duration_minutes,
  enRouteAt: b.en_route_at,
  startedAt: b.started_at,
  customerConfirmedAt: b.customer_confirmed_at,
});

function windowLabelFor(b: Booking, policy: ReturnType<typeof parseBookingPolicy>): string | null {
  if (!b.window_key || !policy) return null;
  const w = policy.windows.find((x) => x.key === b.window_key);
  return w ? w.spoken : null;
}

export async function getVisit(token: string, now: Date = new Date()): Promise<VisitView> {
  const db = admin();
  const { booking, company, firstName, settings, policy, timeZone } = await load(db, token);
  const labels = visitLabels(booking.scheduled_for, timeZone);
  return {
    brand: brandOfCompany(company),
    customerName: firstName ?? "there",
    title: booking.title,
    date: labels.date,
    time: labels.time,
    windowLabel: windowLabelFor(booking, policy),
    location: booking.location ?? null,
    state: visitState(facts(booking), now.getTime()),
    confirmedAt: booking.customer_confirmed_at,
    ...visitActions(facts(booking), settings, now.getTime()),
  };
}

async function busyFor(db: Admin, booking: Booking, now: Date, days: number): Promise<BusyBooking[]> {
  const { data, error } = await db
    .from("bookings")
    .select("id, scheduled_for, duration_minutes, window_key")
    .eq("organization_id", booking.organization_id)
    .eq("company_id", booking.company_id)
    .neq("status", "cancelled")
    .neq("id", booking.id)
    .gte("scheduled_for", new Date(now.getTime() - 86_400_000).toISOString())
    .lte("scheduled_for", new Date(now.getTime() + days * 86_400_000).toISOString())
    .limit(2000);
  if (error) throw error;
  return ((data ?? []) as Array<Pick<Booking, "scheduled_for" | "duration_minutes" | "window_key">>).map((r) => ({
    scheduledFor: r.scheduled_for,
    durationMinutes: r.duration_minutes,
    windowKey: r.window_key,
  }));
}

/** Open times the visit can move to: the brand's booking windows, or hourly slots. */
export async function openTimesFor(db: Admin, ctx: Awaited<ReturnType<typeof load>>, now: Date): Promise<OpenTime[]> {
  const { booking, policy, timeZone } = ctx;
  const cutoffMs = now.getTime() + ctx.settings.cutoffHours * 3_600_000;
  const dayLabel = (iso: string) => visitLabels(iso, timeZone).date;

  if (policy) {
    const busy = await busyFor(db, booking, now, policy.horizonDays + 14);
    return findOpenWindows({ now, timeZone, policy, bookings: busy, limit: 60 })
      .filter((w) => Date.parse(w.startsAt) >= cutoffMs && Date.parse(w.startsAt) !== Date.parse(booking.scheduled_for))
      .map((w) => {
        const def = policy.windows.find((x) => x.key === w.windowKey)!;
        const spoken = def.spoken.replace(/^in the /, "");
        return {
          startsAt: w.startsAt,
          day: w.date,
          dayLabel: dayLabel(w.startsAt),
          label: spoken.charAt(0).toUpperCase() + spoken.slice(1),
          windowKey: w.windowKey,
        };
      });
  }

  const busy = await busyFor(db, booking, now, 16);
  const durationMs = Math.max(30, booking.duration_minutes) * 60_000;
  const overlaps = (start: number) =>
    busy.some((b) => {
      const s = Date.parse(b.scheduledFor);
      const e = s + Math.max(1, b.durationMinutes) * 60_000;
      return start < e && s < start + durationMs;
    });
  return generateAvailability(now.toISOString(), timeZone, busy.map((b) => ({ startsAt: b.scheduledFor, durationMinutes: b.durationMinutes, title: "" })))
    .map((s) => Date.parse(s.startsAt))
    .filter((start) => start >= cutoffMs && !overlaps(start) && start !== Date.parse(booking.scheduled_for))
    .map((start) => {
      const iso = new Date(start).toISOString();
      const l = visitLabels(iso, timeZone);
      return { startsAt: iso, day: localDate(new Date(start), timeZone), dayLabel: l.date, label: l.time, windowKey: null };
    });
}

export async function getOpenTimes(token: string, now: Date = new Date()): Promise<OpenTime[]> {
  const db = admin();
  const ctx = await load(db, token);
  if (!visitActions(facts(ctx.booking), ctx.settings, now.getTime()).canReschedule) return [];
  return openTimesFor(db, ctx, now);
}

async function crewOf(db: Admin, booking: Booking): Promise<string[]> {
  const { data } = await db.from("booking_assignments").select("profile_id").eq("organization_id", booking.organization_id).eq("booking_id", booking.id);
  return ((data ?? []) as Array<{ profile_id: string }>).map((r) => r.profile_id);
}

async function customerLabel(db: Admin, booking: Booking): Promise<string> {
  if (!booking.contact_id) return "The customer";
  const { data } = await db.from("contacts").select("first_name, last_name").eq("organization_id", booking.organization_id).eq("id", booking.contact_id).maybeSingle();
  return [data?.first_name, data?.last_name].filter(Boolean).join(" ").trim() || "The customer";
}

/** "Yes, I'll be there." */
export async function confirmVisit(token: string, now: Date = new Date()): Promise<VisitView> {
  const db = admin();
  const { booking, settings } = await load(db, token);
  const actions = visitActions(facts(booking), settings, now.getTime());
  if (booking.customer_confirmed_at) return getVisit(token, now);
  if (!actions.canConfirm) throw new VisitConflictError("This visit can't be confirmed any more.");
  const { error } = await db
    .from("bookings")
    .update({ customer_confirmed_at: now.toISOString(), ...(booking.status === "pending" ? { status: "confirmed" } : {}) })
    .eq("organization_id", booking.organization_id)
    .eq("id", booking.id);
  if (error) throw error;
  await createActivityEvent(ctxFor(db, booking), {
    companyId: booking.company_id,
    entityId: booking.id,
    entityType: "booking",
    eventType: "booking.customer_confirmed",
    metadata: { bookingId: booking.id, scheduledFor: booking.scheduled_for },
    relatedEntityId: booking.contact_id,
    relatedEntityType: booking.contact_id ? "contact" : null,
  }).catch((err: unknown) => console.error("[visits] activity failed:", err instanceof Error ? err.message : err));
  return getVisit(token, now);
}

export const rescheduleSchema = z.object({ startsAt: z.string().datetime({ offset: true }), windowKey: z.string().max(32).nullish() });

/** Move the visit to one of the open times we offered. */
export async function rescheduleVisit(token: string, input: z.infer<typeof rescheduleSchema>, now: Date = new Date()): Promise<VisitView> {
  const db = admin();
  const ctx = await load(db, token);
  const { booking, settings, timeZone } = ctx;
  if (!visitActions(facts(booking), settings, now.getTime()).canReschedule) throw new VisitConflictError("This visit can't be moved online any more.");
  const open = await openTimesFor(db, ctx, now);
  const pick = open.find((o) => Date.parse(o.startsAt) === Date.parse(input.startsAt) && (o.windowKey ?? null) === (input.windowKey ?? null));
  if (!pick) throw new VisitConflictError("That time was just taken — please pick another.");

  const previous = booking.scheduled_for;
  await rescheduleBooking(ctxFor(db, booking), { bookingId: booking.id, scheduledFor: pick.startsAt, by: "customer", ...(pick.windowKey ? { windowKey: pick.windowKey } : {}) });
  const { error } = await db
    .from("bookings")
    .update({ customer_confirmed_at: now.toISOString(), ...(booking.status === "pending" ? { status: "confirmed" } : {}) })
    .eq("organization_id", booking.organization_id)
    .eq("id", booking.id);
  if (error) throw error;

  const who = await customerLabel(db, booking);
  const from = visitLabels(previous, timeZone);
  await notifyVisitChange({
    organizationId: booking.organization_id,
    companyId: booking.company_id,
    bookingId: booking.id,
    title: `${who} moved their visit`,
    body: `${booking.title}: ${from.date} ${from.time} → ${pick.dayLabel}, ${pick.label}`,
    crewIds: await crewOf(db, booking),
  });
  return getVisit(token, now);
}

export const cancelSchema = z.object({ reason: z.string().trim().max(500).nullish() });

/** Cancel the visit (the owner gets a task to follow up and rebook). */
export async function cancelVisit(token: string, input: z.infer<typeof cancelSchema>, now: Date = new Date()): Promise<VisitView> {
  const db = admin();
  const { booking, settings, timeZone } = await load(db, token);
  if (!visitActions(facts(booking), settings, now.getTime()).canCancel) throw new VisitConflictError("This visit can't be cancelled online any more.");
  const c = ctxFor(db, booking);
  await updateBookingStatus(c, { bookingId: booking.id, status: "cancelled" });
  const reason = input.reason?.trim() || null;
  await createActivityEvent(c, {
    companyId: booking.company_id,
    entityId: booking.id,
    entityType: "booking",
    eventType: "booking.customer_cancelled",
    metadata: { bookingId: booking.id, scheduledFor: booking.scheduled_for, reason },
    relatedEntityId: booking.contact_id,
    relatedEntityType: booking.contact_id ? "contact" : null,
  }).catch((err: unknown) => console.error("[visits] activity failed:", err instanceof Error ? err.message : err));

  const who = await customerLabel(db, booking);
  const when = visitLabels(booking.scheduled_for, timeZone);
  await createTask(c, {
    title: `${who} cancelled "${booking.title}" — follow up`.slice(0, 200),
    description: `Was booked for ${when.date} at ${when.time}.${reason ? `\n\nTheir reason: ${reason}` : ""}\n\n(Cancelled from their visit link.)`,
    companyId: booking.company_id,
    contactId: booking.contact_id,
    bookingId: booking.id,
    priority: "medium",
  }).catch((err: unknown) => console.error("[visits] follow-up task failed:", err instanceof Error ? err.message : err));

  await notifyVisitChange({
    organizationId: booking.organization_id,
    companyId: booking.company_id,
    bookingId: booking.id,
    title: `${who} cancelled their visit`,
    body: `${booking.title}, ${when.date} ${when.time}${reason ? ` — "${reason.slice(0, 80)}"` : ""}`,
    crewIds: await crewOf(db, booking),
  });
  return getVisit(token, now);
}
