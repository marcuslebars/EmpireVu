import type { Json, Tables } from "@/server/db/database.types";
import { fallbackTimeZone, type PeriodRange } from "@/server/services/attribution";
import {
  computeScorecardMetrics,
  fetchScorecardInputs,
  metricsHaveActivity,
  type ScorecardMetrics,
} from "@/server/services/monthly-scorecard/metrics";
import {
  monthKeyInTimeZone,
  monthKeyToDate,
  monthLabel,
  monthRangeForKey,
  previousMonthKey,
} from "@/server/services/monthly-scorecard/months";
import { buildSuggestions, type ScorecardSuggestion } from "@/server/services/monthly-scorecard/suggestions";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { ValidationError } from "@/server/organizations/context";

/**
 * Monthly results scorecard — the one service behind the email (job) and the in-app
 * /reports/monthly page. Company-scoped, calendar month in the company's timezone.
 */

export type ScorecardCompany = Pick<Tables<"companies">, "id" | "name" | "timezone" | "created_at" | "organization_id">;

export const SCORECARD_COMPANY_COLUMNS = "id, name, timezone, created_at, organization_id";

export function companyTimeZone(company: Pick<Tables<"companies">, "timezone">): string {
  return company.timezone?.trim() || fallbackTimeZone();
}

// ── Deltas ──────────────────────────────────────────────────────────────────────

export interface MetricDelta {
  current: number;
  previous: number;
  change: number;
  /** Percent change; null when the previous value was 0 (no divide-by-zero). */
  pct: number | null;
}

export function metricDelta(current: number, previous: number): MetricDelta {
  return {
    current,
    previous,
    change: current - previous,
    pct: previous === 0 ? null : Math.round(((current - previous) / previous) * 100),
  };
}

export interface ScorecardDeltas {
  leads: MetricDelta;
  missedCallsCaught: MetricDelta;
  messagesSent: MetricDelta;
  jobsBooked: MetricDelta;
  quotesSent: MetricDelta;
  quotesApproved: MetricDelta;
  depositCents: MetricDelta;
  attributedPaidCents: MetricDelta;
  reviewsRequested: MetricDelta;
  callsHandled: MetricDelta;
  /** Lower is better. Null when either month had no measured response. */
  medianResponseSeconds: MetricDelta | null;
}

export function computeDeltas(current: ScorecardMetrics, previous: ScorecardMetrics): ScorecardDeltas {
  const currentMedian = current.firstResponse.medianSeconds;
  const previousMedian = previous.firstResponse.medianSeconds;
  return {
    leads: metricDelta(current.leads.total, previous.leads.total),
    missedCallsCaught: metricDelta(current.missedCalls.caught, previous.missedCalls.caught),
    messagesSent: metricDelta(current.messages.sent, previous.messages.sent),
    jobsBooked: metricDelta(current.jobsBooked, previous.jobsBooked),
    quotesSent: metricDelta(current.quotes.sent, previous.quotes.sent),
    quotesApproved: metricDelta(current.quotes.approved, previous.quotes.approved),
    depositCents: metricDelta(current.quotes.depositCents, previous.quotes.depositCents),
    attributedPaidCents: metricDelta(current.attributedRevenue.paidCents, previous.attributedRevenue.paidCents),
    reviewsRequested: metricDelta(current.reviewsRequested, previous.reviewsRequested),
    callsHandled: metricDelta(current.receptionist.callsHandled, previous.receptionist.callsHandled),
    medianResponseSeconds:
      currentMedian !== null && previousMedian !== null ? metricDelta(currentMedian, previousMedian) : null,
  };
}

// ── The scorecard ───────────────────────────────────────────────────────────────

export interface MonthlyScorecard {
  companyId: string;
  companyName: string;
  month: string; // YYYY-MM
  monthLabel: string; // "October"
  monthLabelLong: string; // "October 2026"
  timeZone: string;
  range: PeriodRange;
  /** The month isn't over yet (in-app "so far" view). */
  partial: boolean;
  /** No comparable previous month: the company is new, or last month had no activity. */
  firstMonth: boolean;
  hasActivity: boolean;
  metrics: ScorecardMetrics;
  previous: ScorecardMetrics | null;
  deltas: ScorecardDeltas | null;
  suggestions: ScorecardSuggestion[];
  operatorNote: string | null;
}

