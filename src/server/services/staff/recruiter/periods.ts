/**
 * Pay periods, hours and the payroll CSV — the PURE half of the Recruiter's payroll
 * (docs/ai-staff.md → "Hiring & payroll").
 *
 *   • Periods: weekly / bi-weekly from an anchor date (the first day of any one period), or
 *     semi-monthly (1st–15th, 16th–end of month). Dates are the company's local calendar dates.
 *   • Hours per person come from time_entries (time/logic.ts workedMinutes, breaks subtracted).
 *     An entry belongs to the local day it starts on. An open entry (no clock-out) counts as 0
 *     and is listed, so a forgotten clock never pads a cheque.
 *   • Ontario overtime: hours past 44 in a work week are flagged at 1.5×. The work week starts on
 *     the anchor's weekday (weekly / bi-weekly) or Monday (semi-monthly). A work week that
 *     straddles the period start counts the hours before the period toward the 44, so a
 *     semi-monthly period still flags the right hours. This is a flag in the export, never a
 *     payroll calculation: no averaging agreements, no exemptions, no tax.
 */
import { csvCell, workedMinutes } from "@/server/services/time/logic";
import type { PayFrequency, PayrollEntry } from "./db-types";

/** Ontario ESA: overtime after 44 hours in a work week. */
export const OT_THRESHOLD_MINUTES = 44 * 60;
export const OT_MULTIPLIER = 1.5;
/** A clock-out written within this long of `updated_at` is the clock-out, not an edit. */
const CLOCK_OUT_SLACK_MS = 10 * 60_000;

// ── Dates ────────────────────────────────────────────────────────────────────

function toUtc(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return fromUtc(toUtc(day) + n * 86_400_000);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(day: string): number {
  return new Date(toUtc(day)).getUTCDay();
}

function lastDayOfMonth(day: string): string {
  const [y, m] = day.split("-").map(Number);
  return fromUtc(Date.UTC(y, m, 0));
}

export interface PeriodDates {
  /** First local day (inclusive). */
  start: string;
  /** Last local day (inclusive). */
  end: string;
}

/** The pay period that contains local day `day`. PURE. */
export function periodContaining(day: string, frequency: PayFrequency, anchor: string): PeriodDates {
  if (frequency === "semimonthly") {
    const [y, m, d] = day.split("-").map(Number);
    const first = fromUtc(Date.UTC(y, m - 1, 1));
    if (d <= 15) return { start: first, end: addDays(first, 14) };
    return { start: addDays(first, 15), end: lastDayOfMonth(day) };
  }
  const length = frequency === "weekly" ? 7 : 14;
  const offset = daysBetween(anchor, day);
  const index = Math.floor(offset / length);
  const start = addDays(anchor, index * length);
  return { start, end: addDays(start, length - 1) };
}

/** The last period that ended before local day `today` (i.e. the one before today's). PURE. */
export function previousPeriod(today: string, frequency: PayFrequency, anchor: string): PeriodDates {
  const current = periodContaining(today, frequency, anchor);
  return periodContaining(addDays(current.start, -1), frequency, anchor);
}

/** Weekday the work week starts on (for the 44-hour rule). PURE. */
export function workWeekStartDay(frequency: PayFrequency, anchor: string): number {
  return frequency === "semimonthly" ? 1 : weekday(anchor);
}

/** First day of the work week containing `day`. PURE. */
export function workWeekStart(day: string, startDay: number): string {
  const back = (weekday(day) - startDay + 7) % 7;
  return addDays(day, -back);
}

/** "Sep 28" */
export function shortDate(day: string): string {
  return new Date(toUtc(day)).toLocaleDateString("en-CA", { timeZone: "UTC", month: "short", day: "numeric" }).replace(/\./g, "");
}

/** "Sep 28 - Oct 11" */
export function periodLabel(p: PeriodDates): string {
  return `${shortDate(p.start)} - ${shortDate(p.end)}`;
}

/** "Tue Oct 6" */
export function dayLabel(day: string): string {
  return new Date(toUtc(day)).toLocaleDateString("en-CA", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).replace(/[.,]/g, "");
}

/** "78.5h", "40h" (owner texts). */
export function hoursShort(minutes: number): string {
  const h = Math.round((minutes / 60) * 10) / 10;
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}

/** "78.50" (CSV). */
export function hoursDecimal(minutes: number): string {
  return (Math.round((minutes / 60) * 100) / 100).toFixed(2);
}

// ── Hours ────────────────────────────────────────────────────────────────────

export interface PersonInfo {
  name: string;
  email: string | null;
}

export interface PersonHours {
  profileId: string;
  name: string;
  email: string | null;
  regularMinutes: number;
  otMinutes: number;
  totalMinutes: number;
  /** Entries in the period with no clock-out (counted as 0). */
  openEntries: Array<{ id: string; day: string }>;
  /** Entries in the period changed or added after the period ended. */
  editedAfter: number;
  jobCount: number;
  /** member_pay_rates.hourly_cost_cents, when set. */
  rateCents: number | null;
  /** regular × rate + OT × rate × 1.5 (an estimate, before deductions). */
  grossCents: number | null;
}

export interface PayrollInput {
  /** Entries from the start of the first work week touching the period, up to its end. */
  entries: PayrollEntry[];
  startsAtMs: number;
  endsAtMs: number;
  timeZone: string;
  weekStartDay: number;
  people: Map<string, PersonInfo>;
  rates: Map<string, number>;
}

export function localDay(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone });
}

