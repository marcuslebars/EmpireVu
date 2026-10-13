/**
 * Twilio FriendlyName tags on the numbers we buy or attach (REBRAND_PLAN.md §5.2). They are the
 * ownership marker AND an exact-match idempotency key:
 *   "<Brand> catcher <companyId>"  missed-call catcher / done-for-you numbers (twilio/provision.ts)
 *   "<Brand> line <companyId>"     a ported business line (staff/porting/completion.ts)
 *
 * Everdoer rebrand, PR 1: READERS recognise both the old "EmpireVu " and the new "Everdoer "
 * prefix (an idempotency lookup that missed an old tag would buy a second number, which costs
 * money); WRITERS use the old prefix until EVERDOER_WRITE_NEW_NAMES is on. Each old-tag match
 * is counted as legacy_usage twilio_tag/"EmpireVu catcher" | "EmpireVu line".
 * job:twilio-retag renames old tags once the flag is on.
 */
import { noteLegacyUsage } from "@/server/services/rebrand/legacy-usage";
import { writeNewNames } from "@/server/services/rebrand/write-names";

export type TwilioTagKind = "catcher" | "line";

const NEW_BRAND = "Everdoer";
// Rebrand shim (remove in PR 8 once legacy_usage shows no twilio_tag/EmpireVu catcher or twilio_tag/EmpireVu line for 30 days)
const OLD_BRAND = "EmpireVu";

function prefix(brand: string, kind: TwilioTagKind): string {
  return `${brand} ${kind} `;
}

/** "EmpireVu catcher " etc. Exported for the jobs and tests. */
export const TWILIO_TAG_PREFIXES = {
  new: { catcher: prefix(NEW_BRAND, "catcher"), line: prefix(NEW_BRAND, "line") },
  old: { catcher: prefix(OLD_BRAND, "catcher"), line: prefix(OLD_BRAND, "line") },
} as const;

/** The tag we WRITE for this company (old prefix until EVERDOER_WRITE_NEW_NAMES is on). */
export function twilioTagForWrite(kind: TwilioTagKind, companyId: string, env: Record<string, string | undefined> = process.env): string {
  return `${writeNewNames(env) ? TWILIO_TAG_PREFIXES.new[kind] : TWILIO_TAG_PREFIXES.old[kind]}${companyId}`;
}

/** Every tag a reader must recognise for this company, the new one first. */
export function twilioTagCandidates(kind: TwilioTagKind, companyId: string): [string, string] {
  return [`${TWILIO_TAG_PREFIXES.new[kind]}${companyId}`, `${TWILIO_TAG_PREFIXES.old[kind]}${companyId}`];
}

export interface ParsedTwilioTag {
  kind: TwilioTagKind;
  /** Whatever follows the prefix (may be empty for a malformed tag). */
  companyId: string;
  legacy: boolean;
}

/** Parse a FriendlyName as one of our tags, or null when it isn't one. PURE (never counts). */
export function parseTwilioTag(friendlyName: string | null | undefined): ParsedTwilioTag | null {
  const tag = friendlyName ?? "";
  for (const legacy of [false, true]) {
    const set = legacy ? TWILIO_TAG_PREFIXES.old : TWILIO_TAG_PREFIXES.new;
    for (const kind of ["catcher", "line"] as const) {
      if (tag.startsWith(set[kind])) return { kind, companyId: tag.slice(set[kind].length), legacy };
    }
  }
  return null;
}

/**
 * Parse a FriendlyName on a READ path, counting an old-prefix tag (twilio_tag). Use this where the
 * tag decides something (ownership, idempotency, porting guards).
 */
export function readTwilioTag(friendlyName: string | null | undefined): ParsedTwilioTag | null {
  const parsed = parseTwilioTag(friendlyName);
  if (parsed?.legacy) noteLegacyUsage("twilio_tag", TWILIO_TAG_PREFIXES.old[parsed.kind].trim(), null);
  return parsed;
}

/** Is this FriendlyName our `kind` tag for exactly this company (either prefix)? Counts old tags. */
export function isTwilioTagFor(friendlyName: string | null | undefined, kind: TwilioTagKind, companyId: string): boolean {
  const parsed = readTwilioTag(friendlyName);
  return parsed !== null && parsed.kind === kind && parsed.companyId === companyId;
}

/** The new-prefix name for an old-prefix tag (job:twilio-retag), or null when nothing to rename. */
export function retaggedFriendlyName(friendlyName: string | null | undefined): string | null {
  const parsed = parseTwilioTag(friendlyName);
  if (!parsed?.legacy) return null;
  return `${TWILIO_TAG_PREFIXES.new[parsed.kind]}${parsed.companyId}`;
}
