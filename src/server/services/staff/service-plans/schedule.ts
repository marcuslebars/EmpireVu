/**
 * Plan schedule maths and wording. PURE (no I/O): calendar dates are "YYYY-MM-DD" strings, time
 * zones are applied where a visit becomes a booking (recurring/service.ts generateVisits).
 *
 * A plan visits once in each of its months per term, on the Nth <weekday> of that month (e.g. the
 * first Tuesday of May and of October). A term is 12 months: term_start .. term_end inclusive.
 */
import type { PlanBilling } from "./db-types";

const DAY = 86_400_000;
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface PlanSchedule {
  months: number[];
  weekday: number;
  week: number;
}

function toUtc(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function ymdOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDaysYmd(ymd: string, days: number): string {
  return ymdOf(toUtc(ymd) + days * DAY);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / DAY);
}

/** The same calendar day N years later (Feb 29 → Feb 28). */
export function addYearsYmd(ymd: string, years: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const last = new Date(Date.UTC(y + years, m, 0)).getUTCDate();
  return ymdOf(Date.UTC(y + years, m - 1, Math.min(d, last)));
}

/** A 12-month term starting `start`: the inclusive last day. */
export function termEndFor(start: string): string {
  return addDaysYmd(addYearsYmd(start, 1), -1);
}

/** The Nth (1-4) <weekday> (0 = Sunday) of a month. */
export function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const offset = (weekday - first + 7) % 7;
  return ymdOf(Date.UTC(year, month - 1, 1 + offset + (Math.min(Math.max(n, 1), 4) - 1) * 7));
}

export function cleanMonths(months: unknown): number[] {
  if (!Array.isArray(months)) return [];
  return [...new Set(months.map(Number).filter((m) => Number.isInteger(m) && m >= 1 && m <= 12))].sort((a, b) => a - b);
}

/**
 * The visit dates of one term: for each plan month, the first Nth-weekday date in
 * [max(termStart, earliest), termEnd]. A month whose date this term has already passed (signing
 * up in late May for a May + Oct plan) gets no visit this term. Sorted.
 */
export function termVisitDates(schedule: PlanSchedule, termStart: string, termEnd: string, earliest: string = termStart): string[] {
  const from = earliest > termStart ? earliest : termStart;
  const y0 = Number(termStart.slice(0, 4));
  const out: string[] = [];
  for (const month of cleanMonths(schedule.months)) {
    for (const year of [y0, y0 + 1]) {
      const date = nthWeekday(year, month, schedule.weekday, schedule.week);
      if (date >= from && date <= termEnd) {
        out.push(date);
        break;
      }
    }
  }
  return out.sort();
}

export function seasonOf(month: number): "spring" | "summer" | "fall" | "winter" {
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  if (month >= 9 && month <= 11) return "fall";
  return "winter";
}

/** "spring visit" — or "June visit" when the plan has two visits in the same season. */
export function visitName(date: string, planMonths: number[]): string {
  const month = Number(date.slice(5, 7));
  const season = seasonOf(month);
  const shared = cleanMonths(planMonths).filter((m) => seasonOf(m) === season).length > 1;
  return `${shared ? MONTH_LONG[month - 1] : season} visit`;
}

/** "May + Oct". */
export function monthsText(months: number[]): string {
  return cleanMonths(months).map((m) => MONTH_SHORT[m - 1]).join(" + ") || "no months";
}

/** "Tue May 5". */
export function dayText(date: string): string {
  const d = new Date(toUtc(date));
  return `${WEEKDAY_SHORT[d.getUTCDay()]} ${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "May 5, 2027". */
export function longDate(date: string): string {
  const d = new Date(toUtc(date));
  return `${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** "Nov 1". */
export function shortDate(date: string): string {
  const d = new Date(toUtc(date));
  return `${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "morning" / "afternoon" / "evening" for a visit's HH:MM start. */
export function partOfDay(hhmm: string): string {
  const h = Number(hhmm.slice(0, 2));
  if (!Number.isFinite(h) || h < 12) return "morning";
  return h < 17 ? "afternoon" : "evening";
}

/** "$420" / "$474.60". */
export function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/** "$420/yr" / "$95/visit". */
export function priceText(priceCents: number, billing: PlanBilling): string {
  return `${money(priceCents)}/${billing === "annual" ? "yr" : "visit"}`;
}

/** "the first Tuesday of May and Oct, mornings". */
export function scheduleSentence(schedule: PlanSchedule, timeOfDay: string): string {
  const nth = ["first", "second", "third", "fourth"][Math.min(Math.max(schedule.week, 1), 4) - 1];
  return `the ${nth} ${WEEKDAY_LONG[schedule.weekday] ?? "Monday"} of ${cleanMonths(schedule.months).map((m) => MONTH_SHORT[m - 1]).join(", ")}, ${partOfDay(timeOfDay)}s`;
}
