/**
 * Monthly results scorecard. Run via `npm run job:monthly-scorecard`
 * (Railway cron — see railway.monthly-scorecard.json: 13:00 UTC on the 1st).
 *
 * Emails each company owner last month's scorecard — leads caught, replies sent, jobs booked,
 * and what we're tuning next. See docs/monthly-scorecard.md.
 *
 * SANCTIONED EXCEPTION (service role) — jobs. A cron run has no user session, so it uses the
 * admin client; every read/write in services/monthly-scorecard is filtered by the company's
 * own organization_id + company_id (taken from the companies row, never from input).
 *
 * Idempotent per (company, month) via monthly_scorecard_sends — safe to re-run.
 *
 * PowerShell examples (note the `--` before the flags):
 *   npm run job:monthly-scorecard -- --dry-run
 *   npm run job:monthly-scorecard -- --dry-run --company <companyId> --month 2026-09
 *   npm run job:monthly-scorecard -- --company <companyId> --month 2026-09
 *   npm run job:monthly-scorecard -- --company <companyId> --month 2026-09 --force   # re-send
 */
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { parseScorecardArgs, runMonthlyScorecards } from "@/server/services/monthly-scorecard/send";

async function main(): Promise<number> {
  const args = parseScorecardArgs(process.argv.slice(2));
  const admin = createSupabaseAdminClient();
  const outcomes = await runMonthlyScorecards(admin, {
    dryRun: args.dryRun,
    force: args.force,
    companyId: args.companyId,
    month: args.month,
  });

  for (const outcome of outcomes) {
    console.log(
      `[monthly-scorecard] ${outcome.result.padEnd(7)} ${outcome.month} ${outcome.companyName} (${outcome.companyId})` +
        (outcome.reason ? ` reason=${outcome.reason}` : "") +
        (outcome.recipient ? ` to=${outcome.recipient}` : "") +
        (outcome.subject ? ` subject="${outcome.subject}"` : ""),
    );
    // A single-company dry run is a preview: print the plain-text email.
    if (outcome.email && args.companyId) {
      console.log("\n" + outcome.email.text + "\n");
    }
  }

  const count = (result: string) => outcomes.filter((o) => o.result === result).length;
  console.log(
    `[monthly-scorecard] done: sent=${count("sent")} skipped=${count("skipped")} failed=${count("failed")} dry_run=${count("dry_run")}`,
  );
  // Non-zero exit so Railway/alerting can key off a failed send.
  return count("failed") > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[monthly-scorecard] fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
