import type { PeriodRange } from "@/server/services/attribution";
import { bookingHoursFromCompanyHours } from "@/server/services/dfy/hours";
import {
  computeScorecardMetrics,
  emptyScorecardInputs,
  fetchScorecardInputs,
  type ScorecardInputs,
} from "@/server/services/monthly-scorecard/metrics";
import { SMS_AGENT_SENDER } from "@/server/services/front-desk/contracts";
import type { TenantServiceContext } from "@/server/services/shared";

/**
 * Weekly "what your front desk did" metrics (docs/front-desk-ai.md → "Weekly report").
 *
 * Same two halves as the monthly scorecard:
 *  - `fetchWeeklyInputs` — tenant-scoped reads (every query filters organization_id AND
 *    company_id). Reuses the scorecard's `fetchScorecardInputs` over the Monday–Sunday range,
 *    plus the front-desk tables (sms_conversations, owner_approvals, retell_calls,
 *    invoice_payments). Each front-desk read is tolerant: a table that is empty — or missing on
 *    a database that hasn't run the migration yet — gives zeros, never a failed report.
 *  - `computeWeeklyMetrics` — PURE: rows in, numbers out (fixture-tested).
 *
 * Definitions:
 *  - textReplies: texts the AI wrote and sent this week (message_log.sent_by = 'sms_agent',
 *    status sent). textConversations: customers who got at least one of those this week (one
 *    per contact), plus any sms_conversations whose last_ai_reply_at falls in the week (rows
 *    from before sent_by existed).
 *  - approvalsAsked: owner_approvals created this week; approvalsApproved: decided this week
 *    with status approved/executed.
 *  - callsAnswered: inbound retell_calls created this week, minus voicemail and calls under
 *    5 s (the same "missed" rule Retell classification uses). afterHoursCalls: of those, how
 *    many started outside companies.hours (parsed with dfy/hours.ts; null when the hours
 *    can't be read — then we don't claim any).
 *  - missedCalls / quotes / jobsBooked / reviewsRequested / leads: the monthly scorecard's
 *    definitions over the week.
 *  - collected: quote deposits paid this week + succeeded invoice payments received this week.
 *  - hoursSaved: an ESTIMATE — see HOURS_SAVED_ASSUMPTIONS.
 */

/**
 * The one place the "hours saved" estimate is defined. Deliberately conservative: minutes a
 * person at a front desk would have spent on each thing the system did. Always shown as an
 * estimate, with these assumptions, wherever the number appears.
 */
export const HOURS_SAVED_ASSUMPTIONS = {
  /** Per AI-handled customer text conversation (a back-and-forth, not each message). */
  minutesPerTextConversation: 3,
  /** Per call the AI answered. */
  minutesPerCallAnswered: 4,
  /** Per quote sent. */
  minutesPerQuoteSent: 5,
  /** Per job booked. */
  minutesPerJobBooked: 2,
  /** Per missed call texted back automatically. */
  minutesPerMissedCallTextBack: 1,
  /** Ontario receptionist wage used for "what that time would have cost" (CAD cents/hour). */
  receptionistHourlyWageCents: 2200,
} as const;

/** Plain-language list of the assumptions (email footer + in-app page). */
export function hoursSavedAssumptionsText(): string {
  const a = HOURS_SAVED_ASSUMPTIONS;
  return (
    `Estimate: ${a.minutesPerTextConversation} min per text conversation, ${a.minutesPerCallAnswered} min per call answered, ` +
    `${a.minutesPerQuoteSent} min per quote sent, ${a.minutesPerJobBooked} min per job booked, ` +
    `${a.minutesPerMissedCallTextBack} min per missed call texted back; ` +
    `valued at $${(a.receptionistHourlyWageCents / 100).toFixed(0)}/hour (Ontario receptionist wage).`
  );
}

export interface FrontDeskInputs {
  conversations: Array<{ contactId?: string | null; lastAiReplyAt: string | null }>;
  /** Texts the AI sent (message_log.sent_by = 'sms_agent'). Optional for older fixtures. */
  aiTexts?: Array<{ contactId: string | null; at: string }>;
  /** owner_approvals rows. kind 'owner_command' (the owner confirming their own command) isn't the AI checking in. */
  approvals: Array<{ createdAt: string; status: string; decidedAt: string | null; kind?: string }>;
  calls: Array<{ direction: string | null; at: string; durationMs: number | null; inVoicemail: boolean | null }>;
  invoicePayments: Array<{ receivedAt: string; amountCents: number; status: string }>;
  /** companies.hours, any stored shape. */
  hours: unknown;
}

