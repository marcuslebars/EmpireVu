/**
 * Money, dates and wording for the Profit advisor's texts. PURE (no I/O).
 */
import { addDays, localDate, zonedInstant } from "@/server/services/booking-windows";

export const DISCLAIMER = "Estimates from your app data - not financial advice.";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "$1,240" / "$4.50" (cents only when there are some). */
export function dollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}$${(abs / 100).toLocaleString("en-CA", { minimumFractionDigits: abs % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/** Whole dollars, rounded: "$3,100". */
export function wholeDollars(cents: number): string {
  return dollars(Math.round(cents / 100) * 100);
}

/** Short money for texts: "$840", "$7.4k", "$11k". */
export function shortMoney(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const d = Math.abs(cents) / 100;
  if (d < 1000) return `${sign}$${Math.round(d).toLocaleString("en-CA")}`;
  if (d < 9_950) {
    const k = Math.round(d / 100) / 10;
    return `${sign}$${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  return `${sign}$${Math.round(d / 1000).toLocaleString("en-CA")}k`;
}

/** "37%" from a ratio (0.37) — whole percent. */
export function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** "Nov 6" (and ", 2027" when not `refYear`). */
export function shortDate(ymd: string, refYear?: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}${refYear != null && y !== refYear ? `, ${y}` : ""}`;
}

/** "Fri Oct 16". */
export function dayLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${MONTHS[m - 1]} ${d}`;
}

/** Whole days from `from` to `to` (YYYY-MM-DD); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export { addDays };

/** The company's local calendar date for an instant. */
export function localDay(ms: number, timeZone: string): string {
  return localDate(new Date(ms), timeZone);
}

/** Local weekday (0 = Sunday) of a YYYY-MM-DD. */
export function weekdayOfDate(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Local wall clock "HH:MM" now. */
export function localHHMM(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("hour").padStart(2, "0").replace("24", "00")}:${get("minute").padStart(2, "0")}`;
}

/** UTC ISO of local midnight starting `ymd` (DST-safe). */
export function localMidnightIso(ymd: string, timeZone: string): string {
  return zonedInstant(ymd, "00:00", timeZone).toISOString();
}

/** The Monday on or before `ymd`. */
export function mondayOf(ymd: string): string {
  return addDays(ymd, -((weekdayOfDate(ymd) + 6) % 7));
}

/** The first Tuesday of the month containing `ymd`. */
export function firstTuesdayOf(ymd: string): string {
  const first = `${ymd.slice(0, 8)}01`;
  return addDays(first, (2 - weekdayOfDate(first) + 7) % 7);
}

/** One line of text, trimmed to `max` with "...". */
export function clip(text: string | null | undefined, max: number): string {
  const t = (text ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
}

/** "Jones roof replacement" from the customer's name and the job title. */
export function jobName(input: { contactName: string | null; title: string | null }): string {
  const parts = (input.contactName ?? "").trim().split(/\s+/).filter(Boolean);
  const who = parts.length ? parts[parts.length - 1] : "";
  const title = (input.title ?? "").trim();
  const what = title ? title.charAt(0).toLowerCase() + title.slice(1) : "job";
  return clip(who ? `${who} ${what}` : title || "a job", 40);
}

/** "9h" / "1h 30m". */
export function hours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m && h < 10 ? `${h}h ${m}m` : `${Math.round(minutes / 60)}h`;
}
