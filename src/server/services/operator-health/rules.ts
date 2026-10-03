/**
 * PURE rules for the daily operator health email (docs/operator-health.md). No I/O, no clock:
 * facts (gathered by ./load.ts) + `nowMs` in → report sections out. Golden-tested in
 * src/test/operator-health.test.ts.
 *
 * The report lists ONLY what needs a human. Each rule below is re-checked here even when the
 * loader already pre-filtered, so the thresholds live in exactly one place:
 *
 *   provisioning  CrankLeads purchase paid but no account: status 'failed' (last 30 days), or
 *                 stuck in 'paid' / 'provisioning' for ≥ 60 min (the 15-min sweep didn't fix it).
 *   forwarding    Active catcher number whose last forwarding test was 'not_forwarded' / 'failed'
 *                 AND it used to work (a passed test or a real forwarded call on record) or the
 *                 account is live. Never-verified numbers are a setup problem, not this.
 *   setup         Provisioned ≥ 3 business days ago (company-local Mon–Fri), not live, not
 *                 cancelled. Day 3–4: early warning (medium). Day 5: "guarantee at risk",
 *                 deadline today (high). After day 5: missed (critical).
 *   queues        Per durable queue: jobs dead-lettered in the last 24h, or a ready job left
 *                 unclaimed for ≥ 30 min (worker down / wedged).
 *   payments      Organization subscription_status 'past_due' (Stripe 'unpaid' maps there too —
 *                 billing/events.ts), not the internal house plan. Critical once the grace window
 *                 (BILLING_PAST_DUE_GRACE_DAYS after current_period_end) has passed.
 *   support       support_requests still 'open' ≥ 24h after they were sent (high after 72h).
 *   silent        Live CrankLeads account, subscription active/trialing, live ≥ 14 days, and zero
 *                 new contacts, missed calls and AI-receptionist calls in the last 14 days.
 *   checks        A section the loader could not read (so a broken query is never mistaken for
 *                 "all clear").
 */
import { prettyPhone } from "@/lib/carrier-forwarding";
import { CRANKLEADS_TIER_LABELS, isCrankleadsTier } from "@/server/services/crankleads/config";
import { addBusinessDays, localClock, type LocalClock } from "@/server/services/crankleads/followup-schedule";

// ── Thresholds ───────────────────────────────────────────────────────────────

/** Flag a not-live CrankLeads setup this many business days after provisioning. */
/** Warn early (day 3) so there's time to help before the day-5 live guarantee. */
export const SETUP_STALL_BUSINESS_DAYS = 3;
/** The "live within 5 business days" promise. */
export const LIVE_GUARANTEE_BUSINESS_DAYS = 5;
/** A paid purchase still in 'paid' / 'provisioning' this long is stuck. */
export const PROVISIONING_STUCK_MINUTES = 60;
/** Failed purchases older than this are no longer reported (refunded / handled by hand). */
export const PROVISIONING_LOOKBACK_DAYS = 30;
/** A live account with no inbound activity for this many days is "silent". */
export const SILENT_DAYS = 14;
/** Open support requests older than this are flagged… */
export const SUPPORT_OPEN_HOURS = 24;
/** …and escalated to high after this. */
export const SUPPORT_URGENT_HOURS = 72;
/** A ready queue job unclaimed this long means the worker is not draining. */
export const QUEUE_STUCK_MINUTES = 30;
/** Dead-lettered jobs are counted over this window (one daily report → no repeats). */
export const QUEUE_FAILED_WINDOW_HOURS = 24;
/** Items shown per section before "+N more". */
export const MAX_ITEMS_PER_SECTION = 8;

export const BROKEN_FORWARDING_RESULTS: readonly string[] = ["not_forwarded", "failed"];
export const PAYMENT_PROBLEM_STATUSES: readonly string[] = ["past_due"];
export const PAYING_STATUSES: readonly string[] = ["active", "trialing"];
export const STUCK_PROVISIONING_STATUSES: readonly string[] = ["paid", "provisioning"];

/** The report goes out at/after this operator-local time. */
export const REPORT_TIME = { hour: 7, minute: 30 } as const;
/** Weekly all-clear day (0 = Sunday … 6 = Saturday): Monday. */
export const ALL_CLEAR_WEEKDAY = 1;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ── Facts (what the loader hands over) ──────────────────────────────────────

export interface AccountFact {
  organizationId: string;
  businessName: string;
  /** organizations.crankleads_tier (null = not a CrankLeads org). */
  tier: string | null;
  stripeCustomerId: string | null;
}

