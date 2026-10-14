/**
 * Payroll (docs/ai-staff.md → "Hiring & payroll"): the morning after each pay period ends
 * (08:00 local, caught up for two days), the owner gets a `payroll_period` approval listing each
 * person's regular and OT hours, open entries and late edits. Y locks the period's entries and
 * emails the CSV (to the bookkeeper email setting, else the org owner); open entries block the
 * lock until fixed, unless the owner replies "Y 12 anyway". Locked periods can be unlocked by an
 * owner/admin from Settings (logged in pay_period_events).
 *
 * Which entries are a company's: time_entries.company_id = the company, plus general time
 * (company_id null) for the org's first company only, so a multi-company org never counts the
 * same hours twice.
 *
 * Claim-then-act everywhere: the period row (unique company + start) is the once-per-period
 * claim; the lock is a conditional status update; the CSV email is claimed by csv_emailed_at.
 */
import type { AdminClient, ApprovalDecision, ExecuteResult, OwnerApprovalRow } from "@/server/services/front-desk/contracts";
import { loadCompanyFromAddress } from "@/server/outbound/company-sender";
import { sendEmail, type SendEmailInput } from "@/server/outbound/email";
import type { TenantServiceContext } from "@/server/services/shared";
import { orgOwnerEmail } from "@/server/services/workflow-engine/messaging";
import { localDate, zonedInstant } from "@/server/services/booking-windows";
import { ANYWAY_NOTE, createRecruiterApproval, defaultRecruiterApprovalDeps, PAYROLL_PERIOD_KIND, smsDecider, type RecruiterApprovalDeps } from "./approvals";
import type { Db, PayPeriodAction, PayPeriodRow, PayrollEntry } from "./db-types";
import {
  addDays,
  buildPayrollSummary,
  computePayroll,
  csvFilename,
  dayLabel,
  daysBetween,
  hoursShort,
  payrollCsv,
  payrollTotals,
  periodLabel,
  previousPeriod,
  workWeekStart,
  workWeekStartDay,
  type PeriodDates,
  type PersonHours,
} from "./periods";
import { isCrankleadsOrg, loadRecruiterCompany, readRecruiterSettings, type RecruiterCompany } from "./settings";

/** The approval goes out from 08:00 local the day after the period ends … */
export const PAYROLL_HOUR = 8;
/** … and is caught up for this many days if the workers were down. */
export const PAYROLL_CATCH_UP_DAYS = 2;

export interface PayrollDeps extends RecruiterApprovalDeps {
  sendEmail(input: SendEmailInput): Promise<{ id: string | null }>;
  ownerEmail(admin: AdminClient, organizationId: string): Promise<string | null>;
}

export const defaultPayrollDeps: PayrollDeps = {
  ...defaultRecruiterApprovalDeps,
  sendEmail: (input) => sendEmail(input),
  ownerEmail: (admin, organizationId) => orgOwnerEmail({ organizationId, actorProfileId: null, supabase: admin } as TenantServiceContext),
};

function localHour(nowMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "numeric" }).formatToParts(new Date(nowMs));
  return Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
}

export interface PeriodWindow extends PeriodDates {
  startsAt: string;
  endsAt: string;
  /** This period also pays (and locks) the org's general time — see generalTimeCompanyId. */
  coversGeneralTime: boolean;
}

export function periodWindow(dates: PeriodDates, timeZone: string, coversGeneralTime = false): PeriodWindow {
  return {
    ...dates,
    coversGeneralTime,
    startsAt: zonedInstant(dates.start, "00:00", timeZone).toISOString(),
    endsAt: zonedInstant(addDays(dates.end, 1), "00:00", timeZone).toISOString(),
  };
}

function windowOf(row: Pick<PayPeriodRow, "start_date" | "end_date" | "starts_at" | "ends_at" | "covers_general_time">): PeriodWindow {
  return { start: row.start_date, end: row.end_date, startsAt: row.starts_at, endsAt: row.ends_at, coversGeneralTime: row.covers_general_time === true };
}

/**
 * The company whose payroll pays the org's general time (time_entries.company_id null): the
 * oldest company with payroll on (the primary company when it has payroll on). Decided when a
 * period is created and stored on it (pay_periods.covers_general_time), and the lock (time-lock.ts
 * and the time_entries trigger) follows that flag — so what's paid is exactly what's locked.
 */
