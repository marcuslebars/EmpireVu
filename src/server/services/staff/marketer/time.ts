/** Local-time helpers for the Marketer (company timezone). PURE. */
import type { SendWindow } from "@/server/services/staff/marketer/db-types";

export interface LocalParts {
  /** YYYY-MM-DD */
  date: string;
  /** YYYY-MM */
  month: string;
  hour: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function localParts(nowMs: number, timeZone: string): LocalParts {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "numeric",
      hourCycle: "h23",
      weekday: "short",
    }).formatToParts(new Date(nowMs));
  } catch {
    return localParts(nowMs, "America/Toronto");
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return { date, month: date.slice(0, 7), hour: Number.parseInt(get("hour"), 10) % 24, weekday: Math.max(0, WEEKDAYS.indexOf(get("weekday"))) };
}

/** The Monday (YYYY-MM-DD) of the local week containing nowMs. */
export function localWeekStart(nowMs: number, timeZone: string): string {
  const p = localParts(nowMs, timeZone);
  const offset = (p.weekday + 6) % 7; // Monday → 0
  const d = new Date(`${p.date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

/** Inside the campaign send window (day of week + [startHour, endHour) local)? */
export function inSendWindow(nowMs: number, timeZone: string, window: Pick<SendWindow, "startHour" | "endHour" | "days">): boolean {
  const p = localParts(nowMs, timeZone);
  return window.days.includes(p.weekday) && p.hour >= window.startHour && p.hour < window.endHour;
}

/** Proactive texts (and owner heads-ups that aren't approvals) only 09:00–20:00 local. */
export function inProactiveHours(nowMs: number, timeZone: string): boolean {
  const h = localParts(nowMs, timeZone).hour;
  return h >= 9 && h < 20;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function hourLabel(h: number): string {
  if (h === 0 || h === 24) return "midnight";
  if (h === 12) return "noon";
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

/** "Mon-Sat 10am-7pm, up to 30/hour" */
export function describeWindow(window: SendWindow): string {
  const days = [...window.days].sort((a, b) => a - b);
  const contiguous = days.length > 1 && days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  const dayText = days.length === 7 ? "Every day" : contiguous ? `${DAY_NAMES[days[0]]}-${DAY_NAMES[days[days.length - 1]]}` : days.map((d) => DAY_NAMES[d]).join("/");
  return `${dayText} ${hourLabel(window.startHour)}-${hourLabel(window.endHour)}, up to ${window.perHour}/hour`;
}

/** The season an Ontario business is heading into, for the message hook. */
export function seasonFor(month: number): { season: string; hint: string } {
  if (month === 12) return { season: "holidays / early winter", hint: "the holidays and winter" };
  if (month <= 2) return { season: "winter", hint: "the rest of winter and planning for spring" };
  if (month <= 5) return { season: "spring", hint: "spring" };
  if (month <= 8) return { season: "summer", hint: "summer" };
  return { season: "fall", hint: "fall and getting ready for winter" };
}
