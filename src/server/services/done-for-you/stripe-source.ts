/**
 * Stripe `metadata.source` on done-for-you (CrankLeads → Everdoer) Checkout Sessions and the
 * Subscriptions / Invoices they create (REBRAND_PLAN.md §5.2).
 *
 * Everdoer rebrand, PR 1:
 *   - READERS accept the set {"crankleads", "everdoer"}. Every live subscription and invoice
 *     today carries "crankleads", and Stripe metadata only changes if we rewrite it, so the read
 *     side can't be dropped until a backfill has rewritten the live objects (PR 4's checklist).
 *   - The WRITER (new Checkout Sessions + their subscription_data) uses "everdoer" only when
 *     EVERDOER_WRITE_NEW_NAMES is on.
 *   - Counting: a read of "crankleads" is NOT counted. It would count every renewal of every
 *     existing subscription forever and say nothing about whether the shim can go. Instead each
 *     NEW object written with the old value is counted (stripe_metadata/source=crankleads): zero
 *     for 30 days means nothing new carries it; the backfill then covers the rest.
 */
import { DONE_FOR_YOU_SOURCE } from "@/server/services/done-for-you/config";
import { noteLegacyUsage } from "@/server/services/rebrand/legacy-usage";
import { writeNewNames } from "@/server/services/rebrand/write-names";

export const EVERDOER_STRIPE_SOURCE = "everdoer";
// Rebrand shim (remove in PR 8 once legacy_usage shows no stripe_metadata/source=crankleads for 30 days AND the PR 4 metadata backfill has run)
export const LEGACY_STRIPE_SOURCE = DONE_FOR_YOU_SOURCE;

/** Every `metadata.source` value that marks a done-for-you purchase. */
export const DONE_FOR_YOU_STRIPE_SOURCES: ReadonlySet<string> = new Set([EVERDOER_STRIPE_SOURCE, LEGACY_STRIPE_SOURCE]);

/** Does this `metadata.source` mark a done-for-you purchase (old or new value)? PURE. */
export function isDoneForYouStripeSource(value: unknown): boolean {
  return typeof value === "string" && DONE_FOR_YOU_STRIPE_SOURCES.has(value);
}

/**
 * The `metadata.source` to stamp on a NEW Checkout Session (and its subscription). Counts the
 * old value as legacy usage, so the logs show when the flag is on everywhere.
 */
export function stripeSourceForWrite(env: Record<string, string | undefined> = process.env): string {
  if (writeNewNames(env)) return EVERDOER_STRIPE_SOURCE;
  noteLegacyUsage("stripe_metadata", `source=${LEGACY_STRIPE_SOURCE}`, "checkout.sessions.create");
  return LEGACY_STRIPE_SOURCE;
}
