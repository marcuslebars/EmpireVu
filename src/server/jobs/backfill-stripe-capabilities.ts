/**
 * One-off: mirror every connected Stripe account's capabilities (including bank debit,
 * companies.stripe_acss_debit_enabled) onto its company row.
 *
 * Run right after migration 20261006140000_stripe_bank_debit_capability: the new column
 * starts false, so brands already offering bank debit would lose it until Stripe's next
 * account.updated webhook.
 *
 *   npm run job:backfill-stripe-capabilities            # dry run: report what would change
 *   npm run job:backfill-stripe-capabilities -- --apply # write
 *
 * Idempotent (it copies Stripe's current state), and only READS from Stripe.
 * Service-role: runs outside any request, across every organization.
 */
import { backfillConnectedAccountCapabilities } from "@/server/services/quotes/connect";

const APPLY = process.argv.includes("--apply");
const tag = `[backfill-stripe-capabilities]${APPLY ? "" : " (dry run)"}`;

async function main(): Promise<number> {
  const result = await backfillConnectedAccountCapabilities({ apply: APPLY });
  console.log(`${tag} checked ${result.checked} connected account${result.checked === 1 ? "" : "s"}.`);
  for (const c of result.changed) {
    console.log(`${tag} ${c.name ?? c.companyId}: bank debit ${c.acssDebit ? "ON" : "off"}${APPLY ? "" : " (would set)"}`);
  }
  for (const f of result.failed) console.error(`${tag} ${f.name ?? f.companyId}: failed — ${f.reason}`);
  if (!APPLY && result.changed.length) console.log(`${tag} re-run with --apply to write these.`);
  return result.failed.length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`${tag} fatal:`, err instanceof Error ? err.message : err);
    process.exit(1);
  });
