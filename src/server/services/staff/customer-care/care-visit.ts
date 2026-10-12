/**
 * SANCTIONED EXCEPTION (service role, one narrow read): job done → invoice (invoices/auto.ts) must
 * never bill a callback or warranty visit (docs/ai-staff.md → "Customer care & warranty"). Those
 * visits are linked to their case in care_case_bookings, and a crew member's session completes the
 * job, so this one check reads with the service role — pinned to the booking's organization and
 * id, returning only yes/no.
 *
 * Only a booking Customer care created can answer true; every other booking (A1's included) gets
 * false, and any error (no service key, no table yet) is false, so invoicing works exactly as before.
 */
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import type { Db } from "./db-types";

export async function isCareVisitBooking(organizationId: string, bookingId: string | null | undefined, db?: unknown): Promise<boolean> {
  if (!bookingId) return false;
  try {
    const client = (db ?? createSupabaseAdminClient()) as Db;
    const { data, error } = await client.from("care_case_bookings").select("id").eq("organization_id", organizationId).eq("booking_id", bookingId).limit(1);
    if (error) return false;
    return ((data ?? []) as unknown[]).length > 0;
  } catch {
    return false;
  }
}
