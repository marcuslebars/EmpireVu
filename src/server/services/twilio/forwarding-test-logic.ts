/**
 * Forwarding verification — the PURE parts (docs/missed-call-catcher.md → "Forwarding
 * verification"): outcome state machine, forwarded-leg detection, owner rate limits, calling
 * hours, scheduled-retest selection and the owner messages. No I/O here; everything is
 * unit/golden-tested in src/test/forwarding-test-logic.test.ts. The service that talks to
 * Twilio and the DB is forwarding-test.ts.
 */
import { buildForwardingInstructions, prettyPhone } from "@/lib/carrier-forwarding";
import { normalizePhoneLast10 } from "@/server/services/lead-intake/matching";

// ── Tunables (behaviour, not prices) ─────────────────────────────────────────

/** How long Twilio lets the business line ring. Conditional "no answer" forwarding kicks in
 *  after ~15–30 s on most carriers (GSM **61 allows up to 30 s), so 40 s covers the slowest
 *  setting plus call setup. */
export const TEST_RING_TIMEOUT_SECONDS = 40;
/** The forwarded leg must reach the catcher number within this long of the test starting
 *  (live check in the voice webhook, which decides between <Hangup/> and the greeting). */
export const TEST_DETECT_WINDOW_MS = 3 * 60_000;
/** The worker may process the forwarded-leg job late (queue backlog / retries). It still
 *  matches tests that STARTED within this window — and 'passed' wins over any outcome. */
export const TEST_LATE_MATCH_WINDOW_MS = 30 * 60_000;
/** After the final call status arrives, wait this long for a forwarded leg / AMD result
 *  before deciding the outcome (the leg's job may still be in the queue). */
export const TEST_FINALIZE_GRACE_MS = 45_000;
/** A test still 'calling' this long after it started never got its status callback. */
export const TEST_STALE_MS = 5 * 60_000;

/** Owner-triggered tests per company: one per 2 minutes, ten per rolling 24 h. */
export const OWNER_TEST_MIN_INTERVAL_MS = 2 * 60_000;
export const OWNER_TEST_DAILY_LIMIT = 10;

/** Never place a test call outside 08:00–21:00 in the company's timezone. */
export const CALL_WINDOW_START_HOUR = 8;
export const CALL_WINDOW_END_HOUR = 21;

/** Scheduled retests: weekdays, 10:00–16:00 local, each number at its own minute. */
export const RETEST_WINDOW_START_HOUR = 10;
export const RETEST_WINDOW_END_HOUR = 16;
export const VERIFIED_RETEST_INTERVAL_MS = 7 * 24 * 3_600_000;
export const UNVERIFIED_RETEST_INTERVAL_MS = 20 * 3_600_000;
export const UNVERIFIED_RETEST_PERIOD_MS = 14 * 24 * 3_600_000;
export const UNVERIFIED_MAX_SCHEDULED_ATTEMPTS = 5;
/** Give the owner time to set forwarding up before the first automatic test. */
export const NEW_NUMBER_GRACE_MS = 2 * 3_600_000;
/** Cap per scheduler pass (one pass per minute) — spreads cost and load. */
export const MAX_SCHEDULED_TESTS_PER_PASS = 10;

// ── State machine ────────────────────────────────────────────────────────────

export type ForwardingTestOutcome = "passed" | "answered" | "not_forwarded" | "failed";
export type ForwardingTestStatus = "calling" | ForwardingTestOutcome;
export type ForwardingTestTrigger = "owner" | "scheduled";

const TERMINAL_CALL_STATUSES = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);

export function isTerminalCallStatus(status: string | null | undefined): boolean {
  return TERMINAL_CALL_STATUSES.has((status ?? "").toLowerCase());
}

/** Twilio AnsweredBy values that mean a machine (voicemail) took the call. */
export function answeredByMachine(answeredBy: string | null | undefined): boolean {
  const value = (answeredBy ?? "").toLowerCase();
  return value.startsWith("machine") || value === "fax";
}

/**
 * The outcome of a test from what we know about its outbound call:
 *   • a forwarded leg reached the catcher number → passed (whatever the outbound leg says —
 *     when forwarding works, the outbound call is "answered" by our own catcher);
 *   • completed (answered) by a machine → not_forwarded (voicemail picked up before forwarding);
 *   • completed by a person / unknown → answered (inconclusive — ask to retry without answering);
 *   • busy / no-answer → not_forwarded (rang out, nothing forwarded);
 *   • failed / canceled → failed (Twilio error, invalid number, …);
 *   • anything else (queued / ringing / in-progress / no status) → null (not decided yet).
 */
