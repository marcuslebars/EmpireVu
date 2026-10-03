/**
 * The durable Postgres job queues, described once. Used by `/api/health` (Railway probe:
 * queued count + last claim per queue) and by the daily operator health email
 * (services/operator-health: failed jobs in the last 24h + oldest ready-but-unclaimed job).
 *
 * Every queue has the same shape: status 'pending' = queued, a "ready at" column (the job may
 * not be claimed before it), a "last claimed" column, and one or more terminal failure statuses
 * (jobber_sync dead-letters to 'manual_review' instead of 'failed').
 */
export interface QueueTableSpec {
  table: string;
  /** Newest claim timestamp column (`locked_at` older queues, `claimed_at` inbound webhooks). */
  claimedColumn: string;
  /** The job is claimable once this time has passed (`available_at` / `run_at`). */
  readyColumn: string;
  /** Terminal (dead-letter) statuses. */
  failedStatuses: readonly string[];
  /** Human label for the operator email. */
  label: string;
  /** The Railway service that drains it (railway.*.json). */
  service: string;
}

export const QUEUE_TABLES = {
  workflow_events: {
    table: "workflow_event_jobs",
    claimedColumn: "locked_at",
    readyColumn: "available_at",
    failedStatuses: ["failed"],
    label: "Workflow events",
    service: "worker (npm run worker:workflow-events)",
  },
  billing_events: {
    table: "billing_event_jobs",
    claimedColumn: "locked_at",
    readyColumn: "available_at",
    failedStatuses: ["failed"],
    label: "Billing events",
    service: "billing-worker (npm run worker:billing-events)",
  },
  jobber_sync: {
    table: "jobber_sync_jobs",
    claimedColumn: "locked_at",
    readyColumn: "available_at",
    failedStatuses: ["failed", "manual_review"],
    label: "Jobber sync",
    service: "jobber-sync (npm run worker:jobber-sync)",
  },
  inbound_webhooks: {
    table: "inbound_webhook_jobs",
    claimedColumn: "claimed_at",
    readyColumn: "run_at",
    failedStatuses: ["failed"],
    label: "Inbound webhooks (calls, texts, Jobber)",
    service: "worker (npm run worker:workflow-events)",
  },
} as const satisfies Record<string, QueueTableSpec>;

export type QueueKey = keyof typeof QUEUE_TABLES;

export const QUEUE_KEYS = Object.keys(QUEUE_TABLES) as QueueKey[];