export function emptyFrontDeskInputs(): FrontDeskInputs {
  return { conversations: [], aiTexts: [], approvals: [], calls: [], invoicePayments: [], hours: null };
}

export interface HoursSaved {
  minutes: number;
  /** minutes / 60, one decimal. */
  hours: number;
  /** What that front-desk time would have cost at the receptionist wage (estimate). */
  wageValueCents: number;
}

export interface WeeklyReportMetrics {
  version: 1;
  weekStart: string;
  range: PeriodRange;
  timeZone: string;
  textConversations: number;
  /** AI-written texts sent this week (absent on reports stored before it was counted). */
  textReplies?: number;
  approvals: { asked: number; approved: number };
  calls: { answered: number; afterHours: number | null; minutes: number };
  missedCalls: { caught: number; textedBack: number };
  leads: number;
  quotes: { sent: number; approved: number; approvedCents: number };
  jobsBooked: number;
  collected: { cents: number; deposits: number; payments: number };
  reviewsRequested: number;
  currency: string;
  hoursSaved: HoursSaved;
  hasActivity: boolean;
}

function inRange(iso: string | null | undefined, fromMs: number, toMs: number): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms >= fromMs && ms < toMs;
}

const MIN_ANSWERED_CALL_MS = 5_000;

export function computeHoursSaved(counts: {
  textConversations: number;
  callsAnswered: number;
  quotesSent: number;
  jobsBooked: number;
  missedCallsTextedBack: number;
}): HoursSaved {
  const a = HOURS_SAVED_ASSUMPTIONS;
  const minutes =
    counts.textConversations * a.minutesPerTextConversation +
    counts.callsAnswered * a.minutesPerCallAnswered +
    counts.quotesSent * a.minutesPerQuoteSent +
    counts.jobsBooked * a.minutesPerJobBooked +
    counts.missedCallsTextedBack * a.minutesPerMissedCallTextBack;
  return {
    minutes,
    hours: Math.round((minutes / 60) * 10) / 10,
    wageValueCents: Math.round((minutes / 60) * a.receptionistHourlyWageCents),
  };
}

/** Local weekday (0 Sun … 6 Sat) and minutes after midnight of an instant in `timeZone`. */
function localDayMinute(iso: string, timeZone: string): { day: number; minute: number } | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const map: Record<string, string> = {};
  for (const part of parts) if (part.type !== "literal") map[part.type] = part.value;
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(map.weekday);
  if (day < 0) return null;
  return { day, minute: Number(map.hour) * 60 + Number(map.minute) };
}

/**
 * Best effort: did a call at `iso` start outside the business's stated hours? Uses the
 * booking-window reading of companies.hours (earliest open → latest close on open days).
 * Returns null when the hours can't be read.
 */
export function isAfterHours(iso: string, hours: unknown, timeZone: string): boolean | null {
  const window = bookingHoursFromCompanyHours(hours);
  if (!window) return null;
  const local = localDayMinute(iso, timeZone);
  if (!local) return null;
  if (!window.workingDays.includes(local.day)) return true;
  return local.minute < window.startHour * 60 || local.minute >= window.endHour * 60;
}

