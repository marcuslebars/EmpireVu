/**
 * Open times for moving jobs — the same rules as the owner channel and the customer's visit
 * page (scheduling/rules.ts openTimes over the company's booking windows or hourly online-booking
 * settings, company-wide busy), loaded once so a batch of moves can't land two jobs in one slot.
 */
import type { Tables } from "@/server/db/database.types";
import { parseBookingPolicy, type BookingPolicy, type BusyBooking } from "@/server/services/booking-windows";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { openTimes, parseOnlineBookingSettings, presentOpenTimes, type OnlineBookingSettings, type PresentedTime } from "@/server/services/scheduling/rules";
import type { DispatchCompany } from "./company";
import type { Db } from "./db-types";

export interface CalendarBooking {
  id: string;
  scheduledFor: string;
  durationMinutes: number;
  windowKey: string | null;
}

export interface SlotContext {
  timeZone: string;
  policy: BookingPolicy | null;
  settings: OnlineBookingSettings;
  bookings: CalendarBooking[];
}

/** The company's booking rules + every non-cancelled booking from yesterday to the horizon. */
export async function loadSlotContext(admin: AdminClient, company: Pick<DispatchCompany, "organizationId" | "companyId" | "timeZone">, nowMs: number): Promise<SlotContext> {
  const db = admin as Db;
  const { data: row } = await db
    .from("companies")
    .select("booking_policy, online_booking_settings")
    .eq("organization_id", company.organizationId)
    .eq("id", company.companyId)
    .maybeSingle();
  const r = row as Pick<Tables<"companies">, "booking_policy" | "online_booking_settings"> | null;
  const policy = parseBookingPolicy(r?.booking_policy ?? null);
  const settings = parseOnlineBookingSettings(r?.online_booking_settings);
  const horizon = (policy ? policy.horizonDays : settings.horizonDays) + 14;
  // PostgREST caps a response at 1000 rows: page through.
  const data: unknown[] = [];
  for (let from = 0; from < 10_000; from += 1000) {
    const { data: page, error } = await db
      .from("bookings")
      .select("id, scheduled_for, duration_minutes, window_key, status")
      .eq("organization_id", company.organizationId)
      .eq("company_id", company.companyId)
      .neq("status", "cancelled")
      .gte("scheduled_for", new Date(nowMs - 86_400_000).toISOString())
      .lte("scheduled_for", new Date(nowMs + horizon * 86_400_000).toISOString())
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    data.push(...((page ?? []) as unknown[]));
    if (((page ?? []) as unknown[]).length < 1000) break;
  }
  const bookings = ((data ?? []) as Array<Pick<Tables<"bookings">, "id" | "scheduled_for" | "duration_minutes" | "window_key" | "status">>)
    .filter((b) => b.status !== "cancelled" && b.status !== "no_show")
    .map((b) => ({ id: b.id, scheduledFor: b.scheduled_for, durationMinutes: b.duration_minutes, windowKey: b.window_key }));
  return { timeZone: company.timeZone, policy, settings, bookings };
}

/**
 * Open times this booking could move to: busy = every other booking + `extraBusy` (slots already
 * promised to other jobs in this batch). The owner isn't held to the customer notice period —
 * only to `earliestMs`.
 */
export function openSlotsFor(
  ctx: SlotContext,
  booking: { id: string; durationMinutes: number; scheduledFor: string },
  nowMs: number,
  options: { extraBusy?: BusyBooking[]; earliestMs?: number; excludeIds?: string[]; limit?: number } = {},
): PresentedTime[] {
  const exclude = new Set([booking.id, ...(options.excludeIds ?? [])]);
  const busy: BusyBooking[] = [
    ...ctx.bookings.filter((b) => !exclude.has(b.id)).map((b) => ({ scheduledFor: b.scheduledFor, durationMinutes: b.durationMinutes, windowKey: b.windowKey })),
    ...(options.extraBusy ?? []),
  ];
  const times = openTimes({
    now: new Date(nowMs),
    timeZone: ctx.timeZone,
    policy: ctx.policy,
    settings: ctx.settings,
    busy,
    earliestMs: options.earliestMs ?? nowMs,
    durationMinutes: Math.max(15, booking.durationMinutes),
    limit: options.limit ?? 400,
  }).filter((t) => Date.parse(t.startsAt) !== Date.parse(booking.scheduledFor));
  return presentOpenTimes(times, ctx.policy, ctx.timeZone);
}

/** Is `startsAt` (+ window) still an open time for this booking right now? */
export function slotStillOpen(ctx: SlotContext, booking: { id: string; durationMinutes: number; scheduledFor: string }, startsAt: string, windowKey: string | null, nowMs: number): PresentedTime | null {
  return (
    openSlotsFor(ctx, booking, nowMs).find((t) => Date.parse(t.startsAt) === Date.parse(startsAt) && (t.windowKey ?? null) === (windowKey ?? null)) ?? null
  );
}
