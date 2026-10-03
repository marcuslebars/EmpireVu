/**
 * A billing event that cannot be applied YET but will be soon — e.g. a CrankLeads
 * subscription/invoice event for a Stripe customer whose organization is still being
 * provisioned from checkout.session.completed. The processor answers it by re-queueing the
 * job with bounded backoff (billing_event_jobs.attempt_count / max_attempts) instead of
 * dead-lettering it. Once the attempts run out it dead-letters like any other failure —
 * the ledger row is never discarded.
 */
export class DeferBillingEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeferBillingEventError";
  }
}

/** Backoff for the Nth attempt (1-based): 30s, 60s, 120s, 240s … capped at 10 minutes. */
export function billingRetryDelaySeconds(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(30 * 2 ** (n - 1), 600);
}
