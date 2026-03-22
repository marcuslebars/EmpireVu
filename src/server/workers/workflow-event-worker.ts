import { createSupabaseAdminClient } from "@/server/supabase/admin";
import {
  claimWorkflowEventJobs,
  processWorkflowEventJob,
} from "@/server/services/workflow-event-jobs";

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

async function main(): Promise<void> {
  const supabase = createSupabaseAdminClient();
  const workerId = process.env.WORKFLOW_EVENT_WORKER_ID ?? `workflow-worker-${process.pid}`;
  const claimLimit = getNumberEnv("WORKFLOW_EVENT_WORKER_BATCH_SIZE", 10);
  const pollIntervalMs = getNumberEnv("WORKFLOW_EVENT_WORKER_POLL_MS", 2000);
  const staleAfterSeconds = getNumberEnv("WORKFLOW_EVENT_WORKER_STALE_AFTER_SECONDS", 900);

  for (;;) {
    const claimedJobs = await claimWorkflowEventJobs(supabase, {
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
        await processWorkflowEventJob(supabase, job);
      } catch (error) {
        console.error("workflow-event-worker job failed", {
          error: error instanceof Error ? error.message : error,
          jobId: job.id,
        });
      }
    }
  }
}

main().catch((error) => {
  console.error("workflow-event-worker crashed", error);
  process.exit(1);
});