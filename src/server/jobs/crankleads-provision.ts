/**
 * Re-run CrankLeads provisioning for one purchase. See docs/crankleads-purchase.md.
 *
 * SANCTIONED EXCEPTION (service role) — jobs. Delegates to services/crankleads/rerun.ts.
 * Needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY), RESEND_API_KEY,
 * OUTBOUND_FROM_EMAIL, APP_BASE_URL (+ OWNER_EMAIL for the operator copy, and
 * STRIPE_SECRET_KEY only when the purchase never got its webhook).
 *
 * PowerShell (note the `--` before the flags):
 *   npm run job:crankleads-provision -- --session cs_test_a1B2c3...
 *   npm run job:crankleads-provision -- --stuck [--older-than-minutes 15]
 *
 * `--stuck` is the safety-net sweep, deployed as a Railway cron every 15 minutes
 * (railway.crankleads-sweep.json). It needs STRIPE_SECRET_KEY.
 */
import {
  parseProvisionJobArgs,
  runCrankleadsProvisionJob,
  runStuckPurchaseSweep,
} from "@/server/services/crankleads/rerun";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

async function main(): Promise<number> {
  const args = parseProvisionJobArgs(process.argv.slice(2));
  if (args.stuck) {
    const items = await runStuckPurchaseSweep(createSupabaseAdminClient(), { olderThanMinutes: args.olderThanMinutes });
    for (const item of items) {
      console.log(
        `[crankleads-sweep] ${item.outcome} purchase=${item.purchaseId} session=${item.sessionId ?? "-"} was=${item.status} — ${item.detail}`,
      );
    }
    console.log(`[crankleads-sweep] checked ${items.length} stuck purchase(s)`);
    return items.some((i) => i.outcome === "failed") ? 1 : 0;
  }
  const result = await runCrankleadsProvisionJob(createSupabaseAdminClient(), args);
  console.log(
    `[crankleads-provision] ${result.outcome} session=${args.sessionId} org=${result.organizationId ?? "-"} — ${result.detail}`,
  );
  return result.outcome === "provisioned" || result.outcome === "already_provisioned" ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[crankleads-provision] FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
