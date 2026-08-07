import { getJobberConfig } from "@/server/services/jobber/config";
import {
  claimJobberSyncJobs,
  processJobberSyncJob,
  reconcileJobberSyncJobs,
} from "@/server/services/jobber/sync-jobs";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

// Run as a SINGLE Railway worker instance — that's the primary serialization for
// Jobber token refreshes (the refresh_lock_at DB mutex is defense-in-depth). Do not
// scale this service beyond 1 replica without confirming the lock behaviour.

function getNumberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function main(): Promise<void> {
  const cfg = getJobberConfig();
  const supabase = createSupabaseAdminClient();
  const workerId = process.env.JOBBER_SYNC_WORKER_ID ?? `jobber-sync-worker-${process.pid}`;
  const claimLimit = getNumberEnv("JOBBER_SYNC_WORKER_BATCH_SIZE", 5);
  const pollIntervalMs = getNumberEnv("JOBBER_SYNC_WORKER_POLL_MS", 3000);
  const staleAfterSeconds = getNumberEnv("JOBBER_SYNC_WORKER_STALE_AFTER_SECONDS", 900);
  const reconcileEveryMs = getNumberEnv("JOBBER_SYNC_WORKER_RECONCILE_MS", 600_000); // 10 min

  console.log(`[jobber-sync-worker] starting (JOBBER_SYNC_ENABLED=${cfg.enabled ? "1" : "0"})`);
  let lastReconcileAt = 0;

  for (;;) {
    // Periodic reconcile sweep — enqueue any winter-storage-quote/quote leads that
    // slipped past the best-effort enqueue (owner amendment). Gated by the flag.
    if (cfg.enabled && Date.now() - lastReconcileAt >= reconcileEveryMs) {
      lastReconcileAt = Date.now();
      try {
        const enqueued = await reconcileJobberSyncJobs(supabase);
        if (enqueued > 0) console.log(`[jobber-sync-worker] reconcile enqueued ${enqueued} lead(s)`);
      } catch (error) {
        console.error("[jobber-sync-worker] reconcile failed", error instanceof Error ? error.message : error);
      }
    }

    const claimedJobs = await claimJobberSyncJobs(supabase, {
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
        await processJobberSyncJob(supabase, job);
      } catch (error) {
        console.error("[jobber-sync-worker] job failed", {
          jobId: job.id,
          error: error instanceof Error ? error.message : error,
        });
      }
    }
  }
}

main().catch((error) => {
  console.error("[jobber-sync-worker] crashed", error);
  process.exit(1);
});
