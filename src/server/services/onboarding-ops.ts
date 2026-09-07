import type { createSupabaseAdminClient } from "@/server/supabase/admin";
import { ONBOARDING_STEPS } from "@/server/services/onboarding";

/**
 * Internal onboarding funnel (Task 13): started/completed counts + median time-to-complete
 * per step, across all tenants. This is how the "<2 hours to a working setup" gate gets
 * proven. Service-role (cross-tenant); the route is token-gated like /ops/tenant-costs.
 */
type Admin = ReturnType<typeof createSupabaseAdminClient>;

export interface StepFunnel {
  step: string;
  started: number;
  completed: number;
  medianSeconds: number | null;
}

export interface OnboardingFunnel {
  steps: StepFunnel[];
  companiesStarted: number;
  companiesCompletedAll: number;
  overallMedianSeconds: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

interface EventRow {
  organization_id: string;
  company_id: string | null;
  step: string;
  event: string;
  occurred_at: string;
}

/** key one funnel unit per (org, company). */
const unitKey = (r: EventRow): string => `${r.organization_id}:${r.company_id ?? "-"}`;

export async function getOnboardingFunnel(admin: Admin): Promise<OnboardingFunnel> {
  const { data, error } = await admin
    .from("onboarding_events")
    .select("organization_id, company_id, step, event, occurred_at")
    .order("occurred_at", { ascending: true })
    .limit(50_000);
  if (error) throw error;
  const rows = (data ?? []) as EventRow[];

  // Earliest start + earliest complete per (unit, step).
  const firstStart = new Map<string, number>();
  const firstComplete = new Map<string, number>();
  const unitsWithStart = new Set<string>();
  for (const r of rows) {
    const ts = Date.parse(r.occurred_at);
    if (!Number.isFinite(ts)) continue;
    const k = `${unitKey(r)}:${r.step}`;
    if (r.event === "start") {
      if (!firstStart.has(k)) firstStart.set(k, ts);
      unitsWithStart.add(unitKey(r));
    } else if (r.event === "complete") {
      if (!firstComplete.has(k)) firstComplete.set(k, ts);
    }
  }

  const steps: StepFunnel[] = ONBOARDING_STEPS.map((step) => {
    let started = 0;
    let completed = 0;
    const durations: number[] = [];
    for (const unit of unitsWithStart) {
      const sk = `${unit}:${step}`;
      const s = firstStart.get(sk);
      const c = firstComplete.get(sk);
      if (s !== undefined) started += 1;
      if (c !== undefined) {
        completed += 1;
        if (s !== undefined && c >= s) durations.push((c - s) / 1000);
      }
    }
    return { step, started, completed, medianSeconds: median(durations) };
  });

  // Overall: units that completed the final step (recipes), timed from their first event.
  const lastStep = ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1];
  const firstEventPerUnit = new Map<string, number>();
  for (const r of rows) {
    const ts = Date.parse(r.occurred_at);
    if (!Number.isFinite(ts)) continue;
    const u = unitKey(r);
    if (!firstEventPerUnit.has(u)) firstEventPerUnit.set(u, ts);
  }
  const totals: number[] = [];
  let completedAll = 0;
  for (const unit of unitsWithStart) {
    const done = firstComplete.get(`${unit}:${lastStep}`);
    const start = firstEventPerUnit.get(unit);
    if (done !== undefined) {
      completedAll += 1;
      if (start !== undefined && done >= start) totals.push((done - start) / 1000);
    }
  }

  return {
    steps,
    companiesStarted: unitsWithStart.size,
    companiesCompletedAll: completedAll,
    overallMedianSeconds: median(totals),
  };
}