export interface ChecklistSummary {
  doneCount: number;
  totalCount: number;
  isLive: boolean;
  nextStepTitle: string | null;
  /** Absolute deep link the OWNER can use (onboarding wizard step). */
  nextStepLink: string | null;
}

export interface SetupFact extends AccountFact {
  purchaseId: string;
  provisionedAt: string;
  /** Company timezone (business days are counted there). */
  timeZone: string;
  subscriptionStatus: string;
  remindersStopped: boolean;
  checklist: ChecklistSummary | null;
  ownerName: string;
  ownerEmail: string;
  ownerPhone: string;
}

export interface ForwardingFact extends AccountFact {
  voiceNumberId: string;
  catcherNumber: string;
  lastResult: string;
  lastTestAt: string | null;
  /** First failed test after the last pass (null → use lastTestAt). */
  failingSince: string | null;
  /** A passed forwarding test or a real forwarded missed call is on record for this number. */
  everWorked: boolean;
  /** The org's CrankLeads purchase has live_at set. */
  accountLive: boolean;
  subscriptionStatus: string;
  /** Carrier activation code (e.g. *72…) for the catcher number, when known. */
  activateCode: string | null;
  /** Owner's onboarding phone/forwarding step. */
  fixLink: string | null;
}

export interface PaymentFact extends AccountFact {
  plan: string;
  subscriptionStatus: string;
  /** When the subscription last changed (≈ when it went past due). */
  since: string | null;
  currentPeriodEnd: string | null;
  stripeSubscriptionId: string | null;
}

export interface ProvisioningFact {
  purchaseId: string;
  businessName: string;
  tier: string;
  status: string;
  sessionId: string | null;
  stripeCustomerId: string | null;
  lastError: string | null;
  attempts: number;
  paidAt: string | null;
  failedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SilentFact extends AccountFact {
  liveAt: string;
  subscriptionStatus: string;
  newContacts: number;
  missedCalls: number;
  aiCalls: number;
}

export interface SupportFact {
  id: string;
  organizationId: string;
  businessName: string;
  tier: string | null;
  requesterEmail: string | null;
  question: string;
  status: string;
  createdAt: string;
}

export interface QueueFact {
  key: string;
  label: string;
  table: string;
  service: string;
  failedStatuses: readonly string[];
  failedRecent: number;
  pending: number;
  /** Oldest pending job whose ready time has passed (null = none). */
  oldestReadyAt: string | null;
}

export interface CheckError {
  section: string;
  message: string;
}

export interface OperatorHealthFacts {
  nowMs: number;
  /** Operator timezone (BUSINESS_TIMEZONE). */
  timeZone: string;
  appBaseUrl: string;
  /** https://dashboard.stripe.com (or …/test). */
  stripeDashboardBase: string;
  graceDays: number;
  setup: SetupFact[];
  forwarding: ForwardingFact[];
  payments: PaymentFact[];
  provisioning: ProvisioningFact[];
  silent: SilentFact[];
  support: SupportFact[];
  queues: QueueFact[];
  errors: CheckError[];
}

// ── Report ───────────────────────────────────────────────────────────────────

export type Severity = "critical" | "high" | "medium" | "low";
export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export interface HealthLink {
  label: string;
  url: string;
}

export interface HealthItem {
  severity: Severity;
  /** Business / org name (or the queue name). */
  account: string;
  tierLabel: string | null;
  problem: string;
  /** How long, human ("3 business days", "5h"). */
  howLong: string;
  /** For ordering inside a severity (older first). */
  ageMs: number;
  /** The one thing to do. */
  action: string;
  links: HealthLink[];
  guaranteeAtRisk: boolean;
}

export type SectionKey = "provisioning" | "forwarding" | "setup" | "queues" | "payments" | "support" | "silent" | "checks";

export const SECTION_ORDER: readonly SectionKey[] = [
  "checks",
  "provisioning",
  "forwarding",
  "setup",
  "queues",
  "payments",
  "support",
  "silent",
];

export const SECTION_TITLES: Record<SectionKey, string> = {
  checks: "Health checks that could not run",
  provisioning: "Provisioning failures",
  forwarding: "Call forwarding broken",
  setup: "Setup stalled",
  queues: "Job queues",
  payments: "Payment problems",
  support: "Open support requests",
  silent: "Silent accounts",
};

export interface HealthSection {
  key: SectionKey;
  title: string;
  /** Shown items (capped), most severe / oldest first. */
  items: HealthItem[];
  /** Items beyond the cap ("+N more"). */
  hiddenCount: number;
  total: number;
}

export interface OperatorHealthReport {
  /** Operator-local date (YYYY-MM-DD). */
  reportDate: string;
  timeZone: string;
  generatedAt: string;
  appBaseUrl: string;
  sections: HealthSection[];
  totalItems: number;
  criticalCount: number;
  guaranteeAtRisk: number;
}

export interface BuildReportOptions {
  /** Items per section before "+N more" (Infinity = no cap, for `--all`). */
  maxItemsPerSection?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** "45 min", "5h", "3 days". */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < HOUR) return `${Math.max(1, Math.floor(safe / MINUTE))} min`;
  if (safe < 48 * HOUR) return `${Math.floor(safe / HOUR)}h`;
  return plural(Math.floor(safe / DAY), "day");
}

