import type { Tables } from "@/server/db/database.types";
import { defaultSenders, sendPushToOrganization, type PushMessage, type PushSenders } from "@/server/services/push/dispatch";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

/**
 * Schedule-conflict alerts. A booking's crew is the set of people assigned to its tasks
 * (the calendar's own rule — see ui_calendar_bookings). When a booking is created or
 * rescheduled, or someone is assigned to one of its tasks, check whether any of that crew
 * already has an overlapping pending/confirmed booking, and alert the crew plus owners
 * and admins. Fire-and-forget; never throws.
 */
type Admin = ReturnType<typeof createSupabaseAdminClient>;
type Booking = Pick<Tables<"bookings">, "id" | "organization_id" | "company_id" | "title" | "scheduled_for" | "duration_minutes" | "status">;

const ACTIVE: Array<Tables<"bookings">["status"]> = ["pending", "confirmed"];

export interface Conflict {
  booking: Booking;
  other: Booking;
  profileIds: string[];
}

function interval(b: Pick<Booking, "scheduled_for" | "duration_minutes">): [number, number] {
  const start = new Date(b.scheduled_for).getTime();
  return [start, start + (b.duration_minutes ?? 30) * 60_000];
}

export function overlaps(a: Pick<Booking, "scheduled_for" | "duration_minutes">, b: Pick<Booking, "scheduled_for" | "duration_minutes">): boolean {
  const [aStart, aEnd] = interval(a);
  const [bStart, bEnd] = interval(b);
  return aStart < bEnd && bStart < aEnd;
}

async function crewFor(admin: Admin, organizationId: string, bookingIds: string[]): Promise<Map<string, Set<string>>> {
  const { data } = await admin
    .from("tasks")
    .select("booking_id, assigned_to_profile_id")
    .eq("organization_id", organizationId)
    .in("booking_id", bookingIds)
    .not("assigned_to_profile_id", "is", null);
  const crews = new Map<string, Set<string>>();
  for (const row of data ?? []) {
    if (!row.booking_id || !row.assigned_to_profile_id) continue;
    const crew = crews.get(row.booking_id) ?? new Set<string>();
    crew.add(row.assigned_to_profile_id);
    crews.set(row.booking_id, crew);
  }
  return crews;
}

/** Overlapping active bookings that share at least one crew member with `bookingId`. */
export async function findBookingConflicts(admin: Admin, organizationId: string, bookingId: string): Promise<Conflict[]> {
  const { data: bookingRow } = await admin
    .from("bookings")
    .select("id, organization_id, company_id, title, scheduled_for, duration_minutes, status")
    .eq("organization_id", organizationId)
    .eq("id", bookingId)
    .maybeSingle();
  const booking = bookingRow as Booking | null;
  if (!booking || !ACTIVE.includes(booking.status)) return [];

  const crew = (await crewFor(admin, organizationId, [booking.id])).get(booking.id);
  if (!crew || crew.size === 0) return [];

  // Candidates: same organization, active, within a day either side.
  const [start, end] = interval(booking);
  const { data: nearby } = await admin
    .from("bookings")
    .select("id, organization_id, company_id, title, scheduled_for, duration_minutes, status")
    .eq("organization_id", organizationId)
    .in("status", ACTIVE)
    .neq("id", booking.id)
    .gte("scheduled_for", new Date(start - 86_400_000).toISOString())
    .lte("scheduled_for", new Date(end).toISOString());
  const overlapping = ((nearby ?? []) as Booking[]).filter((other) => overlaps(booking, other));
  if (overlapping.length === 0) return [];

  const otherCrews = await crewFor(admin, organizationId, overlapping.map((b) => b.id));
  return overlapping
    .map((other) => ({ booking, other, profileIds: [...(otherCrews.get(other.id) ?? [])].filter((id) => crew.has(id)) }))
    .filter((conflict) => conflict.profileIds.length > 0);
}

export function conflictMessage(conflict: Conflict, timeZone: string): PushMessage {
  const time = new Date(conflict.other.scheduled_for).toLocaleTimeString("en-CA", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return {
    title: "Schedule conflict",
    body: `${conflict.booking.title} overlaps ${conflict.other.title} at ${time}.`,
    category: "conflicts",
    urgent: false,
    data: { screen: "booking", recordId: conflict.booking.id, organizationId: conflict.booking.organization_id, companyId: conflict.booking.company_id },
  };
}

export async function notifyBookingConflicts(
  organizationId: string,
  bookingId: string,
  options: { admin?: Admin; senders?: PushSenders } = {},
): Promise<number> {
  try {
    const senders = options.senders ?? defaultSenders();
    if (!senders.ios && !senders.android) return 0;
    const admin = options.admin ?? createSupabaseAdminClient();

    const conflicts = await findBookingConflicts(admin, organizationId, bookingId);
    if (conflicts.length === 0) return 0;

    const { data: managers } = await admin
      .from("organization_memberships")
      .select("profile_id")
      .eq("organization_id", organizationId)
      .in("role", ["owner", "admin"]);
    const managerIds = (managers ?? []).map((m) => m.profile_id);
    const timeZone = process.env.BUSINESS_TIMEZONE?.trim() || "America/Toronto";

    // One push per conflicting pair; the overlap is the same news for everyone involved.
    for (const conflict of conflicts) {
      const recipients = [...new Set([...conflict.profileIds, ...managerIds])];
      await sendPushToOrganization(admin, organizationId, conflictMessage(conflict, timeZone), { recipientUserIds: recipients, senders });
    }
    return conflicts.length;
  } catch (error) {
    console.error("[push] conflict check failed:", error instanceof Error ? error.message : error);
    return 0;
  }
}
