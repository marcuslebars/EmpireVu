/** Local wall-clock helpers for the Email inbox (PURE). */
import { localDate } from "@/server/services/booking-windows";

export function localDateOf(nowMs: number, timeZone: string): string {
  return localDate(new Date(nowMs), timeZone);
}

/** Minutes since local midnight. */
export function localMinutes(nowMs: number, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(nowMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
    return (get("hour") % 24) * 60 + get("minute");
  } catch {
    return localMinutes(nowMs, "America/Toronto");
  }
}

/** "16:00" → 960. */
export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