/** Per-person regular / OT hours for one period, sorted by name. PURE. */
export function computePayroll(input: PayrollInput): PersonHours[] {
  const byPerson = new Map<string, PayrollEntry[]>();
  for (const e of input.entries) {
    const started = Date.parse(e.started_at);
    if (!Number.isFinite(started) || started >= input.endsAtMs) continue;
    byPerson.set(e.profile_id, [...(byPerson.get(e.profile_id) ?? []), e]);
  }
  const out: PersonHours[] = [];
  for (const [profileId, list] of byPerson) {
    list.sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
    const weekTotals = new Map<string, number>();
    let regular = 0;
    let ot = 0;
    let editedAfter = 0;
    const open: Array<{ id: string; day: string }> = [];
    const jobs = new Set<string>();
    let inPeriod = 0;
    for (const e of list) {
      const day = localDay(e.started_at, input.timeZone);
      const minutes = e.ended_at ? workedMinutes(e) : 0;
      const week = workWeekStart(day, input.weekStartDay);
      const before = weekTotals.get(week) ?? 0;
      const after = before + minutes;
      weekTotals.set(week, after);
      const started = Date.parse(e.started_at);
      if (started < input.startsAtMs) continue; // only counts toward the week's 44
      inPeriod += 1;
      const otPart = Math.max(0, after - OT_THRESHOLD_MINUTES) - Math.max(0, before - OT_THRESHOLD_MINUTES);
      ot += otPart;
      regular += minutes - otPart;
      if (!e.ended_at) open.push({ id: e.id, day });
      if (e.booking_id) jobs.add(e.booking_id);
      const created = Date.parse(e.created_at);
      const updated = Date.parse(e.updated_at);
      const ended = e.ended_at ? Date.parse(e.ended_at) : null;
      const lateAdd = Number.isFinite(created) && created >= input.endsAtMs;
      const lateEdit = Number.isFinite(updated) && updated >= input.endsAtMs && (ended === null || updated - ended > CLOCK_OUT_SLACK_MS);
      if (lateAdd || lateEdit) editedAfter += 1;
    }
    if (inPeriod === 0) continue;
    const info = input.people.get(profileId);
    const rate = input.rates.get(profileId);
    const rateCents = typeof rate === "number" ? rate : null;
    out.push({
      profileId,
      name: info?.name ?? "Team member",
      email: info?.email ?? null,
      regularMinutes: regular,
      otMinutes: ot,
      totalMinutes: regular + ot,
      openEntries: open,
      editedAfter,
      jobCount: jobs.size,
      rateCents,
      grossCents: rateCents === null ? null : Math.round((regular * rateCents) / 60 + (ot * rateCents * OT_MULTIPLIER) / 60),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface PayrollTotals {
  people: number;
  totalMinutes: number;
  otMinutes: number;
  openEntries: number;
  editedAfter: number;
}

export function payrollTotals(rows: PersonHours[]): PayrollTotals {
  return rows.reduce<PayrollTotals>(
    (t, r) => ({
      people: t.people + 1,
      totalMinutes: t.totalMinutes + r.totalMinutes,
      otMinutes: t.otMinutes + r.otMinutes,
      openEntries: t.openEntries + r.openEntries.length,
      editedAfter: t.editedAfter + r.editedAfter,
    }),
    { people: 0, totalMinutes: 0, otMinutes: 0, openEntries: 0, editedAfter: 0 },
  );
}

// ── CSV ──────────────────────────────────────────────────────────────────────

export const CSV_HEADER = [
  "employee_name",
  "employee_email",
  "period_start",
  "period_end",
  "regular_hours",
  "ot_hours",
  "total_hours",
  "hourly_rate",
  "gross_estimate",
  "job_count",
  "notes",
];

function money(cents: number | null): string {
  return cents === null ? "" : (cents / 100).toFixed(2);
}

/** Notes for one person's CSV row. PURE. */
export function rowNotes(r: PersonHours): string {
  const notes: string[] = [];
  if (r.otMinutes > 0) notes.push(`OT ${hoursDecimal(r.otMinutes)}h flagged (Ontario: over 44h/week at 1.5x)`);
  if (r.openEntries.length) notes.push(`${r.openEntries.length} open ${r.openEntries.length === 1 ? "entry" : "entries"} not counted (no clock-out: ${r.openEntries.map((o) => o.day).join(", ")})`);
  if (r.editedAfter) notes.push(`${r.editedAfter} changed after the period ended`);
  if (r.rateCents === null) notes.push("no pay rate on file");
  return notes.join("; ");
}

/**
 * The generic payroll CSV (one row per person; columns most payroll tools can map). Gross is an
 * estimate (regular × rate + OT × 1.5 × rate) before any deductions — no tax maths. PURE.
 */
export function payrollCsv(rows: PersonHours[], period: PeriodDates): string {
  const lines = [CSV_HEADER.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.name),
        csvCell(r.email ?? ""),
        period.start,
        period.end,
        hoursDecimal(r.regularMinutes),
        hoursDecimal(r.otMinutes),
        hoursDecimal(r.totalMinutes),
        money(r.rateCents),
        money(r.grossCents),
        String(r.jobCount),
        csvCell(rowNotes(r)),
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function csvFilename(companyName: string, period: PeriodDates): string {
  const slug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "payroll";
  return `${slug}-payroll-${period.start}-to-${period.end}.csv`;
}

// ── The owner's text ─────────────────────────────────────────────────────────

const SUMMARY_MAX = 470;

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function personLine(r: PersonHours): string {
  return `${firstName(r.name)} ${hoursShort(r.totalMinutes)}${r.otMinutes > 0 ? ` (OT ${hoursShort(r.otMinutes)})` : ""}`;
}

/**
 * The payroll_period approval text (without the reply line): each person's hours and OT, open
 * entries, edits since the period ended, and what Y does. ≤ 470 chars: people fold into
 * "+N more". PURE.
 */
export function buildPayrollSummary(input: { companyName: string; period: PeriodDates; rows: PersonHours[]; emailTo: string | null }): string {
  const { rows, period } = input;
  const totals = payrollTotals(rows);
  const open = rows.flatMap((r) => r.openEntries.map((o) => `${firstName(r.name)} ${dayLabel(o.day)}`));
  const tail: string[] = [];
  if (open.length) tail.push(`${open.length} open ${open.length === 1 ? "entry" : "entries"} (no clock-out): ${open.slice(0, 3).join(", ")}${open.length > 3 ? ` +${open.length - 3} more` : ""}.`);
  if (totals.editedAfter) tail.push(`${totals.editedAfter} ${totals.editedAfter === 1 ? "entry was" : "entries were"} changed after the period ended.`);
  const what = input.emailTo ? `Y locks these hours and emails the CSV to ${input.emailTo}.` : "Y locks these hours (no email on file - download the CSV in Settings).";
  const head = `Payroll ${periodLabel(period)}: `;
  const ot = totals.otMinutes > 0 ? `, OT ${hoursShort(totals.otMinutes)} flagged (over 44h/wk)` : "";
  const total = ` Total ${hoursShort(totals.totalMinutes)}${ot}.`;
  const fixed = `${total}${tail.length ? ` ${tail.join(" ")}` : ""} ${what}`;
  const lines = rows.map(personLine);
  for (let shown = lines.length; shown >= 1; shown--) {
    const rest = rows.slice(shown);
    const more = rest.length ? `, +${rest.length} more (${hoursShort(rest.reduce((s, r) => s + r.totalMinutes, 0))})` : "";
    const text = `${head}${lines.slice(0, shown).join(", ")}${more}.${fixed}`;
    if (text.length <= SUMMARY_MAX) return text;
  }
  const text = `${head}${rows.length} people.${fixed}`;
  return text.length <= SUMMARY_MAX ? text : `${text.slice(0, SUMMARY_MAX - 3)}...`;
}
