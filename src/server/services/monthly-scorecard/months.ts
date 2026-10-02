import { monthRangeInTimeZone, type PeriodRange } from "@/server/services/attribution";

/**
 * Calendar-month helpers for the monthly scorecard. A month is identified by its key
 * "YYYY-MM" and is ALWAYS interpreted in the company's timezone (companies.timezone →
 * BUSINESS_TIMEZONE → America/Toronto). Boundaries reuse attribution's DST-safe
 * `monthRangeInTimeZone`, so the scorecard and the "Captured" report agree on what
 * "October" means.
 */

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isMonthKey(value: string): boolean {
  return MONTH_KEY.test(value);
}

function parseMonthKey(key: string): { year: number; month: number } {
  const match = MONTH_KEY.exec(key);
  if (!match) throw new Error(`Invalid month "${key}" — expected YYYY-MM.`);
  return { year: Number(match[1]), month: Number(match[2]) };
}

function formatMonthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** The month key containing `nowMs`, in `timeZone`. */
export function monthKeyInTimeZone(timeZone: string, nowMs: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(
    new Date(nowMs),
  );
  const map: Record<string, string> = {};
  for (const part of parts) if (part.type !== "literal") map[part.type] = part.value;
  return `${map.year}-${map.month}`;
}

export function shiftMonthKey(key: string, delta: number): string {
  const { year, month } = parseMonthKey(key);
  const index = year * 12 + (month - 1) + delta;
  return formatMonthKey(Math.floor(index / 12), (index % 12) + 1);
}

export function previousMonthKey(key: string): string {
  return shiftMonthKey(key, -1);
}

/** `[from, to)` UTC instants of local midnight on the 1st of `key` and of the next month. */
export function monthRangeForKey(timeZone: string, key: string): PeriodRange {
  const { year, month } = parseMonthKey(key);
  // Mid-month noon UTC is unambiguously inside the local month in every real timezone.
  return monthRangeInTimeZone(timeZone, Date.UTC(year, month - 1, 15, 12, 0, 0));
}

/** "2026-10" → "2026-10-01" (the `month date` column value). */
export function monthKeyToDate(key: string): string {
  parseMonthKey(key);
  return `${key}-01`;
}

/** "2026-10" → "October" (or "October 2026" with `withYear`). */
export function monthLabel(key: string, withYear = false): string {
  const { year, month } = parseMonthKey(key);
  const name = new Intl.DateTimeFormat("en-CA", { month: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 15)),
  );
  return withYear ? `${name} ${year}` : name;
}
