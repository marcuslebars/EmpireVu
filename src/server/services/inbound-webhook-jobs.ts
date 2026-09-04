// Durable-first inbound webhook queue (Task 4).
//
// The Retell/Jobber webhook routes persist the raw payload here (service-role) BEFORE
// they ACK, so nothing is lost between the 200 and processing. The workflow-event
// worker drains this queue each tick (same process/service) and dispatches by provider
// back into the existing handlers — no business logic here beyond enqueue/claim/retry.
import type { Inserts, Tables } from "@/server/db/database.types";
import { toJson } from "@/server/db/json";
import { handleJobberWebhook } from "@/server/services/jobber/webhook";
import { ingestRetellCall } from "@/server/services/retell/lead-adapter";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
export type InboundWebhookJob = Tables<"inbound_webhook_jobs">;

const nowIso = (): string => new Date().toISOString();
const MAX_BACKOFF_MS = 5 * 60 * 1000;

export interface EnqueueInboundWebhookJobInput {
  provider: string;
  /** Provider event/call id (Retell call_id, or sha256 of the raw Jobber body). */
  externalId: string;
  payload: unknown;
  organizationId?: string | null;
  companyId?: string | null;
  maxAttempts?: number;
}

/**
 * Durable enqueue — INSERT ... ON CONFLICT (provider, external_id) DO NOTHING, so a
 * redelivery of the same event is a no-op. Service-role client only.
 */
export async function enqueueInboundWebhookJob(
  admin: AdminClient,
  input: EnqueueInboundWebhookJobInput,
): Promise<void> {
  const row: Inserts<"inbound_webhook_jobs"> = {
    provider: input.provider,
    external_id: input.externalId,
    payload: toJson(input.payload),
    organization_id: input.organizationId ?? null,
    company_id: input.companyId ?? null,
    max_attempts: input.maxAttempts ?? 5,
    status: "pending",
  };
  const { error } = await admin
    .from("inbound_webhook_jobs")
    .upsert(row, { onConflict: "provider,external_id", ignoreDuplicates: true });
  if (error) {
    throw error;
  }
}

export interface ClaimInboundWebhookJobsOptions {
  workerId: string;
  batch?: number;
  staleAfterSeconds?: number;
}

/** Atomic claim via the claim_inbound_webhook_jobs RPC (FOR UPDATE SKIP LOCKED). */
export async function claimInboundWebhookJobs(
  admin: AdminClient,
  options: ClaimInboundWebhookJobsOptions,
): Promise<InboundWebhookJob[]> {
  const { data, error } = await admin.rpc("claim_inbound_webhook_jobs", {
    p_batch: options.batch ?? 10,
    p_worker_id: options.workerId,
    p_stale_after_seconds: options.staleAfterSeconds ?? 900,
  });
  if (error) {
    throw error;
  }
  return data ?? [];
}

/** Terminal success. */
export async function completeInboundWebhookJob(admin: AdminClient, jobId: string): Promise<void> {
  const { error } = await admin
    .from("inbound_webhook_jobs")
    .update({ status: "completed", last_error: null, claimed_at: null, claimed_by: null })
    .eq("id", jobId);
  if (error) {
    throw error;
  }
}

/**
 * Fail with exponential backoff (returned to the queue for another attempt), or mark
 * terminal 'failed' once max_attempts is reached. last_error is always recorded.
 */
export async function failInboundWebhookJob(
  admin: AdminClient,
  job: InboundWebhookJob,
  reason: string,
): Promise<void> {
  if (job.attempts >= job.max_attempts) {
    const { error } = await admin
      .from("inbound_webhook_jobs")
      .update({ status: "failed", last_error: reason, claimed_at: null, claimed_by: null })
      .eq("id", job.id);
    if (error) {
      throw error;
    }
    return;
  }
  const backoffMs = Math.min(1000 * 2 ** job.attempts, MAX_BACKOFF_MS);
  const { error } = await admin
    .from("inbound_webhook_jobs")
    .update({
      status: "pending",
      run_at: new Date(Date.now() + backoffMs).toISOString(),
      last_error: reason,
      claimed_at: null,
      claimed_by: null,
    })
    .eq("id", job.id);
  if (error) {
    throw error;
  }
}

/**
 * Dispatch a claimed job to its provider handler. Retell → the full ingest path (same
 * lead the old synchronous webhook produced); Jobber → the existing handler (which
 * re-parses the raw body). An unknown provider is a hard error → the job dead-letters.
 */
export async function dispatchInboundWebhookJob(job: InboundWebhookJob): Promise<void> {
  switch (job.provider) {
    case "retell":
      await ingestRetellCall(job.payload);
      return;
    case "jobber":
      await handleJobberWebhook(
        typeof job.payload === "string" ? job.payload : JSON.stringify(job.payload),
      );
      return;
    default:
      throw new Error(`Unknown inbound webhook provider: ${job.provider}`);
  }
}

/** Claim + process one batch; complete on success, backoff/dead-letter on failure. */
export async function processInboundWebhookJobs(
  admin: AdminClient,
  options: ClaimInboundWebhookJobsOptions,
): Promise<number> {
  const jobs = await claimInboundWebhookJobs(admin, options);
  for (const job of jobs) {
    try {
      await dispatchInboundWebhookJob(job);
      await completeInboundWebhookJob(admin, job.id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Inbound webhook processing failed.";
      console.error(`[inbound-webhook] job ${job.id} (${job.provider}) failed:`, reason);
      await failInboundWebhookJob(admin, job, reason);
    }
  }
  return jobs.length;
}

export interface InboundWebhookJobsHealth {
  pending: number;
  running: number;
  failed: number;
}

/** Platform-level queue health (service-role). Used by /ops/jobs-health + /api/health. */
export async function getInboundWebhookJobsHealth(admin: AdminClient): Promise<InboundWebhookJobsHealth> {
  const countByStatus = async (status: string): Promise<number> => {
    const { count, error } = await admin
      .from("inbound_webhook_jobs")
      .select("*", { count: "exact", head: true })
      .eq("status", status);
    if (error) {
      throw error;
    }
    return count ?? 0;
  };
  const [pending, running, failed] = await Promise.all([
    countByStatus("pending"),
    countByStatus("running"),
    countByStatus("failed"),
  ]);
  return { pending, running, failed };
}

/**
 * Reset a failed/stuck inbound job to pending so the worker re-drives it. Scoped: the
 * job must belong to the caller's org, or be unresolved (organization_id null). Uses the
 * admin client because the table is service-role only.
 */
export async function retryInboundWebhookJob(
  admin: AdminClient,
  jobId: string,
  callerOrganizationId: string,
): Promise<InboundWebhookJob> {
  const { data: job, error: loadError } = await admin
    .from("inbound_webhook_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  if (loadError) {
    throw loadError;
  }
  if (!job || (job.organization_id !== null && job.organization_id !== callerOrganizationId)) {
    throw new Error("Inbound webhook job not found.");
  }

  const { data: updated, error: updateError } = await admin
    .from("inbound_webhook_jobs")
    .update({
      status: "pending",
      attempts: 0,
      run_at: nowIso(),
      claimed_at: null,
      claimed_by: null,
      last_error: null,
    })
    .eq("id", jobId)
    .select("*")
    .single();
  if (updateError) {
    throw updateError;
  }
  return updated;
}
