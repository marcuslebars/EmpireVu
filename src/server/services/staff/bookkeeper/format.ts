/**
 * Money, dates, names and the customer send window for the Bookkeeper. PURE (no I/O), so every
 * number and every time rule is unit-tested.
 */

/** "1,240" — thousands separators without relying on the runtime's ICU data. */
function groupThousands(whole: number): string {
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Customer-facing money, as on the invoice: "$1,240.00", "$0.50", "-$12.00". PURE. */
export function money(cents: number): string {
  const c = Math.round(Number.isFinite(cents) ? cents : 0);
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  return `${sign}$${groupThousands(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, "0")}`;
}

/** Owner-facing money, short: "$1,240", "$1,240.50". PURE. */
export function ownerMoney(cents: number): string {
  const c = Math.round(Number.isFinite(cents) ? cents : 0);
  return c % 100 === 0 ? money(c).replace(/\.00$/, "") : money(c);
}

/** "$400.00" → 40000; numbers in dollars → cents. Null when it isn't a positive amount. PURE. */
export function dollarsToCents(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/[$,\s]/g, "")) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  return cents > 0 && cents <= 100_000_000 ? cents : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Oct 16" from "2026-10-16" (calendar date, no time-zone shift). PURE. */
export function shortDate(ymd: string | null | undefined): string {
  const [y, m, d] = (ymd ?? "").split("-").map(Number);
  if (!y || !m || !d) return ymd ?? "";
  return `${MONTHS[m - 1]} ${d}`;
}

/** "Fri Oct 16" from "2026-10-16". PURE. */
export function dayDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${MONTHS[m - 1]} ${d}`;
}

/** "a", "a and b", "a, b and c". PURE. */
export function listJoin(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const PHONE_LIKE = /^\+?\d[\d\s()-]{6,}$/;

/** First name for "Hi Jamie," — never a phone-number placeholder or "Lead". PURE. */
export function firstNameOf(contact: { first_name?: string | null } | null | undefined): string | null {
  const f = contact?.first_name?.trim();
  if (!f || PHONE_LIKE.test(f) || f.toLowerCase() === "lead") return null;
  return f.split(/\s+/)[0];
}

/** "Jamie Lee" (or the phone, or "a customer"). PURE. */
export function fullNameOf(contact: { first_name?: string | null; last_name?: string | null; phone?: string | null } | null | undefined): string {
  if (!contact) return "a customer";
  const first = contact.first_name && !PHONE_LIKE.test(contact.first_name) && contact.first_name.trim() !== "Lead" ? contact.first_name.trim() : "";
  return [first, contact.last_name?.trim()].filter(Boolean).join(" ") || contact.phone || "a customer";
}

/** "INV-2026-0012" or "your invoice" when unnumbered. PURE. */
export function invoiceLabel(invoice: { invoice_number?: string | null }): string {
  return invoice.invoice_number?.trim() ? `invoice ${invoice.invoice_number.trim()}` : "your invoice";
}

export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
}

/** Plain GSM-friendly text: straight quotes, plain dashes, no emoji. PURE. */
export function plainText(text: string): string {
  return text
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7E\nÀ-ÿ]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// ── Local time ────────────────────────────────────────────────────────────────

export interface LocalParts {
  /** YYYY-MM-DD */
  date: string;
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const DEFAULT_ZONE = "America/Toronto";

/** The wall-clock date/hour/weekday in a time zone. PURE. */
export function localParts(nowMs: number, timeZone: string | null | undefined): LocalParts {
  const zone = timeZone?.trim() || DEFAULT_ZONE;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(new Date(nowMs));
  } catch {
    return localParts(nowMs, DEFAULT_ZONE);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number.parseInt(get("hour"), 10) % 24,
    minute: Number.parseInt(get("minute"), 10) || 0,
    weekday: Math.max(0, WEEKDAYS.indexOf(get("weekday"))),
  };
}

/** Proactive customer texts: 09:00–20:00 local, Monday to Saturday (never Sunday). */
export const CUSTOMER_WINDOW = { startHour: 9, endHour: 20 } as const;

export function inCustomerWindow(nowMs: number, timeZone: string | null | undefined): boolean {
  const p = localParts(nowMs, timeZone);
  return p.weekday !== 0 && p.hour >= CUSTOMER_WINDOW.startHour && p.hour < CUSTOMER_WINDOW.endHour;
}

/** "9am today", "9am Monday" — when a queued text will go out (for the owner). PURE. */
export function nextWindowLabel(nowMs: number, timeZone: string | null | undefined): string {
  const p = localParts(nowMs, timeZone);
  const today = p.weekday !== 0 && p.hour < CUSTOMER_WINDOW.startHour;
  if (today) return "9am today";
  const tomorrowSunday = (p.weekday + 1) % 7 === 0;
  if (tomorrowSunday) return "9am Monday";
  return "9am tomorrow";
}

/** Whole days from `from` to `to` (YYYY-MM-DD). PURE. */
export function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/** YYYY-MM-DD + n days. PURE. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD + n calendar months, clamped to the month's last day. PURE. */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}

export function isDateKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}
