/**
 * Everdoer rebrand: re-point OUR tagged Twilio numbers from the old platform hosts to the new one
 * (src/server/services/rebrand/twilio-repoint.ts has the rules). Dry run unless --apply.
 *
 *   npm run job:twilio-repoint -- --to https://app.everdoer.com                       # plan (table)
 *   npm run job:twilio-repoint -- --to https://app.everdoer.com --only +17055550100   # one number
 *   npm run job:twilio-repoint -- --to https://app.everdoer.com --apply               # write it
 *
 * --to may be omitted when EVERDOER_APP_BASE_URL is set. Needs TWILIO_ACCOUNT_SID +
 * TWILIO_AUTH_TOKEN. Only numbers tagged "EmpireVu|Everdoer catcher|line <id>" are touched; every
 * other number that still points at an old host is listed for re-pointing by hand.
 */
import { flushLegacyUsage } from "@/server/services/rebrand/legacy-usage";
import { formatRepointPlan, parseRepointArgs, repointApplyBlocker, resolveRepointTarget, runTwilioRepoint } from "@/server/services/rebrand/twilio-repoint";
import { createTwilioAccountNumbersClient, getTwilioCredentials } from "@/server/services/twilio/provision";

async function main(): Promise<number> {
  const args = parseRepointArgs(process.argv.slice(2));
  const target = resolveRepointTarget(args.to);
  if (!target.known) console.warn(`[twilio-repoint] note: ${target.host} is not one of the known Everdoer hosts.`);
  const blocker = args.apply ? repointApplyBlocker(target.host) : null;
  if (blocker) {
    console.error(`[twilio-repoint] refusing --apply: ${blocker}. (The dry run works any time.)`);
    return 1;
  }
  const creds = getTwilioCredentials();
  if (!creds) {
    console.error("[twilio-repoint] TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required.");
    return 1;
  }
  const result = await runTwilioRepoint(createTwilioAccountNumbersClient(creds), { apply: args.apply, targetHost: target.host, only: args.only });
  console.log(formatRepointPlan(result.plan));
  if (!args.apply) {
    console.log(`\n(dry run — ${result.plan.changes.length} change(s); pass --apply to write them)`);
    return 0;
  }
  console.log(`\nUpdated ${result.applied} number(s).`);
  for (const f of result.failed) console.error(`[twilio-repoint] FAILED ${f.phoneNumber}: ${f.error}`);
  return result.failed.length > 0 ? 1 : 0;
}

main()
  .catch((err) => {
    console.error("[twilio-repoint] FAILED:", err instanceof Error ? err.message : err);
    return 1;
  })
  .then(async (code) => {
    await flushLegacyUsage();
    process.exit(code);
  });