/** "Fri Oct 9" in `timeZone`. */
export function formatDay(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(ms));
  }
}

/** Business days (Mon–Fri) strictly after `startDate` up to and including `endDate` (YYYY-MM-DD). */
export function businessDaysElapsed(startDate: string, endDate: string): number {
  if (endDate <= startDate) return 0;
  let n = 0;
  while (addBusinessDays(startDate, n + 1) <= endDate) n += 1;
  return n;
}

export function tierLabel(tier: string | null | undefined): string | null {
  return isCrankleadsTier(tier) ? CRANKLEADS_TIER_LABELS[tier] : null;
}

function stripeLink(base: string, kind: "customers" | "subscriptions", id: string | null, label: string): HealthLink[] {
  return id ? [{ label, url: `${base.replace(/\/+$/, "")}/${kind}/${encodeURIComponent(id)}` }] : [];
}

function age(nowMs: number, iso: string | null | undefined): number {
  const ms = parseMs(iso);
  return ms === null ? 0 : Math.max(0, nowMs - ms);
}

// ── Rules (one per section) ──────────────────────────────────────────────────

/** Business days since provisioning, counted in the company's timezone. */
export function setupBusinessDays(fact: Pick<SetupFact, "provisionedAt" | "timeZone">, nowMs: number): number {
  const provisionedMs = parseMs(fact.provisionedAt);
  if (provisionedMs === null) return 0;
  return businessDaysElapsed(localClock(fact.timeZone, provisionedMs).date, localClock(fact.timeZone, nowMs).date);
}

export function setupItem(fact: SetupFact, facts: Pick<OperatorHealthFacts, "nowMs" | "stripeDashboardBase">): HealthItem | null {
  if (fact.subscriptionStatus === "canceled") return null;
  if (fact.checklist?.isLive) return null;
  const elapsed = setupBusinessDays(fact, facts.nowMs);
  if (elapsed < SETUP_STALL_BUSINESS_DAYS) return null;

  const pastGuarantee = elapsed - LIVE_GUARANTEE_BUSINESS_DAYS;
  const guaranteeAtRisk = elapsed >= LIVE_GUARANTEE_BUSINESS_DAYS;
  const guaranteeNote = !guaranteeAtRisk
    ? `Early warning: the 5-business-day live deadline is in ${plural(LIVE_GUARANTEE_BUSINESS_DAYS - elapsed, "business day")}`
    : pastGuarantee === 0
      ? "GUARANTEE AT RISK: the 5-business-day live deadline is today"
      : `GUARANTEE AT RISK: ${plural(pastGuarantee, "business day")} past the 5-business-day live deadline`;
  const progress = fact.checklist
    ? `setup ${fact.checklist.doneCount}/${fact.checklist.totalCount} done${fact.checklist.nextStepTitle ? `, next: ${fact.checklist.nextStepTitle}` : ""}`
    : "setup checklist unavailable (no company?)";
  const problem = [
    `Not live after ${plural(elapsed, "business day")} — ${progress}.`,
    guaranteeNote ? `${guaranteeNote}.` : "",
    fact.remindersStopped ? "The owner turned off the automatic reminders." : "",
  ]
    .filter(Boolean)
    .join(" ");
  const next = fact.checklist?.nextStepTitle;
  return {
    severity: pastGuarantee > 0 ? "critical" : guaranteeAtRisk ? "high" : "medium",
    account: fact.businessName,
    tierLabel: tierLabel(fact.tier),
    problem,
    howLong: `${plural(elapsed, "business day")} since provisioning`,
    ageMs: age(facts.nowMs, fact.provisionedAt),
    action: `Call ${fact.ownerName} (${fact.ownerPhone}, ${fact.ownerEmail})${next ? ` and walk them through "${next}"` : ""}.`,
    links: [
      ...(fact.checklist?.nextStepLink ? [{ label: "Owner's next-step link (send it to them)", url: fact.checklist.nextStepLink }] : []),
      ...stripeLink(facts.stripeDashboardBase, "customers", fact.stripeCustomerId, "Stripe customer"),
    ],
    guaranteeAtRisk,
  };
}

