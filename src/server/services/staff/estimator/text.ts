/** Small PURE helpers for the estimator (names, money, local time). */

export const DEFAULT_TIMEZONE = "America/Toronto";
/** Proactive customer texts only go out in this local window. */
export const CUSTOMER_HOURS = { start: 9, end: 20 } as const;

export function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

export function clip(text: string | null | undefined, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
}

const PHONE_LIKE = /^\+?\d[\d\s()-]{6,}$/;

interface NameParts {
  first_name: string | null;
  last_name: string | null;
  phone?: string | null;
}

export function firstName(contact: NameParts | null | undefined): string {
  const f = contact?.first_name?.trim();
  return f && !PHONE_LIKE.test(f) && !/^\+?\d/.test(f) ? f : "there";
}

export function displayName(contact: NameParts | null | undefined): string {
  if (!contact) return "the customer";
  const f = contact.first_name && !PHONE_LIKE.test(contact.first_name) && !/^\+?\d/.test(contact.first_name) ? contact.first_name : "";
  return [f, contact.last_name].filter(Boolean).join(" ") || contact.phone || "the customer";
}

/** "705-555-0123" from "+17055550123". */
export function prettyPhone(phone: string | null | undefined): string | null {
  const d = (phone ?? "").replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return ten.length === 10 ? `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}` : phone ?? null;
}

export function localHour(at: Date, timeZone: string): number {
  try {
    return Number(new Intl.DateTimeFormat("en-CA", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(at));
  } catch {
    return Number(new Intl.DateTimeFormat("en-CA", { timeZone: DEFAULT_TIMEZONE, hour: "2-digit", hourCycle: "h23" }).format(at));
  }
}

/** 09:00–20:00 company local. */
export function withinCustomerHours(at: Date, timeZone: string): boolean {
  const hour = localHour(at, timeZone);
  return hour >= CUSTOMER_HOURS.start && hour < CUSTOMER_HOURS.end;
}

/**
 * When an approval made at `now` should expire: `ttlMs` later, pushed forward to the next
 * 09:00 local if that lands outside 09:00–20:00 — so the expiry follow-up (a text to the
 * customer and one to the owner) never goes out at night.
 */
export function daytimeExpiry(now: Date, ttlMs: number, timeZone: string): Date {
  let at = new Date(now.getTime() + ttlMs);
  for (let i = 0; i < 24 && !withinCustomerHours(at, timeZone); i++) {
    // Step to the top of the next hour.
    at = new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000 + 3_600_000);
  }
  return at;
}