export function outcomeFromCall(input: {
  callStatus: string | null | undefined;
  answeredBy: string | null | undefined;
  forwardedLegSeen: boolean;
}): ForwardingTestOutcome | null {
  if (input.forwardedLegSeen) return "passed";
  const status = (input.callStatus ?? "").toLowerCase();
  if (status === "completed") return answeredByMachine(input.answeredBy) ? "not_forwarded" : "answered";
  if (status === "busy" || status === "no-answer") return "not_forwarded";
  if (status === "failed" || status === "canceled") return "failed";
  return null;
}

/**
 * The next stored status, or null for "no change". 'passed' is sticky and always wins (a
 * forwarded leg processed late upgrades an earlier failure); otherwise only an in-flight
 * ('calling') test takes an outcome — the first decision stands.
 */
export function nextTestStatus(current: ForwardingTestStatus, outcome: ForwardingTestOutcome): ForwardingTestStatus | null {
  if (current === "passed") return null;
  if (outcome === "passed") return "passed";
  return current === "calling" ? outcome : null;
}

export interface VerificationPatch {
  forwarding_last_test_at: string;
  forwarding_last_test_result: ForwardingTestOutcome;
  forwarding_verified_at?: string | null;
}

/**
 * voice_numbers update for an outcome. passed → verified now; not_forwarded / failed →
 * verification CLEARED (null); answered → inconclusive, verification left as it was.
 */
export function verificationPatch(outcome: ForwardingTestOutcome, nowIso: string): VerificationPatch {
  const base = { forwarding_last_test_at: nowIso, forwarding_last_test_result: outcome };
  if (outcome === "passed") return { ...base, forwarding_verified_at: nowIso };
  if (outcome === "answered") return base;
  return { ...base, forwarding_verified_at: null };
}

// ── Detection (the forwarded leg) ────────────────────────────────────────────

export interface TestCandidate {
  id: string;
  status: string;
  started_at: string;
  caller_id: string;
  business_line: string;
  catcher_number: string;
}

export interface InboundLeg {
  from: string | null;
  to: string | null;
  forwardedFrom: string | null;
}

const same10 = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const x = normalizePhoneLast10(a);
  return x !== null && x === normalizePhoneLast10(b);
};

/**
 * Is this inbound call on a catcher number the forwarded leg of one of these tests?
 * It must reach the test's catcher number, inside the window after the test started, and
 * carry one of the test's fingerprints:
 *   • From == the test caller ID (most carriers keep the original caller on a forward), or
 *   • From == the business line (carriers that rewrite caller ID to the forwarding line), or
 *   • ForwardedFrom == the business line (when the carrier passes the diversion header).
 * `inFlightOnly` (the live webhook) also requires the test to still be 'calling'; the
 * worker matches finished tests too, so a late leg still upgrades the result to passed.
 * Returns the most recently started match.
 */
export function matchForwardingTest(
  candidates: readonly TestCandidate[],
  leg: InboundLeg,
  nowMs: number,
  options: { windowMs: number; inFlightOnly: boolean },
): TestCandidate | null {
  const matches = candidates.filter((test) => {
    if (options.inFlightOnly && test.status !== "calling") return false;
    if (!same10(leg.to, test.catcher_number)) return false;
    const started = Date.parse(test.started_at);
    if (!Number.isFinite(started)) return false;
    if (started > nowMs + 5_000 || nowMs - started > options.windowMs) return false;
    return (
      same10(leg.from, test.caller_id) || same10(leg.from, test.business_line) || same10(leg.forwardedFrom, test.business_line)
    );
  });
  matches.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  return matches[0] ?? null;
}

// ── Guards ───────────────────────────────────────────────────────────────────

export type RateLimitDecision = { ok: true } | { ok: false; reason: string; retryAfterSeconds: number };

/** Owner-triggered test limits from the company's recent owner tests (created_at ISO). */
export function checkOwnerTestRateLimit(recentOwnerTests: ReadonlyArray<{ created_at: string }>, nowMs: number): RateLimitDecision {
  const times = recentOwnerTests
    .map((t) => Date.parse(t.created_at))
    .filter((t) => Number.isFinite(t) && t <= nowMs + 5_000)
    .sort((a, b) => b - a);
  const latest = times[0];
  if (latest !== undefined && nowMs - latest < OWNER_TEST_MIN_INTERVAL_MS) {
    const wait = Math.ceil((OWNER_TEST_MIN_INTERVAL_MS - (nowMs - latest)) / 1000);
    return { ok: false, reason: `Please wait ${wait}s before testing again.`, retryAfterSeconds: wait };
  }
  const lastDay = times.filter((t) => nowMs - t < 24 * 3_600_000);
  if (lastDay.length >= OWNER_TEST_DAILY_LIMIT) {
    const oldest = lastDay[lastDay.length - 1];
    const wait = Math.max(60, Math.ceil((24 * 3_600_000 - (nowMs - oldest)) / 1000));
    return {
      ok: false,
      reason: `That's ${OWNER_TEST_DAILY_LIMIT} tests today — try again tomorrow, or check the forwarding code with your carrier.`,
      retryAfterSeconds: wait,
    };
  }
  return { ok: true };
}

