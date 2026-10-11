/**
 * Local-time helpers for the Dispatcher. Every "when" is computed in the company's own zone
 * (DST-safe: days are built from local midnights with booking-windows.zonedInstant, never by
 * adding 24h). PURE.
 */
import { addDays, localDate, zonedInstant } from "@/server/services/booking-windows";

export const DEFAULT_TIMEZONE = "America/Toronto";

export function zoneOf(timeZone: string | null | undefined): string {
  const tz = timeZone?.trim();
  if (!tz) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

export { addDays, localDate, zonedInstant };

/** Minutes since local midnight at an instant. */
export function localMinutes(nowMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "numeric", minute: "numeric" }).formatToParts(new Date(nowMs));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Is local time within [from, until)? */
export function withinLocalHours(nowMs: number, timeZone: string, from: string, until: string): boolean {
  const now = localMinutes(nowMs, timeZone);
  const a = hhmmToMinutes(from);
  const b = hhmmToMinutes(until);
  return a <= b ? now >= a && now < b : now >= a || now < b;
}

/** The next instant (≥ now) local time is `hhmm` — today's if it's still ahead, else tomorrow's. */
export function nextLocalTime(nowMs: number, timeZone: string, hhmm: string): Date {
  const today = localDate(new Date(nowMs), timeZone);
  const at = zonedInstant(today, hhmm, timeZone);
  return at.getTime() >= nowMs ? at : zonedInstant(addDays(today, 1), hhmm, timeZone);
}

/** [start, end) of a local calendar day as UTC instants (23h / 25h on DST days). */
export function localDayRange(day: string, timeZone: string): { from: Date; to: Date } {
  return { from: zonedInstant(day, "00:00", timeZone), to: zonedInstant(addDays(day, 1), "00:00", timeZone) };
}

/** "Thu Oct 15" */
export function dayLabel(iso: string | Date, timeZone: string): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toLocaleDateString("en-CA", { timeZone, weekday: "short", month: "short", day: "numeric" }).replace(/[.,]/g, "");
}

/** End a sentence: "…9:00 a.m." already ends one — don't add a second period. */
export function sentence(text: string): string {
  return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

/** "9:00 a.m." */
export function timeLabel(iso: string | Date, timeZone: string): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toLocaleTimeString("en-CA", { timeZone, hour: "numeric", minute: "2-digit" });
}

/** "Thu Oct 15, 9:00 a.m." */
export function whenLabel(iso: string | Date, timeZone: string): string {
  return `${dayLabel(iso, timeZone)}, ${timeLabel(iso, timeZone)}`;
}

/** Compact "Thu 9am" / "Thu 1:30pm" for owner summaries (they're length-capped). */
export function shortLabel(iso: string | Date, timeZone: string): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const day = d.toLocaleDateString("en-CA", { timeZone, weekday: "short" }).replace(/\./g, "");
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hourCycle: "h12" }).formatToParts(d);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const period = (parts.find((p) => p.type === "dayPeriod")?.value ?? "").toLowerCase().replace(/\./g, "");
  return `${day} ${hour}${minute === "00" ? "" : `:${minute}`}${period}`;
}