export function computeWeeklyMetrics(input: {
  scorecard: ScorecardInputs;
  frontDesk: FrontDeskInputs;
  range: PeriodRange;
  weekStart: string;
  timeZone: string;
}): WeeklyReportMetrics {
  const { range, frontDesk, timeZone } = input;
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);
  const card = computeScorecardMetrics(input.scorecard, range);

  const aiTexts = (frontDesk.aiTexts ?? []).filter((t) => inRange(t.at, fromMs, toMs));
  const talkedTo = new Set<string>();
  aiTexts.forEach((t, i) => talkedTo.add(t.contactId ? `c:${t.contactId}` : `t:${i}`));
  frontDesk.conversations.forEach((c, i) => {
    if (inRange(c.lastAiReplyAt, fromMs, toMs)) talkedTo.add(c.contactId ? `c:${c.contactId}` : `v:${i}`);
  });
  const textConversations = talkedTo.size;
  const aiApprovals = frontDesk.approvals.filter((a) => a.kind !== "owner_command");
  const approvalsAsked = aiApprovals.filter((a) => inRange(a.createdAt, fromMs, toMs)).length;
  const approvalsApproved = aiApprovals.filter(
    (a) => (a.status === "approved" || a.status === "executed") && inRange(a.decidedAt, fromMs, toMs),
  ).length;

  const answered = frontDesk.calls.filter(
    (call) =>
      call.direction !== "outbound" &&
      inRange(call.at, fromMs, toMs) &&
      call.inVoicemail !== true &&
      !(call.durationMs !== null && call.durationMs < MIN_ANSWERED_CALL_MS),
  );
  let afterHours: number | null = null;
  if (bookingHoursFromCompanyHours(frontDesk.hours)) {
    afterHours = answered.filter((call) => isAfterHours(call.at, frontDesk.hours, timeZone) === true).length;
  }

  const payments = frontDesk.invoicePayments.filter((p) => p.status === "succeeded" && inRange(p.receivedAt, fromMs, toMs));
  const collectedCents = card.quotes.depositCents + payments.reduce((sum, p) => sum + Number(p.amountCents || 0), 0);

  const hoursSaved = computeHoursSaved({
    textConversations,
    callsAnswered: answered.length,
    quotesSent: card.quotes.sent,
    jobsBooked: card.jobsBooked,
    missedCallsTextedBack: card.missedCalls.textedBack,
  });

  const metrics: WeeklyReportMetrics = {
    version: 1,
    weekStart: input.weekStart,
    range,
    timeZone,
    textConversations,
    textReplies: aiTexts.length,
    approvals: { asked: approvalsAsked, approved: approvalsApproved },
    calls: { answered: answered.length, afterHours, minutes: card.receptionist.minutes },
    missedCalls: card.missedCalls,
    leads: card.leads.total,
    quotes: { sent: card.quotes.sent, approved: card.quotes.approved, approvedCents: card.quotes.approvedCents },
    jobsBooked: card.jobsBooked,
    collected: { cents: collectedCents, deposits: card.quotes.depositsCollected, payments: payments.length },
    reviewsRequested: card.reviewsRequested,
    currency: card.quotes.currency,
    hoursSaved,
    hasActivity: false,
  };
  metrics.hasActivity = weeklyHasActivity(metrics);
  return metrics;
}

/** Anything at all happened this week. */
export function weeklyHasActivity(m: Omit<WeeklyReportMetrics, "hasActivity">): boolean {
  return (
    m.textConversations > 0 ||
    m.approvals.asked > 0 ||
    m.calls.answered > 0 ||
    m.missedCalls.caught > 0 ||
    m.leads > 0 ||
    m.quotes.sent > 0 ||
    m.quotes.approved > 0 ||
    m.jobsBooked > 0 ||
    m.collected.cents > 0 ||
    m.reviewsRequested > 0
  );
}

/** An all-zero week (fixtures, previews). */
export function emptyWeeklyMetrics(weekStart: string, range: PeriodRange, timeZone: string): WeeklyReportMetrics {
  return computeWeeklyMetrics({ scorecard: emptyScorecardInputs(), frontDesk: emptyFrontDeskInputs(), range, weekStart, timeZone });
}

// ── Tenant-scoped reads ─────────────────────────────────────────────────────────

const ROW_LIMIT = 5000;

/** Run a front-desk read; a failure (e.g. table not migrated yet) logs and yields []. */
async function tolerant<T>(label: string, read: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  try {
    const { data, error } = await read;
    if (error) throw error;
    return data ?? [];
  } catch (err) {
    const message = err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : String(err);
    console.error(`[weekly-report] ${label} unavailable:`, message);
    return [];
  }
}

