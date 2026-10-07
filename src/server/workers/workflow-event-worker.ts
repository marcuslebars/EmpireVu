import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { processInboundWebhookJobs } from "@/server/services/inbound-webhook-jobs";
import {
  claimWorkflowEventJobs,
  processWorkflowEventJob,
} from "@/server/services/workflow-event-jobs";
import { resumeDueWorkflowRuns, runScheduler } from "@/server/services/workflow-engine/scheduler";

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
  const schedulerIntervalMs = getNumberEnv("WORKFLOW_SCHEDULER_INTERVAL_MS", 60_000);
  let lastSchedulerRun = 0;

  for (;;) {
    const claimedJobs = await claimWorkflowEventJobs(supabase, {
      limit: claimLimit,
      staleAfterSeconds,
      workerId,
    });

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

    // Same process, same tick: drain the durable inbound-webhook queue (calls, texts).
    // processInboundWebhookJobs handles per-job success/backoff/dead-letter internally.
    let inboundProcessed = 0;
    try {
      inboundProcessed = await processInboundWebhookJobs(supabase, {
        batch: claimLimit,
        staleAfterSeconds,
        workerId,
      });
    } catch (error) {
      console.error("inbound-webhook drain failed", {
        error: error instanceof Error ? error.message : error,
      });
    }

    // Resume durable waits whose resume_at is due (Task 9).
    let resumedRuns = 0;
    try {
      resumedRuns = await resumeDueWorkflowRuns(supabase, { batch: claimLimit, staleAfterSeconds });
    } catch (error) {
      console.error("workflow resume failed", { error: error instanceof Error ? error.message : error });
    }

    // Scheduler pass on its own cadence (default every 60s): materialize + process
    // schedule.daily ticks and scan the entity-driven time triggers.
    const now = Date.now();
    if (now - lastSchedulerRun >= schedulerIntervalMs) {
      lastSchedulerRun = now;
      try {
        await runScheduler(supabase, { workerId });
      } catch (error) {
        console.error("workflow scheduler failed", { error: error instanceof Error ? error.message : error });
      }
    }

    if (claimedJobs.length === 0 && inboundProcessed === 0 && resumedRuns === 0) {
      await sleep(pollIntervalMs);
    }
  }
}

main().catch((error) => {
  console.error("workflow-event-worker crashed", error);
  process.exit(1);
});