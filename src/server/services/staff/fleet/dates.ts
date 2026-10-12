/** Dates, wall-clock and number formatting for Fleet (PURE). Dates are "YYYY-MM-DD". */
import { addDays, isValidDateString, localDate as bwLocalDate } from "@/server/services/booking-windows";

export { addDays, isValidDateString };

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface LocalParts {
  date: string;
  hour: number;
  minute: number;
}

export function localParts(nowMs: number, timeZone: string): LocalParts {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(nowMs));
  } catch {
    return localParts(nowMs, "America/Toronto");
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number.parseInt(get("hour"), 10) % 24, minute: Number.parseInt(get("minute"), 10) || 0 };
}

export function localDateOf(atMs: number, timeZone: string): string {
  try {
    return bwLocalDate(new Date(atMs), timeZone);
  } catch {
    return bwLocalDate(new Date(atMs), "America/Toronto");
  }
}

function utcOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((utcOf(to) - utcOf(from)) / DAY_MS);
}

/** Add calendar months, clamping the day (Jan 31 + 1 month → Feb 28/29). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** "Oct 14" */
export function shortDate(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${MONTHS[m - 1] ?? ""} ${d}`;
}

/** "Mar 31, 2027" */
export function prettyDate(date: string): string {
  const [y] = date.split("-");
  return `${shortDate(date)}, ${y}`;
}

/** "5pm" / "5:30pm" in the zone. */
export function timeLabel(atMs: number, timeZone: string): string {
  const p = localParts(atMs, timeZone);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const ampm = p.hour < 12 ? "am" : "pm";
  return p.minute ? `${h12}:${String(p.minute).padStart(2, "0")}${ampm}` : `${h12}${ampm}`;
}

/** "84,200" */
export function fmtNum(n: number): string {
  return Math.round(n).toLocaleString("en-CA");
}

/** "$380" / "$37.50" / "$1,140" */
export function money(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars.toLocaleString("en-CA")}` : `$${dollars.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "HH:MM" 24h, or null. Accepts "17:00", "5pm", "5:30 pm", "noon". */
export function parseClock(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase().replace(/\./g, "");
  if (!s) return null;
  if (s === "noon") return "12:00";
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    if (m[3] === "pm" && h !== 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
  } else if (h > 23) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
