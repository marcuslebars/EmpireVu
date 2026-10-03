/**
 * Daily operator health email — preview or force-send. See docs/operator-health.md.
 *
 * The real daily send runs inside the workflow-event worker's scheduler pass (~07:30
 * BUSINESS_TIMEZONE, once per day). This CLI is for looking at the report and for sending it
 * by hand.
 *
 * SANCTIONED EXCEPTION (service role) — jobs. Cross-tenant, operator-only, aggregate; no
 * request input. Delegates to services/operator-health/service.ts.
 * Needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_BASE_URL (links); for --send
 * also RESEND_API_KEY, OUTBOUND_FROM_EMAIL and OWNER_EMAIL.
 *
 * PowerShell (note the `--` before the flags):
 *   npm run job:operator-health -- --dry-run          # print today's report (the default)
 *   npm run job:operator-health -- --dry-run --all    # …without the "+N more" caps
 *   npm run job:operator-health -- --send             # email it to OWNER_EMAIL now
 *
 * `--send` does not claim the day: the scheduled 07:30 report still goes out as usual.
 */
import { parseOperatorHealthArgs, runOperatorHealthJob } from "@/server/services/operator-health/service";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

async function main(): Promise<number> {
  const args = parseOperatorHealthArgs(process.argv.slice(2));
  const result = await runOperatorHealthJob(createSupabaseAdminClient(), args);
  console.log(`Subject: ${result.email.subject}\n`);
  console.log(result.email.text);
  console.log(
    `\n[operator-health] items=${result.report.totalItems} critical=${result.report.criticalCount} guarantee_at_risk=${result.report.guaranteeAtRisk}` +
      ` scheduled_run_would=${result.delivery}` +
      (result.sentTo ? ` SENT to ${result.sentTo}` : " (dry run — nothing sent)"),
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[operator-health] FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
