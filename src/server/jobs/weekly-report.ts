/**
 * Weekly "what your front desk did" report. The scheduler sends it automatically (Monday
 * 08:00 company-local, see services/weekly-report/send.ts); this job is for previews and
 * manual (re-)sends. See docs/front-desk-ai.md → "Weekly report".
 *
 * SANCTIONED EXCEPTION (service role) — jobs. Every read/write in services/weekly-report is
 * filtered by the company's own organization_id + company_id (taken from the companies row).
 *
 * Idempotent per (company, week) via weekly_report_sends — safe to re-run. Without --week it
 * reports on the last complete Monday–Sunday week in each company's timezone; --week takes
 * any date in the week (normalized to its Monday). A manual run ignores the Monday-morning
 * window but keeps every other rule (enabled, live, quiet accounts).
 *
 * PowerShell examples (note the `--` before the flags):
 *   npm run job:weekly-report -- --dry-run
 *   npm run job:weekly-report -- --dry-run --company <companyId> --week 2026-10-05
 *   npm run job:weekly-report -- --company <companyId> --week 2026-10-05
 *   npm run job:weekly-report -- --company <companyId> --week 2026-10-05 --force   # re-send
 */
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { parseWeeklyArgs, runWeeklyReports } from "@/server/services/weekly-report/send";

async function main(): Promise<number> {
  const args = parseWeeklyArgs(process.argv.slice(2));
  const admin = createSupabaseAdminClient();
  const outcomes = await runWeeklyReports(admin, {
    dryRun: args.dryRun,
    force: args.force,
    companyId: args.companyId,
    week: args.week,
  });

  for (const outcome of outcomes) {
    console.log(
      `[weekly-report] ${outcome.result.padEnd(7)} ${outcome.week} ${outcome.companyName} (${outcome.companyId})` +
        (outcome.reason ? ` reason=${outcome.reason}` : "") +
        (outcome.emailTo ? ` email=${outcome.emailTo}` : "") +
        (outcome.smsTo ? ` sms=${outcome.smsTo}` : "") +
        (outcome.subject ? ` subject="${outcome.subject}"` : ""),
    );
    // A single-company dry run is a preview: print the text + email.
    if (args.companyId && outcome.result === "dry_run") {
      if (outcome.sms) console.log(`\n--- SMS ---\n${outcome.sms}`);
      if (outcome.email) console.log(`\n--- Email ---\n${outcome.email.text}\n`);
    }
  }

  const count = (result: string) => outcomes.filter((o) => o.result === result).length;
  console.log(
    `[weekly-report] done: sent=${count("sent")} skipped=${count("skipped")} failed=${count("failed")} dry_run=${count("dry_run")}`,
  );
  return count("failed") > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[weekly-report] fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