export function forwardingItem(fact: ForwardingFact, facts: Pick<OperatorHealthFacts, "nowMs" | "stripeDashboardBase">): HealthItem | null {
  if (!BROKEN_FORWARDING_RESULTS.includes(fact.lastResult)) return null;
  if (fact.subscriptionStatus === "canceled") return null;
  // Something that used to work stopped. A number that never worked is a setup problem.
  if (!fact.everWorked && !fact.accountLive) return null;
  const since = fact.failingSince ?? fact.lastTestAt;
  const what = fact.lastResult === "failed" ? "the last test call could not be placed" : "the last test call was not forwarded";
  return {
    severity: fact.accountLive ? "critical" : "high",
    account: fact.businessName,
    tierLabel: tierLabel(fact.tier),
    problem: `Missed calls to their business line are NOT reaching ${prettyPhone(fact.catcherNumber)} — ${what}. It worked before.`,
    howLong: since ? `failing for ${formatDuration(age(facts.nowMs, since))}` : "unknown",
    ageMs: age(facts.nowMs, since),
    action: fact.activateCode
      ? `Call the owner: re-dial ${fact.activateCode} from the business phone, then press "Test my forwarding".`
      : `Call the owner: re-enable conditional call forwarding to ${prettyPhone(fact.catcherNumber)}, then press "Test my forwarding".`,
    links: [
      ...(fact.fixLink ? [{ label: "Owner's forwarding step", url: fact.fixLink }] : []),
      ...stripeLink(facts.stripeDashboardBase, "customers", fact.stripeCustomerId, "Stripe customer"),
    ],
    guaranteeAtRisk: false,
  };
}

export function paymentItem(
  fact: PaymentFact,
  facts: Pick<OperatorHealthFacts, "nowMs" | "stripeDashboardBase" | "graceDays" | "timeZone">,
): HealthItem | null {
  if (!PAYMENT_PROBLEM_STATUSES.includes(fact.subscriptionStatus)) return null;
  if (fact.plan === "internal") return null;
  const periodEndMs = parseMs(fact.currentPeriodEnd);
  const graceEndMs = periodEndMs === null ? null : periodEndMs + facts.graceDays * DAY;
  const featuresOff = graceEndMs !== null && facts.nowMs > graceEndMs;
  const problem = featuresOff
    ? `Payment failed — paid features are OFF (grace ended ${formatDay(graceEndMs, facts.timeZone)}).`
    : graceEndMs !== null
      ? `Payment failed — subscription past due; paid features turn off ${formatDay(graceEndMs, facts.timeZone)}.`
      : "Payment failed — subscription past due.";
  return {
    severity: featuresOff ? "critical" : "high",
    account: fact.businessName,
    tierLabel: tierLabel(fact.tier),
    problem,
    howLong: fact.since ? `past due for ${formatDuration(age(facts.nowMs, fact.since))}` : "unknown",
    ageMs: age(facts.nowMs, fact.since),
    action: "Open the failed invoice in Stripe and ask the owner to update their card (Settings → Billing).",
    links: [
      ...stripeLink(facts.stripeDashboardBase, "customers", fact.stripeCustomerId, "Stripe customer"),
      ...stripeLink(facts.stripeDashboardBase, "subscriptions", fact.stripeSubscriptionId, "Stripe subscription"),
    ],
    guaranteeAtRisk: false,
  };
}