export interface LocalClock {
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock hour/minute/weekday in an IANA zone (falls back to America/Toronto). */
export function localClock(timeZone: string | null | undefined, nowMs: number): LocalClock {
  const format = (tz: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "numeric", minute: "numeric", weekday: "short" })
      .formatToParts(new Date(nowMs));
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = format(timeZone?.trim() || "America/Toronto");
  } catch {
    parts = format("America/Toronto");
  }
  const map: Record<string, string> = {};
  for (const part of parts) if (part.type !== "literal") map[part.type] = part.value;
  return { hour: Number(map.hour) % 24, minute: Number(map.minute), weekday: WEEKDAYS[map.weekday] ?? 1 };
}

/** May a test call be placed now? 08:00–20:59 local, every day. */
export function withinCallingHours(timeZone: string | null | undefined, nowMs: number): boolean {
  const { hour } = localClock(timeZone, nowMs);
  return hour >= CALL_WINDOW_START_HOUR && hour < CALL_WINDOW_END_HOUR;
}

/**
 * Why the business line can't be called (or null when it can). Only North American (+1)
 * geographic numbers — never premium (900/976), never one of OUR numbers (catcher, caller
 * ID, the shared SMS sender) which would loop or bill us for nothing.
 */
export function businessLineProblem(
  line: string | null,
  ours: { catcher: string; callerId: string; sharedSender: string | null },
): string | null {
  if (!line) return "Add your business phone number first (Business step → Owner phone, or Settings → Company).";
  const digits = line.replace(/\D/g, "");
  if (!/^1[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return "Forwarding tests can only call North American (+1) business numbers.";
  const area = digits.slice(1, 4);
  if (area === "900" || area === "976") return "That business number can't be test-called.";
  for (const own of [ours.catcher, ours.callerId, ours.sharedSender]) {
    if (own && same10(line, own)) {
      return "Your business number is set to your EmpireVu number — set it to the phone customers call you on.";
    }
  }
  return null;
}

// ── Scheduled retests ────────────────────────────────────────────────────────

export interface RetestCandidate {
  voiceNumberId: string;
  createdAt: string;
  verifiedAt: string | null;
  lastTestAt: string | null;
  timeZone: string | null;
  /** Scheduled tests already run for this number. */
  scheduledAttempts: number;
  inFlight: boolean;
  hasBusinessLine: boolean;
}

/** A stable minute (0 … window length − 1) for this number inside the retest window. */
export function retestSlotMinute(voiceNumberId: string): number {
  let hash = 0;
  for (let i = 0; i < voiceNumberId.length; i++) hash = (hash * 31 + voiceNumberId.charCodeAt(i)) >>> 0;
  return hash % ((RETEST_WINDOW_END_HOUR - RETEST_WINDOW_START_HOUR) * 60);
}

export type RetestDecision = { due: true; kind: "verified_weekly" | "unverified_daily" } | { due: false; reason: string };

/**
 * Should the scheduler re-test this catcher number now?
 *   • only Mon–Fri 10:00–16:00 company-local, at/after the number's own slot minute;
 *   • verified numbers: weekly (7 days since the last proof — a test OR a real forwarded call);
 *   • unverified numbers: daily for their first 14 days (not in the first 2 h), at most
 *     UNVERIFIED_MAX_SCHEDULED_ATTEMPTS scheduled attempts; after that only the owner's button;
 *   • never while a test is in flight or with no business line on file.
 */
export function retestDecision(candidate: RetestCandidate, nowMs: number): RetestDecision {
  if (candidate.inFlight) return { due: false, reason: "in_flight" };
  if (!candidate.hasBusinessLine) return { due: false, reason: "no_business_line" };

  const clock = localClock(candidate.timeZone, nowMs);
  if (clock.weekday === 0 || clock.weekday === 6) return { due: false, reason: "weekend" };
  if (clock.hour < RETEST_WINDOW_START_HOUR || clock.hour >= RETEST_WINDOW_END_HOUR) return { due: false, reason: "outside_window" };
  const minutesIn = (clock.hour - RETEST_WINDOW_START_HOUR) * 60 + clock.minute;
  if (minutesIn < retestSlotMinute(candidate.voiceNumberId)) return { due: false, reason: "before_slot" };

  const ms = (iso: string | null) => (iso ? Date.parse(iso) : Number.NaN);
  const lastTest = ms(candidate.lastTestAt);

  if (candidate.verifiedAt) {
    const lastProof = Math.max(ms(candidate.verifiedAt) || 0, Number.isFinite(lastTest) ? lastTest : 0);
    return nowMs - lastProof >= VERIFIED_RETEST_INTERVAL_MS
      ? { due: true, kind: "verified_weekly" }
      : { due: false, reason: "recently_verified" };
  }

  const age = nowMs - ms(candidate.createdAt);
  if (!Number.isFinite(age) || age < NEW_NUMBER_GRACE_MS) return { due: false, reason: "too_new" };
  if (age > UNVERIFIED_RETEST_PERIOD_MS) return { due: false, reason: "past_first_14_days" };
  if (candidate.scheduledAttempts >= UNVERIFIED_MAX_SCHEDULED_ATTEMPTS) return { due: false, reason: "max_attempts" };
  if (Number.isFinite(lastTest) && nowMs - lastTest < UNVERIFIED_RETEST_INTERVAL_MS) return { due: false, reason: "tested_today" };
  return { due: true, kind: "unverified_daily" };
}

// ── Owner messages ───────────────────────────────────────────────────────────

/**
 * Tell the owner? Owner-triggered tests: always. Scheduled: when a number becomes live
 * (passed, wasn't verified), and on every not_forwarded (verified-then-broken, or a nudge
 * for a new number — capped by the retest schedule). Scheduled answered/failed stay quiet
 * (inconclusive / our side; retried and visible in the app).
 */
export function shouldNotifyOwner(input: { trigger: ForwardingTestTrigger; outcome: ForwardingTestOutcome; wasVerified: boolean }): boolean {
  if (input.trigger === "owner") return true;
  if (input.outcome === "passed") return !input.wasVerified;
  return input.outcome === "not_forwarded";
}

export interface ForwardingResultMessageInput {
  outcome: ForwardingTestOutcome;
  trigger: ForwardingTestTrigger;
  companyName: string | null;
  businessLine: string;
  catcherNumber: string;
  answeredBy: string | null;
  /** Deep link back to the wizard's Phone step, or null when APP_BASE_URL is unset. */
  link: string | null;
}

export interface ForwardingResultMessage {
  sms: string;
  subject: string;
  emailBody: string;
}

/** The owner SMS (+ email fallback) for a test result. Pure + golden-tested. */
export function buildForwardingResultMessage(input: ForwardingResultMessageInput): ForwardingResultMessage {
  const name = input.companyName?.trim() || "your business";
  const line = prettyPhone(input.businessLine);
  const instructions = buildForwardingInstructions(input.catcherNumber);
  const again = input.link ? ` Test again: ${input.link}` : " Then run the test again in the app.";
  const headsUp = input.trigger === "scheduled" ? "Heads up: " : "";

  let sms: string;
  let subject: string;
  switch (input.outcome) {
    case "passed":
      sms = `✅ Missed-call text-back is live for ${name}.`;
      subject = `Missed-call text-back is live for ${name}`;
      break;
    case "not_forwarded": {
      const what = answeredByMachine(input.answeredBy) ? "went to voicemail" : "rang out";
      sms =
        `${headsUp}missed-call text-back for ${name} isn't working: our test call to ${line} ${what} instead of forwarding. ` +
        `From that phone dial ${instructions.recommended.activate} and press Call.${again}`;
      subject = `Fix your call forwarding for ${name}`;
      break;
    }
    case "answered":
      sms = `Our forwarding test call to ${line} was answered, so we couldn't check forwarding for ${name}. Let it ring next time.${again}`;
      subject = `Forwarding test for ${name} was answered`;
      break;
    case "failed":
    default:
      sms = `We couldn't complete the forwarding test call to ${line} for ${name}. Check your business number in the app.${again}`;
      subject = `Forwarding test for ${name} couldn't run`;
      break;
  }
  // Capitalise a leading "missed-call…" after an empty heads-up prefix.
  sms = sms.charAt(0).toUpperCase() + sms.slice(1);

  const emailLines = [sms, ""];
  if (input.outcome === "not_forwarded") {
    emailLines.push(
      `Mobile: dial ${instructions.recommended.activate} from ${line} and press Call (turn it off again with ${instructions.recommended.deactivate}).`,
      instructions.landline,
      instructions.verifyNote,
    );
  }
  return { sms, subject, emailBody: emailLines.join("\n").trim() };
}

/** "/onboarding?step=phone" on the app origin, or null when APP_BASE_URL is unset. */
export function phoneStepLink(appBaseUrl: string | null | undefined): string | null {
  const base = appBaseUrl?.trim().replace(/\/+$/, "");
  return base ? `${base}/onboarding?step=phone` : null;
}
