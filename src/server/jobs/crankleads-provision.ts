/**
 * Re-run CrankLeads provisioning for one purchase. See docs/crankleads-purchase.md.
 *
 * SANCTIONED EXCEPTION (service role) — jobs. Delegates to services/crankleads/rerun.ts.
 * Needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY,
 * OUTBOUND_FROM_EMAIL, APP_BASE_URL (+ OWNER_EMAIL for the operator copy, and
 * STRIPE_SECRET_KEY only when the purchase never got its webhook).
 *
 * PowerShell (note the `--` before the flags):
 *   npm run job:crankleads-provision -- --session cs_test_a1B2c3...
 */
import { parseProvisionJobArgs, runCrankleadsProvisionJob } from "@/server/services/crankleads/rerun";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

async function main(): Promise<number> {
  const args = parseProvisionJobArgs(process.argv.slice(2));
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
