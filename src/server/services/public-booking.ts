import { z } from "zod";

import type { Tables } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";
import { getBusinessTimezone } from "@/server/services/ai";
import type { BusySlot } from "@/server/ai/claude";
// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION #2 (approved 2026-07-16): public customer self-booking.
// The SECOND request path allowed to use the Supabase service-role (RLS-bypassing)
// client, held to the same discipline as intake:
//   • the company is resolved from the URL on the SERVER — the request body can
//     never choose which org/company is written;
//   • the only write is a PENDING booking (+ find-or-create of the contact);
//   • the requested time must be in the freshly-computed availability, so the
//     payload cannot book an arbitrary, past, or already-taken slot;
//   • the response echoes only the confirmed time.
// This module is the only other place allowed to import createSupabaseAdminClient.
// ─────────────────────────────────────────────────────────────────────────────
import { createSupabaseAdminClient } from "@/server/supabase/admin";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

// Availability rules (no per-company config yet — sensible defaults, tunable later).
const HORIZON_DAYS = 14;
const SLOT_DURATION_MINUTES = 60;
const WORK_START_HOUR = 9; // local, inclusive
const WORK_END_HOUR = 17; // local, exclusive (last slot starts at 16:00)
const MIN_LEAD_MINUTES = 120; // no bookings inside the next 2 hours

export interface PublicCompany {
  id: string;
  name: string;
  organizationId: string;
}

export interface AvailableSlot {
  startsAt: string;
  durationMinutes: number;
}

export interface PublicAvailability {
  company: { id: string; name: string };
  timezone: string;
  slots: AvailableSlot[];
}

export const publicBookingRequestSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(320),
  phone: z.string().max(40).optional(),
  startsAt: z.string(),
  notes: z.string().max(2000).optional(),
});

export type PublicBookingRequestInput = z.infer<typeof publicBookingRequestSchema>;

// ── Timezone-aware slot math (DST-safe, no dependency) ───────────────────────

/** Offset (localWallClock − UTC) in ms for an instant, in a given IANA zone. */
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(utcMs));

  const map: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = Number(part.value);
  }
  const asIfUtc = Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second);
  return asIfUtc - utcMs;
}

/** The UTC instant (ms) of a wall-clock time (y-m-d hour:00) in a given zone. */
function zonedWallTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone: string,
): number {
  const naiveUtc = Date.UTC(year, month - 1, day, hour, 0, 0);
  return naiveUtc - tzOffsetMs(naiveUtc, timeZone);
}

/** The local calendar date (y/m/d) of a UTC instant, in a given zone. */
function localCalendarDate(utcMs: number, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date(utcMs));

  const map: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = Number(part.value);
  }
  return { year: map.year, month: map.month, day: map.day };
}

function overlapsBusy(startMs: number, endMs: number, busy: BusySlot[]): boolean {
  return busy.some((slot) => {
    const busyStart = new Date(slot.startsAt).getTime();
    if (!Number.isFinite(busyStart)) return false;
    const busyEnd = busyStart + slot.durationMinutes * 60_000;
    return startMs < busyEnd && busyStart < endMs;
  });
}

/**
 * Open working-hours slots over the next two weeks, minus anything already on
 * the calendar and minus the past (with a short booking lead time). Closed on
 * Sundays. All timezone reasoning is done in the business zone so DST is handled.
 */
export function generateAvailability(nowIso: string, timeZone: string, busy: BusySlot[]): AvailableSlot[] {
  const nowMs = new Date(nowIso).getTime();
  const earliestMs = nowMs + MIN_LEAD_MINUTES * 60_000;

  const today = localCalendarDate(nowMs, timeZone);
  // Anchor at UTC-noon of today's local date; adding whole days enumerates
  // consecutive local calendar dates regardless of DST.
  const baseUtc = Date.UTC(today.year, today.month - 1, today.day, 12, 0, 0);

  const slots: AvailableSlot[] = [];
  for (let dayOffset = 0; dayOffset < HORIZON_DAYS; dayOffset++) {
    const anchor = new Date(baseUtc + dayOffset * 86_400_000);
    const year = anchor.getUTCFullYear();
    const month = anchor.getUTCMonth() + 1;
    const day = anchor.getUTCDate();
    if (anchor.getUTCDay() === 0) continue; // closed Sundays

    for (let hour = WORK_START_HOUR; hour < WORK_END_HOUR; hour++) {
      const startMs = zonedWallTimeToUtcMs(year, month, day, hour, timeZone);
      if (startMs < earliestMs) continue;
      const endMs = startMs + SLOT_DURATION_MINUTES * 60_000;
      if (overlapsBusy(startMs, endMs, busy)) continue;
      slots.push({ startsAt: new Date(startMs).toISOString(), durationMinutes: SLOT_DURATION_MINUTES });
    }
  }
  return slots;
}

// ── Service-role data access (every query pinned to the resolved company/org) ─