export async function fetchFrontDeskInputs(
  context: TenantServiceContext,
  companyId: string,
  range: PeriodRange,
): Promise<FrontDeskInputs> {
  const org = context.organizationId;
  const db = context.supabase;

  const [aiTexts, conversations, approvalsCreated, approvalsDecided, calls, payments, companyRows] = await Promise.all([
    tolerant(
      "message_log (AI texts)",
      db.from("message_log").select("id, contact_id, created_at")
        .eq("organization_id", org).eq("company_id", companyId)
        .eq("sent_by", SMS_AGENT_SENDER).eq("channel", "sms").eq("direction", "outbound").eq("status", "sent")
        .gte("created_at", range.from).lt("created_at", range.to)
        .limit(ROW_LIMIT),
    ),
    tolerant(
      "sms_conversations",
      db.from("sms_conversations").select("id, contact_id, last_ai_reply_at")
        .eq("organization_id", org).eq("company_id", companyId)
        .gte("last_ai_reply_at", range.from).lt("last_ai_reply_at", range.to)
        .limit(ROW_LIMIT),
    ),
    tolerant(
      "owner_approvals",
      db.from("owner_approvals").select("id, kind, created_at, status, decided_at")
        .eq("organization_id", org).eq("company_id", companyId)
        .gte("created_at", range.from).lt("created_at", range.to)
        .limit(ROW_LIMIT),
    ),
    tolerant(
      "owner_approvals (decided)",
      db.from("owner_approvals").select("id, kind, created_at, status, decided_at")
        .eq("organization_id", org).eq("company_id", companyId)
        .gte("decided_at", range.from).lt("decided_at", range.to)
        .limit(ROW_LIMIT),
    ),
    tolerant(
      "retell_calls",
      db.from("retell_calls").select("id, direction, created_at, duration_ms, in_voicemail")
        .eq("organization_id", org).eq("company_id", companyId)
        .gte("created_at", range.from).lt("created_at", range.to)
        .limit(ROW_LIMIT),
    ),
    tolerant(
      "invoice_payments",
      db.from("invoice_payments").select("id, received_at, amount_cents, status")
        .eq("organization_id", org).eq("company_id", companyId)
        .gte("received_at", range.from).lt("received_at", range.to)
        .limit(ROW_LIMIT),
    ),
    tolerant("companies.hours", db.from("companies").select("hours").eq("organization_id", org).eq("id", companyId).limit(1)),
  ]);

  const approvalsById = new Map<string, { kind?: string; created_at: string; status: string; decided_at: string | null }>();
  for (const row of [...approvalsCreated, ...approvalsDecided] as Array<{ id: string; kind?: string; created_at: string; status: string; decided_at: string | null }>) {
    approvalsById.set(row.id, row);
  }

  return {
    conversations: (conversations as Array<{ contact_id: string | null; last_ai_reply_at: string | null }>).map((row) => ({
      contactId: row.contact_id,
      lastAiReplyAt: row.last_ai_reply_at,
    })),
    aiTexts: (aiTexts as Array<{ contact_id: string | null; created_at: string }>).map((row) => ({ contactId: row.contact_id, at: row.created_at })),
    approvals: [...approvalsById.values()].map((row) => ({ createdAt: row.created_at, status: row.status, decidedAt: row.decided_at, kind: row.kind })),
    calls: (calls as Array<{ direction: string | null; created_at: string; duration_ms: number | null; in_voicemail: boolean | null }>).map(
      (row) => ({ direction: row.direction, at: row.created_at, durationMs: row.duration_ms, inVoicemail: row.in_voicemail }),
    ),
    invoicePayments: (payments as Array<{ received_at: string; amount_cents: number; status: string }>).map((row) => ({
      receivedAt: row.received_at,
      amountCents: Number(row.amount_cents ?? 0),
      status: row.status,
    })),
    hours: (companyRows as Array<{ hours: unknown }>)[0]?.hours ?? null,
  };
}

/** Everything for one company-week: scorecard reads + front-desk reads → metrics. */
export async function computeWeekForCompany(
  context: TenantServiceContext,
  companyId: string,
  weekStart: string,
  range: PeriodRange,
  timeZone: string,
): Promise<WeeklyReportMetrics> {
  const [scorecard, frontDesk] = await Promise.all([
    fetchScorecardInputs(context, companyId, range),
    fetchFrontDeskInputs(context, companyId, range),
  ]);
  return computeWeeklyMetrics({ scorecard, frontDesk, range, weekStart, timeZone });
}

/**
 * Did the company have ANY activity in the 30 days before `nowMs`? (Decides whether a quiet
 * week still gets a short "quiet week" note, or nothing.) Three cheap limit-1 reads.
 */
export async function hadActivityInLast30Days(
  context: TenantServiceContext,
  companyId: string,
  nowMs: number,
): Promise<boolean> {
  const org = context.organizationId;
  const db = context.supabase;
  const since = new Date(nowMs - 30 * 86_400_000).toISOString();
  const probes = await Promise.all([
    tolerant("message_log", db.from("message_log").select("id").eq("organization_id", org).eq("company_id", companyId).gte("created_at", since).limit(1)),
    tolerant("retell_calls", db.from("retell_calls").select("id").eq("organization_id", org).eq("company_id", companyId).gte("created_at", since).limit(1)),
    tolerant("contacts", db.from("contacts").select("id").eq("organization_id", org).eq("company_id", companyId).gte("created_at", since).limit(1)),
  ]);
  return probes.some((rows) => rows.length > 0);
}
