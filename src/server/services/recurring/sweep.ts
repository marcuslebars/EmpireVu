/**
 * SANCTIONED EXCEPTION (service role): the daily recurring-jobs sweep, run by
 * job:quote-maintenance. A background job has no session; it reads active series
 * across tenants and generates each one's visits through generateVisits, pinned to
 * that series' own organization_id (every query filters by it). No request input.
 * Listed in docs/EMPIREVU_RUNBOOK.md (service-role surfaces).
 */
import type { Tables } from "@/server/db/database.types";
import type { TenantServiceContext } from "@/server/services/shared";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { addDaysYmd } from "./rule";
import { generateVisits, HORIZON_DAYS } from "./service";

export interface RecurringSweepResult {
  scanned: number;
  visitsCreated: number;
  failed: string[];
}

export async function sweepRecurringJobs(now = new Date(), limit = 2000): Promise<RecurringSweepResult> {
  const admin = createSupabaseAdminClient();
  // Re-check a series once its horizon is within a week (or it has never been laid out).
  const refreshBefore = addDaysYmd(now.toISOString().slice(0, 10), HORIZON_DAYS - 7);
  const { data, error } = await admin
    .from("recurring_jobs")
    .select("*")
    .eq("status", "active")
    .or(`generated_through.is.null,generated_through.lt.${refreshBefore}`)
    .limit(limit);
  if (error) throw error;

  const result: RecurringSweepResult = { scanned: data?.length ?? 0, visitsCreated: 0, failed: [] };
  for (const series of (data ?? []) as Tables<"recurring_jobs">[]) {
    const ctx = { organizationId: series.organization_id, actorProfileId: null, supabase: admin } as unknown as TenantServiceContext;
    try {
      result.visitsCreated += (await generateVisits(ctx, series, now)).length;
    } catch (err) {
      result.failed.push(series.id);
      console.error(`[recurring] series ${series.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return result;
}
