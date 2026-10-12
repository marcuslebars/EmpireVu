/** Local wall-clock helpers for Customer care (PURE). */
import { addDays, localDate, zonedInstant } from "@/server/services/booking-windows";
import { localHour } from "@/server/services/owner-channel/common";

export { addDays, localDate, zonedInstant };

/** Customer texts: 09:00–20:00 local. */
export const CUSTOMER_FROM_HOUR = 9;
export const CUSTOMER_UNTIL_HOUR = 20;
/** Owner alerts: 08:00–21:00 local (outside it they wait for the morning). */
export const OWNER_FROM_HOUR = 8;
export const OWNER_UNTIL_HOUR = 21;

export function inCustomerWindow(nowMs: number, timeZone: string): boolean {
  const h = localHour(nowMs, timeZone);
  return h >= CUSTOMER_FROM_HOUR && h < CUSTOMER_UNTIL_HOUR;
}

export function inOwnerWindow(nowMs: number, timeZone: string): boolean {
  const h = localHour(nowMs, timeZone);
  return h >= OWNER_FROM_HOUR && h < OWNER_UNTIL_HOUR;
}

/** The next moment a customer text may go (now when inside 09:00–20:00). */
export function nextCustomerOpening(nowMs: number, timeZone: string): number {
  if (inCustomerWindow(nowMs, timeZone)) return nowMs;
  const today = localDate(new Date(nowMs), timeZone);
  const day = localHour(nowMs, timeZone) < CUSTOMER_FROM_HOUR ? today : addDays(today, 1);
  return zonedInstant(day, "09:00", timeZone).getTime();
}

/** "9am today" / "9am tomorrow" (for the owner, when a customer text waits). */
export function nextOpeningLabel(nowMs: number, timeZone: string): string {
  return localHour(nowMs, timeZone) < CUSTOMER_FROM_HOUR ? "9am today" : "9am tomorrow";
}

/** An approval expiry that lands inside 09:00–20:00 local: `ttlMs` from now, pushed to the next 09:00 if needed. */
export function expiryInHours(nowMs: number, ttlMs: number, timeZone: string): Date {
  return new Date(nextCustomerOpening(nowMs + ttlMs, timeZone));
}

/** "May 4, 2026" from YYYY-MM-DD. */
export function longDate(ymd: string): string {
  const d = new Date(`${ymd.slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(d.getTime())) return ymd;
  return d.toLocaleDateString("en-CA", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).replace(/\./g, "");
}

/** Add whole months to YYYY-MM-DD, clamping to the month's last day (Jan 31 + 1 → Feb 28). */
export function addMonths(ymd: string, months: number): string {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const nd = Math.min(d, last);
  return `${ny}-${String(nm + 1).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}