export async function generalTimeCompanyId(admin: AdminClient, organizationId: string): Promise<string | null> {
  const db = admin as Db;
  const { data } = await db
    .from("companies")
    .select("id, ai_settings, created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(200);
  const { data: org } = await db.from("organizations").select("platform_brand").eq("id", organizationId).maybeSingle();
  const crankleads = isCrankleadsOrg(org);
  const first = ((data ?? []) as Array<{ id: string; ai_settings: unknown }>).find((c) => readRecruiterSettings(c.ai_settings, { crankleads }).payroll.enabled);
  return first?.id ?? null;
}

/** Everyone's hours for one period (entries + names + pay rates). Throws on a failed read. */
export async function loadPeriodHours(admin: AdminClient, company: RecruiterCompany, period: PeriodWindow): Promise<PersonHours[]> {
  const db = admin as Db;
  const weekStartDay = workWeekStartDay(company.settings.payroll.frequency, company.settings.payroll.anchorDate);
  const firstWeek = workWeekStart(period.start, weekStartDay);
  const from = zonedInstant(firstWeek, "00:00", company.timeZone).toISOString();
  const entries: PayrollEntry[] = [];
  for (let offset = 0; offset < 20_000; offset += 1000) {
    const { data, error } = await db
      .from("time_entries")
      .select("id, company_id, booking_id, profile_id, started_at, ended_at, break_minutes, created_at, updated_at")
      .eq("organization_id", company.organizationId)
      .gte("started_at", from)
      .lt("started_at", period.endsAt)
      .order("started_at", { ascending: true })
      .range(offset, offset + 999);
    if (error) throw error;
    const rows = (data ?? []) as PayrollEntry[];
    // Every company's entries: the 44-hour week is per worker across the org.
    entries.push(...rows);
    if (rows.length < 1000) break;
  }
  const counts = (e: PayrollEntry) => e.company_id === company.companyId || (e.company_id === null && period.coversGeneralTime);
  const ids = [...new Set(entries.filter(counts).map((e) => e.profile_id))];
  const people = new Map<string, { name: string; email: string | null }>();
  const rates = new Map<string, number>();
  if (ids.length) {
    for (let i = 0; i < ids.length; i += 200) {
      const part = ids.slice(i, i + 200);
      const { data: profiles, error } = await db.from("profiles").select("id, full_name, email").in("id", part);
      if (error) throw error;
      for (const p of (profiles ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>) {
        people.set(p.id, { name: p.full_name?.trim() || p.email || "Team member", email: p.email ?? null });
      }
      const { data: rateRows, error: rateError } = await db.from("member_pay_rates").select("profile_id, hourly_cost_cents").eq("organization_id", company.organizationId).in("profile_id", part);
      if (rateError) throw rateError;
      for (const r of (rateRows ?? []) as Array<{ profile_id: string; hourly_cost_cents: number }>) rates.set(r.profile_id, r.hourly_cost_cents);
    }
  }
  return computePayroll({
    entries,
    counts,
    startsAtMs: Date.parse(period.startsAt),
    endsAtMs: Date.parse(period.endsAt),
    timeZone: company.timeZone,
    weekStartDay,
    people,
    rates,
  });
}

async function logEvent(admin: AdminClient, period: Pick<PayPeriodRow, "id" | "organization_id" | "company_id">, action: PayPeriodAction, actor: string, detail: Record<string, unknown> = {}): Promise<void> {
  const { error } = await (admin as Db)
    .from("pay_period_events")
    .insert({ organization_id: period.organization_id, company_id: period.company_id, period_id: period.id, action, actor, detail });
  if (error) console.error("[recruiter] pay_period_events write failed:", error.message);
}

async function loadPeriod(admin: AdminClient, scope: { organizationId: string; companyId: string }, periodId: string): Promise<PayPeriodRow | null> {
  const { data } = await (admin as Db).from("pay_periods").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("id", periodId).maybeSingle();
  return (data as PayPeriodRow | null) ?? null;
}

async function csvEmailTo(admin: AdminClient, company: RecruiterCompany, deps: PayrollDeps): Promise<string | null> {
  return company.settings.payroll.csvEmail ?? (await deps.ownerEmail(admin, company.organizationId).catch(() => null));
}

// ── The sweep ────────────────────────────────────────────────────────────────

export interface PayrollSweepOutcome {
  companyId: string;
  status: "asked" | "empty" | "claimed_elsewhere" | "overlap" | "failed" | "not_due";
  periodId?: string;
}

/** Ask about the period that just ended for one company (the claim makes it once). */
export async function runCompanyPayroll(admin: AdminClient, company: RecruiterCompany, nowMs: number, deps: PayrollDeps = defaultPayrollDeps): Promise<PayrollSweepOutcome> {
  const db = admin as Db;
  const tz = company.timeZone;
  const today = localDate(new Date(nowMs), tz);
  const { frequency, anchorDate } = company.settings.payroll;
  const dates = previousPeriod(today, frequency, anchorDate);
  const dayAfter = addDays(dates.end, 1);
  const late = daysBetween(dayAfter, today);
  if (late < 0 || late > PAYROLL_CATCH_UP_DAYS || (late === 0 && localHour(nowMs, tz) < PAYROLL_HOUR)) return { companyId: company.companyId, status: "not_due" };

  // Already asked — or overlapping a period of an earlier schedule (frequency / anchor changed):
  // never count a day twice (the DB trigger pay_periods_no_overlap is the backstop).
  const { data: existing } = await db
    .from("pay_periods")
    .select("id, start_date")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .lte("start_date", dates.end)
    .gte("end_date", dates.start)
    .limit(1);
  const clash = ((existing ?? []) as Array<{ start_date: string }>)[0];
  if (clash) return { companyId: company.companyId, status: clash.start_date === dates.start ? "claimed_elsewhere" : "overlap" };

  const window = periodWindow(dates, tz, (await generalTimeCompanyId(admin, company.organizationId)) === company.companyId);
  const { data: claimed, error } = await db
    .from("pay_periods")
    .insert({
      organization_id: company.organizationId,
      company_id: company.companyId,
      frequency,
      start_date: dates.start,
      end_date: dates.end,
      starts_at: window.startsAt,
      ends_at: window.endsAt,
      status: "pending",
      covers_general_time: window.coversGeneralTime,
    })
    .select("*")
    .single();
  if (error || !claimed) return { companyId: company.companyId, status: "claimed_elsewhere" };
  const period = claimed as PayPeriodRow;
  try {
    const rows = await loadPeriodHours(admin, company, window);
    const totals = payrollTotals(rows);
    const counts = { people: totals.people, total_minutes: totals.totalMinutes, ot_minutes: totals.otMinutes, open_entries: totals.openEntries };
    if (rows.length === 0) {
      await db.from("pay_periods").update({ status: "empty", ...counts }).eq("id", period.id).eq("organization_id", company.organizationId);
      return { companyId: company.companyId, status: "empty", periodId: period.id };
    }
    const emailTo = await csvEmailTo(admin, company, deps);
    const approval = await createRecruiterApproval(
      admin,
      {
        organizationId: company.organizationId,
        companyId: company.companyId,
        kind: PAYROLL_PERIOD_KIND,
        summary: buildPayrollSummary({ companyName: company.name, period: dates, rows, emailTo }),
        payload: { periodId: period.id, start: dates.start, end: dates.end, openEntries: totals.openEntries },
      },
      nowMs,
      deps,
    );
    await db.from("pay_periods").update({ status: "awaiting_owner", approval_id: approval.id, ...counts }).eq("id", period.id).eq("organization_id", company.organizationId);
    await logEvent(admin, period, "asked", "system", { approvalId: approval.id, ...counts });
    return { companyId: company.companyId, status: "asked", periodId: period.id };
  } catch (err) {
    // Give the period back so a later pass (today or the catch-up days) tries again.
    await db.from("pay_periods").delete().eq("id", period.id).eq("organization_id", company.organizationId).eq("status", "pending");
    console.error("[recruiter] payroll period failed", company.companyId, err instanceof Error ? err.message : err);
    return { companyId: company.companyId, status: "failed" };
  }
}

export async function sweepPayroll(admin: AdminClient, nowMs: number, companies: RecruiterCompany[], deps: PayrollDeps = defaultPayrollDeps): Promise<PayrollSweepOutcome[]> {
  const out: PayrollSweepOutcome[] = [];
  for (const company of companies) {
    if (!company.settings.payroll.enabled) continue;
    try {
      out.push(await runCompanyPayroll(admin, company, nowMs, deps));
    } catch (err) {
      console.error("[recruiter] payroll sweep failed", company.companyId, err instanceof Error ? err.message : err);
    }
  }
  return out;
}

// ── Lock / unlock / CSV ──────────────────────────────────────────────────────

const LOCKABLE: PayPeriodRow["status"][] = ["pending", "awaiting_owner", "unlocked", "skipped", "expired"];

export interface LockResult {
  status: "locked" | "already_locked" | "not_lockable";
  rows: PersonHours[];
  emailedTo: string | null;
  emailError: string | null;
}

/** Lock a period's hours, then email the CSV. Shared by the approval and the Settings action. */
export async function lockPeriod(
  admin: AdminClient,
  company: RecruiterCompany,
  period: PayPeriodRow,
  options: { via: "sms" | "app"; by: string; anyway: boolean; nowMs: number },
  deps: PayrollDeps = defaultPayrollDeps,
): Promise<LockResult> {
  const db = admin as Db;
  if (period.status === "locked") return { status: "already_locked", rows: [], emailedTo: period.csv_emailed_to, emailError: null };
  if (!LOCKABLE.includes(period.status)) return { status: "not_lockable", rows: [], emailedTo: null, emailError: null };
  const rows = await loadPeriodHours(admin, company, windowOf(period));
  const totals = payrollTotals(rows);
  const nowIso = new Date(options.nowMs).toISOString();
  const { data: locked } = await db
    .from("pay_periods")
    .update({
      status: "locked",
      locked_at: nowIso,
      locked_via: options.via,
      locked_by: options.by,
      locked_with_open_entries: totals.openEntries > 0,
      people: totals.people,
      total_minutes: totals.totalMinutes,
      ot_minutes: totals.otMinutes,
      open_entries: totals.openEntries,
    })
    .eq("id", period.id)
    .eq("organization_id", company.organizationId)
    .eq("status", period.status)
    .select("id");
  if (((locked ?? []) as unknown[]).length === 0) return { status: "already_locked", rows, emailedTo: null, emailError: null };
  await logEvent(admin, period, "locked", options.by, { via: options.via, anyway: options.anyway, openEntries: totals.openEntries });
  const emailed = await emailPeriodCsv(admin, company, { ...period, status: "locked" }, rows, options.nowMs, deps);
  return { status: "locked", rows, emailedTo: emailed.to, emailError: emailed.error };
}

/** Email the CSV once per lock (claimed by csv_emailed_at). */
export async function emailPeriodCsv(
  admin: AdminClient,
  company: RecruiterCompany,
  period: PayPeriodRow,
  rows: PersonHours[],
  nowMs: number,
  deps: PayrollDeps = defaultPayrollDeps,
): Promise<{ to: string | null; error: string | null }> {
  const db = admin as Db;
  const to = await csvEmailTo(admin, company, deps);
  if (!to) return { to: null, error: "no email on file" };
  const { data: claim } = await db
    .from("pay_periods")
    .update({ csv_emailed_at: new Date(nowMs).toISOString(), csv_emailed_to: to, csv_email_error: null })
    .eq("id", period.id)
    .eq("organization_id", company.organizationId)
    .is("csv_emailed_at", null)
    .select("id");
  if (((claim ?? []) as unknown[]).length === 0) return { to, error: null };
  const dates = { start: period.start_date, end: period.end_date };
  const csv = payrollCsv(rows, dates);
  const totals = payrollTotals(rows);
  const lines = rows.map((r) => `${r.name}: ${hoursShort(r.regularMinutes)} regular${r.otMinutes ? `, ${hoursShort(r.otMinutes)} OT` : ""}${r.openEntries.length ? ` (${r.openEntries.length} open entry not counted)` : ""}`);
  const body = [
    `Payroll hours for ${company.name}, ${periodLabel(dates)} (${dates.start} to ${dates.end}).`,
    "",
    ...lines,
    "",
    `Total: ${hoursShort(totals.totalMinutes)}${totals.otMinutes ? `, ${hoursShort(totals.otMinutes)} overtime flagged` : ""}.`,
    "",
    "The CSV is attached: one row per person with regular hours, OT hours, total, pay rate, a gross estimate and job count.",
    "Overtime is flagged for hours over 44 in a work week (Ontario ESA) at 1.5x. The gross is an estimate before deductions - your payroll software does the real calculation.",
    "These hours are now locked. An owner or admin can unlock them in Settings > AI front desk > Hiring & payroll.",
  ].join("\n");
  try {
    // D7: the company's own sender when it has one.
    const fromAddress = await loadCompanyFromAddress(company.companyId);
    await deps.sendEmail({
      to,
      subject: `Payroll hours: ${periodLabel(dates)} (${company.name})`,
      body,
      fromName: company.name,
      ...(fromAddress ? { fromAddress } : {}),
      attachments: [{ filename: csvFilename(company.name, dates), content: Buffer.from(csv, "utf8").toString("base64") }],
    });
    await logEvent(admin, period, "csv_emailed", "system", { to });
    return { to, error: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await db.from("pay_periods").update({ csv_emailed_at: null, csv_email_error: reason.slice(0, 500) }).eq("id", period.id).eq("organization_id", company.organizationId);
    return { to, error: reason };
  }
}

/** Owner/admin: unlock a locked period (logged). Re-locking emails a fresh CSV. */
export async function unlockPeriod(
  admin: AdminClient,
  scope: { organizationId: string; companyId: string },
  periodId: string,
  actor: { profileId: string; reason: string | null },
  nowMs: number = Date.now(),
): Promise<PayPeriodRow | null> {
  const period = await loadPeriod(admin, scope, periodId);
  if (!period || period.status !== "locked") return period;
  const { data } = await (admin as Db)
    .from("pay_periods")
    .update({ status: "unlocked", unlocked_at: new Date(nowMs).toISOString(), unlocked_by: actor.profileId, unlock_reason: actor.reason, csv_emailed_at: null })
    .eq("id", period.id)
    .eq("organization_id", scope.organizationId)
    .eq("status", "locked")
    .select("*");
  const updated = ((data ?? []) as PayPeriodRow[])[0];
  if (updated) await logEvent(admin, period, "unlocked", `profile:${actor.profileId}`, { reason: actor.reason });
  return updated ?? (await loadPeriod(admin, scope, periodId));
}

/** Owner/admin: lock from Settings (e.g. after a skipped or expired ask). */
export async function lockPeriodFromApp(
  admin: AdminClient,
  scope: { organizationId: string; companyId: string },
  periodId: string,
  profileId: string,
  nowMs: number = Date.now(),
  deps: PayrollDeps = defaultPayrollDeps,
): Promise<{ period: PayPeriodRow | null; result: LockResult | null }> {
  const company = await loadRecruiterCompany(admin, scope.organizationId, scope.companyId);
  const period = await loadPeriod(admin, scope, periodId);
  if (!company || !period) return { period: null, result: null };
  const result = await lockPeriod(admin, company, period, { via: "app", by: `profile:${profileId}`, anyway: true, nowMs }, deps);
  return { period: await loadPeriod(admin, scope, periodId), result };
}

/** Any period's CSV (owner/admin download; logged). */
export async function periodCsvFile(
  admin: AdminClient,
  scope: { organizationId: string; companyId: string },
  periodId: string,
  profileId: string | null,
): Promise<{ filename: string; csv: string } | null> {
  const company = await loadRecruiterCompany(admin, scope.organizationId, scope.companyId);
  const period = await loadPeriod(admin, scope, periodId);
  if (!company || !period) return null;
  const rows = await loadPeriodHours(admin, company, windowOf(period));
  const dates = { start: period.start_date, end: period.end_date };
  await logEvent(admin, period, "csv_downloaded", profileId ? `profile:${profileId}` : "system");
  return { filename: csvFilename(company.name, dates), csv: payrollCsv(rows, dates) };
}

export async function recentPeriods(admin: AdminClient, scope: { organizationId: string; companyId: string }, limit = 8): Promise<PayPeriodRow[]> {
  const { data } = await (admin as Db)
    .from("pay_periods")
    .select("*")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .order("start_date", { ascending: false })
    .limit(limit);
  return (data ?? []) as PayPeriodRow[];
}

// ── The approval ─────────────────────────────────────────────────────────────

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function openList(rows: PersonHours[]): string {
  const all = rows.flatMap((r) => r.openEntries.map((o) => `${r.name.split(/\s+/)[0]} ${dayLabel(o.day)}`));
  return `${all.slice(0, 3).join(", ")}${all.length > 3 ? ` +${all.length - 3} more` : ""}`;
}

/** payroll_period: Y locks + emails the CSV; open entries → re-ask (or "Y 12 anyway"); N/expiry → not locked. */
export async function executePayrollPeriod(
  admin: AdminClient,
  approval: OwnerApprovalRow,
  decision: ApprovalDecision,
  deps: PayrollDeps = defaultPayrollDeps,
  nowMs: number = Date.now(),
): Promise<ExecuteResult> {
  const db = admin as Db;
  const code = approval.short_code ?? "?";
  const periodId = str(approval.payload?.periodId);
  const scope = { organizationId: approval.organization_id, companyId: approval.company_id };
  const period = periodId ? await loadPeriod(admin, scope, periodId) : null;
  if (!period) return { ok: false, message: `#${code} isn't linked to a pay period any more, so nothing was locked.` };
  const label = periodLabel({ start: period.start_date, end: period.end_date });

  if (!decision.approved) {
    const expired = decision.decidedVia === "expiry";
    await db
      .from("pay_periods")
      .update({ status: expired ? "expired" : "skipped" })
      .eq("id", period.id)
      .eq("organization_id", scope.organizationId)
      .eq("status", "awaiting_owner")
      .eq("approval_id", approval.id);
    await logEvent(admin, period, "skipped", expired ? "system" : `owner_${decision.decidedVia}:${decision.decidedBy}`, { expired });
    return {
      ok: true,
      message: expired
        ? `Payroll ${label} wasn't locked (no answer). You can lock it or download the CSV in Settings > AI front desk > Hiring & payroll.`
        : `OK, payroll ${label} isn't locked. You can lock it or download the CSV in Settings any time.`,
    };
  }

  if (period.status === "locked") return { ok: true, message: `Payroll ${label} is already locked.` };
  if (period.approval_id && period.approval_id !== approval.id) {
    return { ok: false, message: `#${code} is out of date - answer the newer payroll text for ${label}.` };
  }
  const company = await loadRecruiterCompany(admin, scope.organizationId, scope.companyId);
  if (!company) return { ok: false, message: "Business not found, so nothing was locked." };

  const anyway = (decision.ownerNote ?? "").trim().toLowerCase() === ANYWAY_NOTE;
  const rows = await loadPeriodHours(admin, company, windowOf(period));
  const totals = payrollTotals(rows);
  if (totals.openEntries > 0 && !anyway) {
    // Ask again with a fresh code (this one is used up); inline when the Y came by text.
    const emailTo = await csvEmailTo(admin, company, deps);
    const fresh = await createRecruiterApproval(
      admin,
      {
        organizationId: scope.organizationId,
        companyId: scope.companyId,
        kind: PAYROLL_PERIOD_KIND,
        summary: buildPayrollSummary({ companyName: company.name, period: { start: period.start_date, end: period.end_date }, rows, emailTo }),
        payload: { periodId: period.id, start: period.start_date, end: period.end_date, openEntries: totals.openEntries },
        askedInlineTo: smsDecider(decision),
      },
      nowMs,
      deps,
    );
    await db.from("pay_periods").update({ approval_id: fresh.id, open_entries: totals.openEntries }).eq("id", period.id).eq("organization_id", scope.organizationId).eq("approval_id", approval.id);
    const n = totals.openEntries;
    const c = fresh.shortCode ?? "?";
    return {
      ok: false,
      message: `Not locked yet: ${n} open ${n === 1 ? "entry" : "entries"} with no clock-out (${openList(rows)}). Fix ${n === 1 ? "it" : "them"} in the app, then reply Y ${c} - or Y ${c} anyway to lock as is (open entries count as 0).`,
      detail: { reaskedApprovalId: fresh.id },
    };
  }

  const result = await lockPeriod(admin, company, period, { via: decision.decidedVia === "sms" ? "sms" : "app", by: `owner_${decision.decidedVia}:${decision.decidedBy}`, anyway, nowMs }, deps);
  if (result.status === "already_locked") return { ok: true, message: `Payroll ${label} is already locked.` };
  if (result.status === "not_lockable") return { ok: false, message: `Payroll ${label} can't be locked from here - check Settings > AI front desk > Hiring & payroll.` };
  const lockedTotals = payrollTotals(result.rows);
  const what = `Locked payroll ${label} (${lockedTotals.people} ${lockedTotals.people === 1 ? "person" : "people"}, ${hoursShort(lockedTotals.totalMinutes)}${lockedTotals.otMinutes ? `, OT ${hoursShort(lockedTotals.otMinutes)}` : ""})`;
  const open = lockedTotals.openEntries ? ` ${lockedTotals.openEntries} open ${lockedTotals.openEntries === 1 ? "entry" : "entries"} left out.` : "";
  if (result.emailError || !result.emailedTo) {
    return {
      ok: true,
      message: `${what}, but the CSV email didn't go out${result.emailedTo ? ` to ${result.emailedTo}` : " (no email on file)"}. Download it in Settings > AI front desk > Hiring & payroll.${open}`,
    };
  }
  return { ok: true, message: `${what} and emailed the CSV to ${result.emailedTo}.${open}` };
}

export { localHour };
