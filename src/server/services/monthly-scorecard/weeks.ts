import type { PeriodRange } from "@/server/services/attribution";
import { tzOffsetMs } from "@/server/services/attribution";

/**
 * Calendar-week helpers (Monday–Sunday) for the weekly front-desk report — the week twin of
 * months.ts. A week is identified by the date of its Monday, "YYYY-MM-DD", and is ALWAYS
 * interpreted in the company's timezone. Boundaries are local midnight Monday → local midnight
 * the next Monday, computed DST-safely (a week containing a spring-forward is 167 hours long,
 * a fall-back week 169).
 */

const DATE_KEY = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DAY_MS = 86_400_000;

export function isDateKey(value: string): boolean {
  const match = DATE_KEY.exec(value);
  if (!match) return false;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(ms).toISOString().slice(0, 10) === value;
}

function parseDateKey(key: string): number {
  if (!isDateKey(key)) throw new Error(`Invalid date "${key}" — expected YYYY-MM-DD.`);
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function formatDateKey(utcMidnightMs: number): string {
  return new Date(utcMidnightMs).toISOString().slice(0, 10);
}

/** A week key is a valid date that falls on a Monday. */
export function isWeekKey(value: string): boolean {
  return isDateKey(value) && new Date(parseDateKey(value)).getUTCDay() === 1;
}

/** Any date → the Monday of its Monday–Sunday week ("2026-10-08" → "2026-10-05"). */
export function weekKeyForDate(dateKey: string): string {
  const ms = parseDateKey(dateKey);
  const dow = new Date(ms).getUTCDay(); // 0 Sun … 6 Sat
  const sinceMonday = (dow + 6) % 7;
  return formatDateKey(ms - sinceMonday * DAY_MS);
}

/** The local calendar date ("YYYY-MM-DD") at `nowMs` in `timeZone`. */
export function localDateKey(timeZone: string, nowMs: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(
    new Date(nowMs),
  );
  const map: Record<string, string> = {};
  for (const part of parts) if (part.type !== "literal") map[part.type] = part.value;
  return `${map.year}-${map.month}-${map.day}`;
}

/** The week key containing `nowMs`, in `timeZone`. */
export function weekKeyInTimeZone(timeZone: string, nowMs: number): string {
  return weekKeyForDate(localDateKey(timeZone, nowMs));
}

export function shiftWeekKey(key: string, delta: number): string {
  return formatDateKey(parseDateKey(key) + delta * 7 * DAY_MS);
}

export function previousWeekKey(key: string): string {
  return shiftWeekKey(key, -1);
}

/**
 * UTC instant of a local wall-clock time. Two passes: the offset is first taken at the naive
 * instant, then re-taken at the corrected one, so a wall time just after a DST switch lands
 * on the right side of it.
 */
export function localWallTimeToUtcMs(dateKey: string, hour: number, minute: number, timeZone: string): number {
  const naive = parseDateKey(dateKey) + hour * 3_600_000 + minute * 60_000;
  const guess = naive - tzOffsetMs(naive, timeZone);
  return naive - tzOffsetMs(guess, timeZone);
}

/** `[from, to)` UTC instants of local midnight Monday of `key` and of the following Monday. */
export function weekRangeForKey(timeZone: string, key: string): PeriodRange {
  if (!isWeekKey(key)) throw new Error(`Invalid week "${key}" — expected the YYYY-MM-DD of a Monday.`);
  return {
    from: new Date(localWallTimeToUtcMs(key, 0, 0, timeZone)).toISOString(),
    to: new Date(localWallTimeToUtcMs(shiftWeekKey(key, 1), 0, 0, timeZone)).toISOString(),
  };
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthDay(ms: number): { month: string; day: number; year: number } {
  const date = new Date(ms);
  return { month: SHORT_MONTHS[date.getUTCMonth()], day: date.getUTCDate(), year: date.getUTCFullYear() };
}

/**
 * "Oct 5 – 11" / "Sep 28 – Oct 4" (en dash, for email + app). `ascii` gives "Oct 5-11" for
 * SMS (GSM-7 safe). `withYear` appends the year of the Sunday.
 */
export function weekLabel(key: string, options: { ascii?: boolean; withYear?: boolean } = {}): string {
  const start = monthDay(parseDateKey(key));
  const end = monthDay(parseDateKey(key) + 6 * DAY_MS);
  const dash = options.ascii ? "-" : " – ";
  const body = start.month === end.month ? `${start.month} ${start.day}${dash}${end.day}` : `${start.month} ${start.day}${dash}${end.month} ${end.day}`;
  return options.withYear ? `${body}, ${end.year}` : body;
}
