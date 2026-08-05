import { processBillingEventJob } from "@/server/services/billing/events";
import { claimBillingEventJobs } from "@/server/services/billing/jobs";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

function getNumberEnv(name: string, fallback: number): number {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

/**
 * Dedicated Railway worker for the Stripe billing event queue. Same poll/claim
 * loop as the workflow-event worker, isolated so billing throughput and failures
 * never affect (or are affected by) workflow processing. Runs via
 * `npm run worker:billing-events` (see railway.billing-worker.json).
 */
async function main(): Promise<void> {
  const supabase = createSupabaseAdminClient();
  const workerId = process.env.BILLING_EVENT_WORKER_ID ?? `billing-worker-${process.pid}`;
  const claimLimit = getNumberEnv("BILLING_EVENT_WORKER_BATCH_SIZE", 10);
  const pollIntervalMs = getNumberEnv("BILLING_EVENT_WORKER_POLL_MS", 2000);
  const staleAfterSeconds = getNumberEnv("BILLING_EVENT_WORKER_STALE_AFTER_SECONDS", 900);

  for (;;) {
    const claimedJobs = await claimBillingEventJobs(supabase, {
      limit: claimLimit,
      staleAfterSeconds,
      workerId,
    });

    if (claimedJobs.length === 0) {
      await sleep(pollIntervalMs);
      continue;
    }

    for (const job of claimedJobs) {
      try {
        await processBillingEventJob(supabase, job);
      } catch (error) {
        // processBillingEventJob has already dead-lettered the job; log and move on.
        console.error("billing-event-worker job failed", {
          error: error instanceof Error ? error.message : error,
          jobId: job.id,
        });
      }
    }
  }
}

main().catch((error) => {
  console.error("billing-event-worker crashed", error);
  process.exit(1);
});