/** Pure assembly from already-computed metrics (unit-tested without a DB). */
export function assembleScorecard(input: {
  company: ScorecardCompany;
  month: string;
  timeZone: string;
  nowMs: number;
  metrics: ScorecardMetrics;
  previous: ScorecardMetrics | null;
  operatorNote: string | null;
}): MonthlyScorecard {
  const range = monthRangeForKey(input.timeZone, input.month);
  const companyStartedThisMonth = Date.parse(input.company.created_at) >= Date.parse(range.from);
  const firstMonth = companyStartedThisMonth || input.previous === null || !metricsHaveActivity(input.previous);
  return {
    companyId: input.company.id,
    companyName: input.company.name,
    month: input.month,
    monthLabel: monthLabel(input.month),
    monthLabelLong: monthLabel(input.month, true),
    timeZone: input.timeZone,
    range,
    partial: input.nowMs < Date.parse(range.to),
    firstMonth,
    hasActivity: metricsHaveActivity(input.metrics),
    metrics: input.metrics,
    previous: firstMonth ? null : input.previous,
    deltas: firstMonth || !input.previous ? null : computeDeltas(input.metrics, input.previous),
    suggestions: buildSuggestions(input.metrics),
    operatorNote: input.operatorNote?.trim() ? input.operatorNote.trim() : null,
  };
}

export async function computeMonthMetrics(
  context: TenantServiceContext,
  companyId: string,
  timeZone: string,
  month: string,
): Promise<ScorecardMetrics> {
  const range = monthRangeForKey(timeZone, month);
  const inputs = await fetchScorecardInputs(context, companyId, range);
  return computeScorecardMetrics(inputs, range);
}

/**
 * Build one company's scorecard for `month`, compared with the month before. Reads run on
 * the caller's client (RLS identity in the web app, service role in the job).
 */
export async function buildMonthlyScorecard(
  context: TenantServiceContext,
  company: ScorecardCompany,
  month: string,
  nowMs: number = Date.now(),
): Promise<MonthlyScorecard> {
  const timeZone = companyTimeZone(company);
  const [metrics, previous, operatorNote] = await Promise.all([
    computeMonthMetrics(context, company.id, timeZone, month),
    computeMonthMetrics(context, company.id, timeZone, previousMonthKey(month)),
    getOperatorNote(context, company.id, month),
  ]);
  return assembleScorecard({ company, month, timeZone, nowMs, metrics, previous, operatorNote });
}

export async function loadScorecardCompany(context: TenantServiceContext, companyId: string): Promise<ScorecardCompany> {
  await assertCompanyInOrganization(context, companyId);
  const { data, error } = await context.supabase
    .from("companies")
    .select(SCORECARD_COMPANY_COLUMNS)
    .eq("organization_id", context.organizationId)
    .eq("id", companyId)
    .single();
  if (error) throw error;
  return data;
}

/** The in-app view: this month so far + last month, plus the send log + settings. */
export interface ScorecardView {
  companyId: string;
  companyName: string;
  timeZone: string;
  settings: ScorecardSettings;
  months: Array<MonthlyScorecard & { lastSend: ScorecardSendSummary | null }>;
}

export interface ScorecardSendSummary {
  status: string;
  emailStatus: string | null;
  sentAt: string | null;
  sendCount: number;
}

export async function getScorecardView(
  context: TenantServiceContext,
  companyId: string,
  nowMs: number = Date.now(),
): Promise<ScorecardView> {
  const company = await loadScorecardCompany(context, companyId);
  const timeZone = companyTimeZone(company);
  const currentMonth = monthKeyInTimeZone(timeZone, nowMs);
  const lastMonth = previousMonthKey(currentMonth);
  const [current, previous, settings, currentSend, lastSend] = await Promise.all([
    buildMonthlyScorecard(context, company, currentMonth, nowMs),
    buildMonthlyScorecard(context, company, lastMonth, nowMs),
    getScorecardSettings(context, companyId),
    getSendSummary(context, companyId, currentMonth),
    getSendSummary(context, companyId, lastMonth),
  ]);
  return {
    companyId,
    companyName: company.name,
    timeZone,
    settings,
    months: [
      { ...current, lastSend: currentSend },
      { ...previous, lastSend },
    ],
  };
}