export function provisioningItem(fact: ProvisioningFact, facts: Pick<OperatorHealthFacts, "nowMs" | "stripeDashboardBase">): HealthItem | null {
  const updatedAge = age(facts.nowMs, fact.updatedAt);
  const failed = fact.status === "failed";
  if (failed) {
    if (age(facts.nowMs, fact.failedAt ?? fact.updatedAt) > PROVISIONING_LOOKBACK_DAYS * DAY) return null;
  } else if (!STUCK_PROVISIONING_STATUSES.includes(fact.status) || updatedAge < PROVISIONING_STUCK_MINUTES * MINUTE) {
    return null;
  }
  const since = fact.paidAt ?? fact.createdAt;
  const problem = failed
    ? `Paid but the account was NOT created — provisioning failed (${plural(fact.attempts, "attempt")})${fact.lastError ? `: ${truncate(fact.lastError, 160)}` : "."}`
    : `Paid but provisioning is stuck in "${fact.status}" for ${formatDuration(updatedAge)} (the 15-minute sweep did not fix it).`;
  return {
    severity: "critical",
    account: fact.businessName,
    tierLabel: tierLabel(fact.tier),
    problem,
    howLong: `${formatDuration(age(facts.nowMs, since))} since payment`,
    ageMs: age(facts.nowMs, since),
    action: fact.sessionId
      ? `Fix the cause, then re-run: npm run job:crankleads-provision -- --session ${fact.sessionId}`
      : "No Checkout Session id on the purchase — find it in Stripe, then re-run: npm run job:crankleads-provision -- --session cs_…",
    links: stripeLink(facts.stripeDashboardBase, "customers", fact.stripeCustomerId, "Stripe customer"),
    guaranteeAtRisk: false,
  };
}

export function silentItem(fact: SilentFact, facts: Pick<OperatorHealthFacts, "nowMs" | "stripeDashboardBase" | "timeZone">): HealthItem | null {
  if (!PAYING_STATUSES.includes(fact.subscriptionStatus)) return null;
  const liveMs = parseMs(fact.liveAt);
  if (liveMs === null || facts.nowMs - liveMs < SILENT_DAYS * DAY) return null;
  if (fact.newContacts + fact.missedCalls + fact.aiCalls > 0) return null;
  return {
    severity: "low",
    account: fact.businessName,
    tierLabel: tierLabel(fact.tier),
    problem: `No new leads, missed calls or AI calls in ${SILENT_DAYS} days (live since ${formatDay(liveMs, facts.timeZone)}). Forwarding or the website form may have broken — or they are drifting away.`,
    howLong: `${SILENT_DAYS}+ days quiet`,
    ageMs: facts.nowMs - liveMs,
    action: "Check their forwarding test and website form, then check in with the owner (churn risk).",
    links: stripeLink(facts.stripeDashboardBase, "customers", fact.stripeCustomerId, "Stripe customer"),
    guaranteeAtRisk: false,
  };
}

export function supportItem(fact: SupportFact, facts: Pick<OperatorHealthFacts, "nowMs">): HealthItem | null {
  if (fact.status !== "open") return null;
  const ageMs = age(facts.nowMs, fact.createdAt);
  if (ageMs < SUPPORT_OPEN_HOURS * HOUR) return null;
  return {
    severity: ageMs >= SUPPORT_URGENT_HOURS * HOUR ? "high" : "medium",
    account: fact.businessName,
    tierLabel: tierLabel(fact.tier),
    problem: `Unanswered support request: "${truncate(fact.question, 140)}"`,
    howLong: `open for ${formatDuration(ageMs)}`,
    ageMs,
    action: `Reply to ${fact.requesterEmail ?? "the requester"}, then close it: update support_requests set status = 'closed' where id = '${fact.id}';`,
    links: [],
    guaranteeAtRisk: false,
  };
}

export function queueItem(fact: QueueFact, facts: Pick<OperatorHealthFacts, "nowMs">): HealthItem | null {
  const waitMs = fact.oldestReadyAt ? age(facts.nowMs, fact.oldestReadyAt) : 0;
  const stuck = waitMs >= QUEUE_STUCK_MINUTES * MINUTE;
  if (!stuck && fact.failedRecent <= 0) return null;
  const parts: string[] = [];
  if (stuck) parts.push(`oldest ready job has waited ${formatDuration(waitMs)} (${plural(fact.pending, "job")} pending) — the worker may be down`);
  if (fact.failedRecent > 0) parts.push(`${plural(fact.failedRecent, "job")} dead-lettered in the last ${QUEUE_FAILED_WINDOW_HOURS}h`);
  const statuses = fact.failedStatuses.map((s) => `'${s}'`).join(", ");
  return {
    severity: stuck ? "critical" : "high",
    account: fact.label,
    tierLabel: null,
    problem: `${parts.join("; ")}.`.replace(/^./, (c) => c.toUpperCase()),
    howLong: stuck ? `waiting ${formatDuration(waitMs)}` : `last ${QUEUE_FAILED_WINDOW_HOURS}h`,
    ageMs: waitMs,
    action: stuck
      ? `Check the ${fact.service} service in Railway (logs / restart).`
      : `Check the ${fact.service} logs, then: select id, last_error from ${fact.table} where status in (${statuses}) order by updated_at desc limit 20;`,
    links: [],
    guaranteeAtRisk: false,
  };
}

