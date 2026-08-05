import type { Tables } from "@/server/db/database.types";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";

type AdminSupabaseClient = ReturnType<typeof createSupabaseAdminClient>;

function nowIso(): string {
  return new Date().toISOString();
}

export interface ClaimBillingEventJobsOptions {
  limit?: number;
  staleAfterSeconds?: number;
  workerId: string;
}

/**
 * Claim a batch of pending billing-event jobs via the claim_billing_event_jobs
 * RPC (FOR UPDATE SKIP LOCKED + stale-lock recovery). Mirrors
 * claimWorkflowEventJobs. Service-role client only.
 */
export async function claimBillingEventJobs(
  supabase: AdminSupabaseClient,
  options: ClaimBillingEventJobsOptions,
): Promise<Tables<"billing_event_jobs">[]> {
  // RPCs aren't in the generated Database types; cast for the call (same as the
  // workflow queue service).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await ((supabase as any).rpc("claim_billing_event_jobs", {
    p_limit: options.limit ?? 10,
    p_stale_after_seconds: options.staleAfterSeconds ?? 900,
    p_worker_id: options.workerId,
  }) as Promise<{
    data: Tables<"billing_event_jobs">[] | null;
    error: { message: string } | null;
  }>);

  if (error) {
    throw error;
  }

  return (data ?? []) as Tables<"billing_event_jobs">[];
}

/** Mark a claimed job completed (terminal success). */
export async function completeBillingEventJob(
  supabase: AdminSupabaseClient,
  billingEventJobId: string,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase.from("billing_event_jobs") as any)
    .update({
      completed_at: nowIso(),
      last_error: null,
      locked_at: null,
      locked_by: null,
      status: "completed",
    })
    .eq("id", billingEventJobId);

  if (error) {
    throw error;
  }
}

/**
 * Mark a claimed job failed (terminal — the de-facto dead-letter). The ledger row
 * is untouched, so the event is never lost; a failed job can be inspected and
 * re-driven manually.
 */
export async function failBillingEventJob(
  supabase: AdminSupabaseClient,
  billingEventJobId: string,
  failureReason: string,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase.from("billing_event_jobs") as any)
    .update({
      completed_at: nowIso(),
      last_error: failureReason,
      locked_at: null,
      locked_by: null,
      status: "failed",
    })
    .eq("id", billingEventJobId);

  if (error) {
    throw error;
  }
}