async function resolveCompany(admin: AdminClient, companyId: string): Promise<PublicCompany | null> {
  const { data, error } = await admin
    .from("companies")
    .select("id, name, organization_id")
    .eq("id", companyId)
    .maybeSingle();

  if (error) throw error;
  const row = data as { id: string; name: string; organization_id: string } | null;
  return row ? { id: row.id, name: row.name, organizationId: row.organization_id } : null;
}

async function loadBusy(admin: AdminClient, company: PublicCompany, nowIso: string): Promise<BusySlot[]> {
  const horizonIso = new Date(new Date(nowIso).getTime() + HORIZON_DAYS * 86_400_000).toISOString();

  const { data, error } = await admin
    .from("bookings")
    .select("title, scheduled_for, duration_minutes")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.id)
    .neq("status", "cancelled")
    .gte("scheduled_for", nowIso)
    .lte("scheduled_for", horizonIso);

  if (error) throw error;
  const rows = (data ?? []) as Array<Pick<Tables<"bookings">, "title" | "scheduled_for" | "duration_minutes">>;
  return rows.map((row) => ({
    startsAt: row.scheduled_for,
    durationMinutes: row.duration_minutes ?? 30,
    title: row.title,
  }));
}

function splitName(name: string): { firstName: string; lastName: string | null } {
  const trimmed = name.trim();
  if (!trimmed) return { firstName: "Customer", lastName: null };
  const parts = trimmed.split(/\s+/);
  return { firstName: parts[0], lastName: parts.length > 1 ? parts.slice(1).join(" ") : null };
}

async function findOrCreateContact(
  admin: AdminClient,
  company: PublicCompany,
  input: PublicBookingRequestInput,
): Promise<string> {
  const email = input.email.trim();

  const { data: existing, error: findError } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.id)
    .ilike("email", email)
    .limit(1)
    .maybeSingle();

  if (findError) throw findError;
  const found = existing as { id: string } | null;
  if (found) return found.id;

  const { firstName, lastName } = splitName(input.name);
  const { data: created, error: createError } = await admin
    .from("contacts")
    .insert({
      company_id: company.id,
      email,
      first_name: firstName,
      last_name: lastName,
      organization_id: company.organizationId,
      phone: input.phone?.trim() || null,
      stage: "lead",
    })
    .select("id")
    .single();

  if (createError) throw createError;
  return (created as { id: string }).id;
}

export async function getPublicAvailability(companyId: string): Promise<PublicAvailability | null> {
  const admin = createSupabaseAdminClient();
  const company = await resolveCompany(admin, companyId);
  if (!company) return null;

  const nowIso = new Date().toISOString();
  const timezone = getBusinessTimezone();
  const busy = await loadBusy(admin, company, nowIso);
  const slots = generateAvailability(nowIso, timezone, busy);

  return { company: { id: company.id, name: company.name }, timezone, slots };
}

export async function createPublicBookingRequest(
  companyId: string,
  input: PublicBookingRequestInput,
): Promise<{ ok: true; scheduledFor: string }> {
  const admin = createSupabaseAdminClient();
  const company = await resolveCompany(admin, companyId);
  if (!company) {
    throw new ValidationError("This booking link is not valid.");
  }

  // Re-derive availability now and require the requested slot to be in it. The
  // client cannot book a time we didn't just offer (past / taken / off-hours).
  const nowIso = new Date().toISOString();
  const busy = await loadBusy(admin, company, nowIso);
  const slots = generateAvailability(nowIso, getBusinessTimezone(), busy);
  const requestedMs = new Date(input.startsAt).getTime();
  const match = slots.find((slot) => new Date(slot.startsAt).getTime() === requestedMs);
  if (!match) {
    throw new ValidationError("That time is no longer available. Please choose another slot.");
  }

  const contactId = await findOrCreateContact(admin, company, input);

  const { data: bookingData, error: bookingError } = await admin
    .from("bookings")
    .insert({
      company_id: company.id,
      contact_id: contactId,
      created_by: null,
      description: input.notes?.trim()
        ? `Customer note: ${input.notes.trim()}`
        : "Self-booked from the public booking page.",
      duration_minutes: match.durationMinutes,
      organization_id: company.organizationId,
      scheduled_for: match.startsAt,
      status: "pending",
      title: `Booking request — ${input.name.trim()}`,
    })
    .select("*")
    .single();

  if (bookingError) throw bookingError;
  const booking = bookingData as Tables<"bookings">;

  // Owner awareness — best effort. The booking is already saved; a failed
  // timeline row must never make a real booking request look like it didn't land.
  try {
    await admin.from("activity_events").insert({
      actor_user_id: null,
      company_id: company.id,
      entity_id: booking.id,
      entity_type: "booking",
      event_type: "booking.created",
      metadata_json: {
        bookingId: booking.id,
        scheduledFor: booking.scheduled_for,
        status: booking.status,
        source: "public_booking",
      },
      organization_id: company.organizationId,
      related_entity_id: contactId,
      related_entity_type: "contact",
    });
  } catch (activityError) {
    console.error("[public-booking] activity event insert failed (non-fatal):", activityError);
  }

  return { ok: true, scheduledFor: booking.scheduled_for };
}
