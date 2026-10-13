/**
 * Everdoer rebrand: re-point OUR Twilio numbers from the old platform hosts to the new one
 * (job:twilio-repoint; REBRAND_PLAN.md §2 "Twilio numbers: voice", PR 4 checklist).
 *
 * Scope, deliberately narrow:
 *   - only numbers whose FriendlyName is one of our tags ("EmpireVu|Everdoer catcher|line <id>");
 *     anything else (A1's hand-set numbers, the platform number, tenant numbers) is listed as
 *     untouched and never written;
 *   - only the URL fields VoiceUrl, VoiceFallbackUrl, SmsUrl, SmsFallbackUrl, StatusCallback;
 *   - only when the URL's host is an OLD platform host (app.empirevu.com, api.empirevu.com,
 *     app.crankleads.com), and then ONLY the host changes: scheme, userinfo, port, path and query
 *     are kept byte for byte;
 *   - methods, numbers, forwarding, SIP / trunk / application SIDs are never written.
 * Dry run unless --apply.
 */
import { isNewPlatformHost, isOldPlatformHost } from "@/server/services/rebrand/platform-hosts";
import { parseTwilioTag } from "@/server/services/twilio/friendly-name";
import {
  TWILIO_NUMBER_URL_FIELDS,
  type TwilioAccountNumber,
  type TwilioAccountNumbersClient,
  type TwilioNumberUrlField,
} from "@/server/services/twilio/provision";

export interface RepointChange {
  sid: string;
  phoneNumber: string;
  field: TwilioNumberUrlField;
  formField: string;
  from: string;
  to: string;
}

export interface UntouchedOldHost {
  phoneNumber: string;
  friendlyName: string | null;
  field: TwilioNumberUrlField;
  url: string;
}

export interface RepointPlan {
  changes: RepointChange[];
  /** Numbers we may NOT touch (no tag of ours) that still point at an old host: re-point by hand. */
  untouched: UntouchedOldHost[];
  considered: number;
}

const URL_PARTS = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#]*)([\s\S]*)$/;

/**
 * Replace ONLY the hostname of `url` with `targetHost` when it is an old platform host; null when
 * it isn't (or the URL can't be parsed). Everything else is kept byte for byte. PURE.
 */
export function swapOldHost(url: string | null | undefined, targetHost: string): string | null {
  if (!url) return null;
  const m = URL_PARTS.exec(url);
  if (!m) return null;
  const [, scheme, authority, rest] = m;
  const at = authority.lastIndexOf("@");
  const userinfo = at >= 0 ? authority.slice(0, at + 1) : "";
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
  const pm = /^(.*?)(:\d+)?$/.exec(hostPort);
  const hostname = pm?.[1] ?? hostPort;
  const port = pm?.[2] ?? "";
  if (!isOldPlatformHost(hostname)) return null;
  return `${scheme}${userinfo}${targetHost}${port}${rest}`;
}

/**
 * The target host from `--to` (or EVERDOER_APP_BASE_URL). Must be an https origin with no path or
 * query, and not an old host. Throws a plain Error with the reason.
 */
export function resolveRepointTarget(to: string | null | undefined, env: Record<string, string | undefined> = process.env): { origin: string; host: string; known: boolean } {
  const raw = to?.trim() || env.EVERDOER_APP_BASE_URL?.trim();
  if (!raw) throw new Error("--to https://app.everdoer.com is required (or set EVERDOER_APP_BASE_URL).");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`--to ${raw} is not a URL.`);
  }
  if (u.protocol !== "https:") throw new Error(`--to must be https (got ${u.protocol}).`);
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash || u.username || u.password) {
    throw new Error(`--to must be an origin only, like https://app.everdoer.com (got ${raw}).`);
  }
  if (isOldPlatformHost(u.host)) throw new Error(`--to ${u.host} is an OLD host; the target must be the new one.`);
  return { origin: u.origin, host: u.host, known: isNewPlatformHost(u.host) };
}

