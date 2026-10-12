/**
 * SANCTIONED EXCEPTION (service role, one narrow read): job done → invoice (invoices/auto.ts) must
 * not bill a visit the customer already paid for with an ANNUAL service plan (one invoice per
 * term, paid up front). Agreements are owner/admin-read under RLS, but a crew member's session
 * completes the job, so this one check reads with the service role — pinned to the booking's own
 * organization and series id, returning only yes/no.
 *
 * Only a booking of a series a service plan created can answer true; every other booking — A1's
 * recurring visits included — gets false, and any error (no service key, no table yet) is false,
 * so invoicing works exactly as before.
 */
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import type { Db } from "./db-types";

export async function isPrepaidPlanVisit(organizationId: string, recurringJobId: string | null | undefined, db?: unknown): Promise<boolean> {
  if (!recurringJobId) return false;
  try {
    const client = (db ?? createSupabaseAdminClient()) as Db;
    const { data, error } = await client
      .from("service_agreements")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("recurring_job_id", recurringJobId)
      .eq("billing", "annual")
      .limit(1);
    if (error) return false;
    return ((data ?? []) as unknown[]).length > 0;
  } catch {
    return false;
  }
}