async function getSendSummary(
  context: TenantServiceContext,
  companyId: string,
  month: string,
): Promise<ScorecardSendSummary | null> {
  const { data, error } = await context.supabase
    .from("monthly_scorecard_sends")
    .select("status, email_status, sent_at, send_count")
    .eq("organization_id", context.organizationId)
    .eq("company_id", companyId)
    .eq("month", monthKeyToDate(month))
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { status: data.status, emailStatus: data.email_status, sentAt: data.sent_at, sendCount: data.send_count };
}

// ── Settings (opt-out) ─────────────────────────────────────────────────────────

export interface ScorecardSettings {
  enabled: boolean;
}

/** null / missing ⇒ enabled (opt-out model). Only an explicit `enabled: false` opts out. */
export function parseScorecardSettings(raw: Json | null | undefined): ScorecardSettings {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return { enabled: (record as Record<string, unknown>).enabled !== false };
}

export async function getScorecardSettings(context: TenantServiceContext, companyId: string): Promise<ScorecardSettings> {
  await assertCompanyInOrganization(context, companyId);
  const { data, error } = await context.supabase
    .from("companies")
    .select("monthly_scorecard")
    .eq("organization_id", context.organizationId)
    .eq("id", companyId)
    .single();
  if (error) throw error;
  return parseScorecardSettings(data.monthly_scorecard);
}

export async function updateScorecardSettings(
  context: TenantServiceContext,
  companyId: string,
  input: Partial<ScorecardSettings>,
): Promise<ScorecardSettings> {
  const current = await getScorecardSettings(context, companyId);
  const next: ScorecardSettings = { enabled: input.enabled ?? current.enabled };
  const { error } = await context.supabase
    .from("companies")
    .update({ monthly_scorecard: { enabled: next.enabled }, updated_at: new Date().toISOString() })
    .eq("organization_id", context.organizationId)
    .eq("id", companyId);
  if (error) throw error;
  return next;
}

// ── Operator note ───────────────────────────────────────────────────────────────

export const MAX_OPERATOR_NOTE_CHARS = 2000;

export async function getOperatorNote(
  context: TenantServiceContext,
  companyId: string,
  month: string,
): Promise<string | null> {
  const { data, error } = await context.supabase
    .from("monthly_scorecard_notes")
    .select("note")
    .eq("organization_id", context.organizationId)
    .eq("company_id", companyId)
    .eq("month", monthKeyToDate(month))
    .maybeSingle();
  if (error) throw error;
  return data?.note ?? null;
}

/**
 * Set (or clear, with an empty/null note) the operator's free-text note for a company-month.
 * The route enforces owner/admin; RLS enforces it again (admins-only write policies).
 */
export async function setOperatorNote(
  context: TenantServiceContext,
  companyId: string,
  month: string,
  note: string | null,
): Promise<string | null> {
  await assertCompanyInOrganization(context, companyId);
  const trimmed = note?.trim() ?? "";
  if (trimmed.length > MAX_OPERATOR_NOTE_CHARS) {
    throw new ValidationError(`The note must be ${MAX_OPERATOR_NOTE_CHARS} characters or fewer.`);
  }
  const monthDate = monthKeyToDate(month);
  if (!trimmed) {
    const { error } = await context.supabase
      .from("monthly_scorecard_notes")
      .delete()
      .eq("organization_id", context.organizationId)
      .eq("company_id", companyId)
      .eq("month", monthDate);
    if (error) throw error;
    return null;
  }
  const { error } = await context.supabase.from("monthly_scorecard_notes").upsert(
    {
      organization_id: context.organizationId,
      company_id: companyId,
      month: monthDate,
      note: trimmed,
      updated_by: context.actorProfileId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "company_id,month" },
  );
  if (error) throw error;
  return trimmed;
}