/** Plan the re-point over the account's numbers. PURE. */
export function planTwilioRepoint(numbers: TwilioAccountNumber[], targetHost: string, only?: string | null): RepointPlan {
  const changes: RepointChange[] = [];
  const untouched: UntouchedOldHost[] = [];
  let considered = 0;
  for (const n of numbers) {
    if (only && n.phone_number !== only) continue;
    const ours = parseTwilioTag(n.friendly_name) !== null;
    if (ours) considered += 1;
    for (const field of Object.keys(TWILIO_NUMBER_URL_FIELDS) as TwilioNumberUrlField[]) {
      const from = n[field];
      const to = swapOldHost(from, targetHost);
      if (!from || !to) continue;
      if (ours) {
        changes.push({ sid: n.sid, phoneNumber: n.phone_number, field, formField: TWILIO_NUMBER_URL_FIELDS[field], from, to });
      } else {
        untouched.push({ phoneNumber: n.phone_number, friendlyName: n.friendly_name ?? null, field, url: from });
      }
    }
  }
  return { changes, untouched, considered };
}

export function formatRepointPlan(plan: RepointPlan): string {
  const lines: string[] = [];
  if (plan.changes.length === 0) {
    lines.push(`No tagged number points at an old host (${plan.considered} tagged number(s) checked).`);
  } else {
    lines.push("number\tfield\tfrom\tto");
    for (const c of plan.changes) lines.push(`${c.phoneNumber}\t${c.formField}\t${c.from}\t${c.to}`);
  }
  if (plan.untouched.length > 0) {
    lines.push("", "NOT touched (no Everdoer/EmpireVu tag: hand-set numbers, re-point by hand per the checklist):");
    for (const u of plan.untouched) lines.push(`${u.phoneNumber}\t${u.friendlyName ?? "-"}\t${TWILIO_NUMBER_URL_FIELDS[u.field]}\t${u.url}`);
  }
  return lines.join("\n");
}

export interface RepointArgs {
  apply: boolean;
  to: string | null;
  only: string | null;
}

export function parseRepointArgs(argv: string[]): RepointArgs {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
  };
  return { apply: argv.includes("--apply"), to: value("--to"), only: value("--only") };
}

export interface RepointResult {
  plan: RepointPlan;
  applied: number;
  failed: Array<{ phoneNumber: string; error: string }>;
}

/**
 * Why --apply must not run yet, or null. Our provisioning and the porting guards compare each
 * number's URLs EXACTLY against URLs built from TWILIO_WEBHOOK_BASE_URL ?? APP_BASE_URL. If that
 * base still names an old host, a re-pointed number would be flipped back by the next
 * re-provision, and a ported line's "Twilio side OK" check would fail. So the base moves first.
 */
export function repointApplyBlocker(targetHost: string, env: Record<string, string | undefined> = process.env): string | null {
  const raw = (env.TWILIO_WEBHOOK_BASE_URL?.trim() || env.APP_BASE_URL?.trim()) ?? "";
  let host: string | null = null;
  try {
    host = raw ? new URL(raw).host : null;
  } catch {
    host = null;
  }
  if (!host) return "TWILIO_WEBHOOK_BASE_URL / APP_BASE_URL is not set";
  if (isOldPlatformHost(host)) return `the webhook base (TWILIO_WEBHOOK_BASE_URL ?? APP_BASE_URL) is still ${host}; switch it to ${targetHost} first`;
  if (host !== targetHost) return `the webhook base host is ${host} but the target is ${targetHost}; they must match`;
  return null;
}

/** List, plan, and (with apply) write one update per number with only its changed URL fields. */
export async function runTwilioRepoint(
  client: TwilioAccountNumbersClient,
  args: { apply: boolean; targetHost: string; only?: string | null },
): Promise<RepointResult> {
  const plan = planTwilioRepoint(await client.listAll(), args.targetHost, args.only ?? null);
  const failed: RepointResult["failed"] = [];
  let applied = 0;
  if (args.apply) {
    const bySid = new Map<string, { phoneNumber: string; fields: Record<string, string> }>();
    for (const c of plan.changes) {
      const entry = bySid.get(c.sid) ?? { phoneNumber: c.phoneNumber, fields: {} };
      entry.fields[c.formField] = c.to;
      bySid.set(c.sid, entry);
    }
    for (const [sid, entry] of bySid) {
      try {
        await client.update(sid, entry.fields);
        applied += 1;
      } catch (err) {
        failed.push({ phoneNumber: entry.phoneNumber, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return { plan, applied, failed };
}
