/**
 * Everdoer rebrand: rename our Twilio FriendlyName tags "EmpireVu catcher|line <id>" →
 * "Everdoer catcher|line <id>" (src/server/services/rebrand/twilio-retag.ts). Dry run unless
 * --apply; --apply is refused unless EVERDOER_WRITE_NEW_NAMES is on.
 *
 *   npm run job:twilio-retag                              # plan
 *   npm run job:twilio-retag -- --only +17055550100       # one number
 *   npm run job:twilio-retag -- --apply                   # write it
 */
import { flushLegacyUsage } from "@/server/services/rebrand/legacy-usage";
import { formatRetagPlan, runTwilioRetag } from "@/server/services/rebrand/twilio-retag";
import { parseRepointArgs } from "@/server/services/rebrand/twilio-repoint";
import { createTwilioAccountNumbersClient, getTwilioCredentials } from "@/server/services/twilio/provision";

async function main(): Promise<number> {
  const args = parseRepointArgs(process.argv.slice(2));
  const creds = getTwilioCredentials();
  if (!creds) {
    console.error("[twilio-retag] TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required.");
    return 1;
  }
  const result = await runTwilioRetag(createTwilioAccountNumbersClient(creds), { apply: args.apply, only: args.only });
  console.log(formatRetagPlan(result.changes));
  if (!args.apply) {
    console.log(`\n(dry run — ${result.changes.length} rename(s); pass --apply to write them)`);
    return 0;
  }
  console.log(`\nRenamed ${result.applied} number(s).`);
  for (const f of result.failed) console.error(`[twilio-retag] FAILED ${f.phoneNumber}: ${f.error}`);
  return result.failed.length > 0 ? 1 : 0;
}

main()
  .catch((err) => {
    console.error("[twilio-retag] FAILED:", err instanceof Error ? err.message : err);
    return 1;
  })
  .then(async (code) => {
    await flushLegacyUsage();
    process.exit(code);
  });
