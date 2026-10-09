/**
 * Calendar helpers for the owner channel. Every query is pinned to the owner's resolved
 * company (organization_id + company_id), never to an id from the model or a text.
 */
import type { Tables } from "@/server/db/database.types";
import { parseBookingPolicy, type BusyBooking } from "@/server/services/booking-windows";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { openTimes, parseOnlineBookingSettings, presentOpenTimes, type PresentedTime } from "@/server/services/scheduling/rules";

export interface CompanyScope {
  organizationId: string;
  companyId: string;
  companyName: string;
  timeZone: string;
}

type Booking = Tables<"bookings">;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** A booking of THIS company, or null (wrong company / not found / bad id). */
export async function findScopedBooking(admin: AdminClient, scope: CompanyScope, bookingId: unknown): Promise<Booking | null> {
  if (!isUuid(bookingId)) return null;
  const { data } = await admin
    .from("bookings")
    .select("*")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("id", bookingId)
    .maybeSingle();
  return (data as Booking | null) ?? null;
}

/** A contact of THIS company, or null. */
export async function findScopedContact(
  admin: AdminClient,
  scope: CompanyScope,
  contactId: unknown,
): Promise<Tables<"contacts"> | null> {
  if (!isUuid(contactId)) return null;
  const { data } = await admin
    .from("contacts")
    .select("*")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("id", contactId)
    .maybeSingle();
  return (data as Tables<"contacts"> | null) ?? null;
}

export function contactName(c: Pick<Tables<"contacts">, "first_name" | "last_name"> | null | undefined): string {
  if (!c) return "the customer";
  return [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || "the customer";
}

async function busyAround(admin: AdminClient, scope: CompanyScope, excludeId: string | null, nowMs: number, days: number): Promise<BusyBooking[]> {
  let query = admin
    .from("bookings")
    .select("id, scheduled_for, duration_minutes, window_key")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .neq("status", "cancelled")
    .gte("scheduled_for", new Date(nowMs - 86_400_000).toISOString())
    .lte("scheduled_for", new Date(nowMs + days * 86_400_000).toISOString())
    .limit(2000);
  if (excludeId) query = query.neq("id", excludeId);
  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as Array<Pick<Booking, "scheduled_for" | "duration_minutes" | "window_key">>).map((r) => ({
    scheduledFor: r.scheduled_for,
    durationMinutes: r.duration_minutes,
    windowKey: r.window_key,
  }));
}

/**
 * Open times this booking could move to (the brand's booking windows, else hourly slots from
 * its online-booking settings), excluding the booking itself from "busy". The owner is not
 * held to the customer-facing notice period — only to "not in the past".
 */
export async function openTimesForBooking(
  admin: AdminClient,
  scope: CompanyScope,
  booking: Pick<Booking, "id" | "duration_minutes" | "scheduled_for"> | null,
  nowMs: number,
  limit = 400,
): Promise<PresentedTime[]> {
  const { data: settingsRow } = await admin
    .from("companies")
    .select("booking_policy, online_booking_settings")
    .eq("organization_id", scope.organizationId)
    .eq("id", scope.companyId)
    .maybeSingle();
  const row = settingsRow as Pick<Tables<"companies">, "booking_policy" | "online_booking_settings"> | null;
  const policy = parseBookingPolicy(row?.booking_policy ?? null);
  const settings = parseOnlineBookingSettings(row?.online_booking_settings);
  const horizon = (policy ? policy.horizonDays : settings.horizonDays) + 14;
  const busy = await busyAround(admin, scope, booking?.id ?? null, nowMs, horizon);
  const times = openTimes({
    now: new Date(nowMs),
    timeZone: scope.timeZone,
    policy,
    settings,
    busy,
    earliestMs: nowMs,
    durationMinutes: booking ? Math.max(15, booking.duration_minutes) : undefined,
    limit,
  }).filter((t) => !booking || Date.parse(t.startsAt) !== Date.parse(booking.scheduled_for));
  return presentOpenTimes(times, policy, scope.timeZone);
}
