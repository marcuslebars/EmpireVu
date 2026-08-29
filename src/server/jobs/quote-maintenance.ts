/**
 * Nightly quote maintenance. Run via `npm run job:quote-maintenance`
 * (Railway cron — see railway.quote-maintenance.json).
 *
 * Two sweeps, in this order and for this reason:
 *
 *   1. REMIND  quotes within 5 days of valid_until that are still unapproved
 *   2. EXPIRE  quotes already past valid_until
 *
 * Reminders run FIRST. If expiry ran first, a quote reaching its date on the same
 * night would be expired before its reminder was considered — and the customer
 * would get a "still open" nudge for a quote that had just closed, or no nudge at
 * all. Reminding first means the nudge always precedes the expiry.
 *
 * Both sweeps are idempotent and claim rows in a WHERE clause, so overlapping
 * runs (a slow night plus the next night's start) cannot double-send or
 * double-expire.
 *
 * Inert unless STRIPE_QUOTES_ENABLED=1 — the cron service can be created and
 * scheduled before the feature is switched on, and will simply no-op.
 */
import { getQuotesConfig } from "@/server/services/quotes/config";
import { sweepExpiredQuotes, sweepExpiryReminders } from "@/server/services/quotes/expiry";

async function main(): Promise<number> {
  if (!getQuotesConfig().enabled) {
    console.log("[quote-maintenance] STRIPE_QUOTES_ENABLED is not set — nothing to do.");
    return 0;
  }

  const now = new Date();
  let failures = 0;

  // Each sweep is guarded separately: a reminder failure must not stop expiry
  // from running. Letting a stale quote stay approvable is the worse outcome.
  try {
    const reminders = await sweepExpiryReminders(now);
    console.log(
      `[quote-maintenance] reminders: scanned=${reminders.scanned} sent=${reminders.reminded.length}`,
    );
  } catch (err) {
    failures += 1;
    console.error("[quote-maintenance] reminder sweep failed:", err instanceof Error ? err.message : err);
  }

  try {
    const expired = await sweepExpiredQuotes(now);
    console.log(
      `[quote-maintenance] expiry: scanned=${expired.scanned} expired=${expired.expired.length}`,
    );
  } catch (err) {
    failures += 1;
    console.error("[quote-maintenance] expiry sweep failed:", err instanceof Error ? err.message : err);
  }

  // Non-zero exit so Railway/alerting can key off a failed run.
  return failures > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[quote-maintenance] fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
