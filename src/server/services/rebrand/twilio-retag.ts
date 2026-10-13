/**
 * Everdoer rebrand: rename our Twilio FriendlyName tags (job:twilio-retag)
 *   "EmpireVu catcher <id>" → "Everdoer catcher <id>"
 *   "EmpireVu line <id>"    → "Everdoer line <id>"
 * Only FriendlyName is written; only numbers carrying an old tag of ours are touched.
 *
 * --apply is refused unless EVERDOER_WRITE_NEW_NAMES is on: with it off, provisioning would keep
 * writing (and re-writing) the old tags, so retagging would be undone and new purchases would be
 * tagged the old way. Readers accept both prefixes either way (twilio/friendly-name.ts).
 */
import { writeNewNames } from "@/server/services/rebrand/write-names";
import { retaggedFriendlyName } from "@/server/services/twilio/friendly-name";
import type { TwilioAccountNumber, TwilioAccountNumbersClient } from "@/server/services/twilio/provision";

export interface RetagChange {
  sid: string;
  phoneNumber: string;
  from: string;
  to: string;
}

/** PURE. */
export function planTwilioRetag(numbers: TwilioAccountNumber[], only?: string | null): RetagChange[] {
  const out: RetagChange[] = [];
  for (const n of numbers) {
    if (only && n.phone_number !== only) continue;
    const to = retaggedFriendlyName(n.friendly_name);
    if (to && n.friendly_name) out.push({ sid: n.sid, phoneNumber: n.phone_number, from: n.friendly_name, to });
  }
  return out;
}

export function formatRetagPlan(changes: RetagChange[]): string {
  if (changes.length === 0) return "No number carries an old EmpireVu tag.";
  return ["number\tfrom\tto", ...changes.map((c) => `${c.phoneNumber}\t${c.from}\t${c.to}`)].join("\n");
}

export class RetagRefusedError extends Error {
  constructor() {
    super("Refusing --apply: EVERDOER_WRITE_NEW_NAMES is not on, so new purchases would keep making old tags. Turn it on (every service) first.");
    this.name = "RetagRefusedError";
  }
}

export interface RetagResult {
  changes: RetagChange[];
  applied: number;
  failed: Array<{ phoneNumber: string; error: string }>;
}

export async function runTwilioRetag(
  client: TwilioAccountNumbersClient,
  args: { apply: boolean; only?: string | null },
  env: Record<string, string | undefined> = process.env,
): Promise<RetagResult> {
  if (args.apply && !writeNewNames(env)) throw new RetagRefusedError();
  const changes = planTwilioRetag(await client.listAll(), args.only ?? null);
  const failed: RetagResult["failed"] = [];
  let applied = 0;
  if (args.apply) {
    for (const c of changes) {
      try {
        await client.update(c.sid, { FriendlyName: c.to });
        applied += 1;
      } catch (err) {
        failed.push({ phoneNumber: c.phoneNumber, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return { changes, applied, failed };
}
