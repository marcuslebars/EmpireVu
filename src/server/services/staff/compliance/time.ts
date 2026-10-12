/** Local wall-clock helpers for Compliance (PURE). */
const DEFAULT_ZONE = "America/Toronto";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface LocalParts {
  date: string;
  hour: number;
  /** 0 = Sunday */
  weekday: number;
}

export function localParts(nowMs: number, timeZone: string | null | undefined): LocalParts {
  const zone = timeZone?.trim() || DEFAULT_ZONE;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(new Date(nowMs));
  } catch {
    return localParts(nowMs, DEFAULT_ZONE);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number.parseInt(get("hour"), 10) % 24, weekday: Math.max(0, WEEKDAYS.indexOf(get("weekday"))) };
}

export function localDate(nowMs: number, timeZone: string | null | undefined): string {
  return localParts(nowMs, timeZone).date;
}

/** Texts to subs and customers: 09:00–20:00 local (any day — they asked, or it's their paperwork). */
export const SEND_WINDOW = { startHour: 9, endHour: 20 } as const;

export function inSendWindow(nowMs: number, timeZone: string | null | undefined): boolean {
  const p = localParts(nowMs, timeZone);
  return p.hour >= SEND_WINDOW.startHour && p.hour < SEND_WINDOW.endHour;
}

/** The next 09:00 local after `nowMs` (or today's, before 9am), as an instant. DST-safe to the hour. */
export function nextWindowStart(nowMs: number, timeZone: string | null | undefined): number {
  let t = nowMs;
  // Step forward to the top of the next hour, then hour by hour until 09:00 local (≤ 25 steps).
  t = Math.ceil(t / 3_600_000) * 3_600_000;
  for (let i = 0; i < 26; i++) {
    if (localParts(t, timeZone).hour === SEND_WINDOW.startHour) return t;
    t += 3_600_000;
  }
  return nowMs + 12 * 3_600_000;
}

/** "9am today" / "9am tomorrow" — when a queued text goes out (for the owner). */
export function nextWindowLabel(nowMs: number, timeZone: string | null | undefined): string {
  return localParts(nowMs, timeZone).hour < SEND_WINDOW.startHour ? "9am today" : "9am tomorrow";
}