export function checkErrorItem(error: CheckError): HealthItem {
  return {
    severity: "high",
    account: "Health check",
    tierLabel: null,
    problem: `Couldn't check ${error.section}: ${truncate(error.message, 200)}`,
    howLong: "this run",
    ageMs: 0,
    action: "Look at the worker logs. The rest of this report is still accurate; this section may be missing items.",
    links: [],
    guaranteeAtRisk: false,
  };
}

// ── Builder ──────────────────────────────────────────────────────────────────

function compact<T>(values: Array<T | null>): T[] {
  return values.filter((v): v is T => v !== null);
}

function byUrgency(a: HealthItem, b: HealthItem): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.ageMs - a.ageMs || a.account.localeCompare(b.account);
}

function sectionSeverity(section: HealthSection): number {
  return Math.min(...section.items.map((i) => SEVERITY_RANK[i.severity]));
}

/** PURE. Facts → the report: only non-empty sections, most severe first, each capped. */
export function buildOperatorHealthReport(facts: OperatorHealthFacts, options: BuildReportOptions = {}): OperatorHealthReport {
  const cap = options.maxItemsPerSection ?? MAX_ITEMS_PER_SECTION;
  const all: Record<SectionKey, HealthItem[]> = {
    checks: facts.errors.map(checkErrorItem),
    provisioning: compact(facts.provisioning.map((f) => provisioningItem(f, facts))),
    forwarding: compact(facts.forwarding.map((f) => forwardingItem(f, facts))),
    setup: compact(facts.setup.map((f) => setupItem(f, facts))),
    queues: compact(facts.queues.map((f) => queueItem(f, facts))),
    payments: compact(facts.payments.map((f) => paymentItem(f, facts))),
    support: compact(facts.support.map((f) => supportItem(f, facts))),
    silent: compact(facts.silent.map((f) => silentItem(f, facts))),
  };

  const sections: HealthSection[] = SECTION_ORDER.filter((key) => all[key].length > 0).map((key) => {
    const sorted = [...all[key]].sort(byUrgency);
    const shown = sorted.slice(0, Math.max(0, cap));
    return { key, title: SECTION_TITLES[key], items: shown, hiddenCount: sorted.length - shown.length, total: sorted.length };
  });
  // Most severe section first; ties keep SECTION_ORDER (Array.prototype.sort is stable).
  sections.sort((a, b) => sectionSeverity(a) - sectionSeverity(b));

  const every = Object.values(all).flat();
  return {
    reportDate: localClock(facts.timeZone, facts.nowMs).date,
    timeZone: facts.timeZone,
    generatedAt: new Date(facts.nowMs).toISOString(),
    appBaseUrl: facts.appBaseUrl.replace(/\/+$/, ""),
    sections,
    totalItems: every.length,
    criticalCount: every.filter((i) => i.severity === "critical").length,
    guaranteeAtRisk: every.filter((i) => i.guaranteeAtRisk).length,
  };
}

// ── Scheduling decisions ─────────────────────────────────────────────────────

export type AllClearMode = "weekly" | "never";

/** Has today's report time (07:30 operator-local) arrived? */
export function isReportDue(clock: Pick<LocalClock, "hour" | "minute">): boolean {
  return clock.hour * 60 + clock.minute >= REPORT_TIME.hour * 60 + REPORT_TIME.minute;
}

export type Delivery = "report" | "all_clear" | "quiet";

/** Something to report → report; else the weekly all-clear on Mondays (when enabled); else nothing. */
export function decideDelivery(report: Pick<OperatorHealthReport, "totalItems">, mode: AllClearMode, weekday: number): Delivery {
  if (report.totalItems > 0) return "report";
  return mode === "weekly" && weekday === ALL_CLEAR_WEEKDAY ? "all_clear" : "quiet";
}

/** Per-section counts for the operator_health_reports.summary column (counts only). */
export function reportSummary(report: OperatorHealthReport): Record<string, number> {
  return Object.fromEntries(report.sections.map((s) => [s.key, s.total]));
}
