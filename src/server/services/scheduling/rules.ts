/**
 * Online booking + open times — PURE rules shared by the public booking page (/book) and the
 * visit page (/v): per-brand booking settings, the deposit for a service, and the hourly open
 * slots for brands that don't book by window. Pinned by src/test/online-booking.test.ts.
 * See docs/online-booking.md.
 */
import { z } from "zod";

import { addDays, findOpenWindows, localDate, weekdayOf, zonedInstant, type BookingPolicy, type BusyBooking } from "@/server/services/booking-windows";

export const onlineBookingSettingsSchema = z.object({
  /** The public booking page takes bookings. */
  enabled: z.boolean(),
  /** Hourly mode: first and last start hour (local), and the days (0 = Sunday). */
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(1).max(24),
  workingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  /** Hourly mode: how long a booked visit is (and how far apart start times are). */
  slotMinutes: z.number().int().min(15).max(480),
  /** Hourly mode: no bookings sooner than this. */
  minNoticeHours: z.number().int().min(0).max(336),
  horizonDays: z.number().int().min(1).max(120),
  /** Let the customer pick a service from the price list. */
  showServices: z.boolean(),
  requireService: z.boolean(),
  /** New online bookings are confirmed straight away (else pending until you confirm). */
  autoConfirm: z.boolean(),
  /** Deposit for flat-priced services: none, a fixed amount, or a percentage of the price. */
  depositMode: z.enum(["none", "fixed", "percent"]),
  depositFixedCents: z.number().int().min(0).max(10_000_000),
  depositPercent: z.number().int().min(1).max(100),
  /** How long an unpaid deposit holds the slot. */
  holdMinutes: z.number().int().min(10).max(1440),
});

export type OnlineBookingSettings = z.infer<typeof onlineBookingSettingsSchema>;

export const DEFAULT_ONLINE_BOOKING_SETTINGS: OnlineBookingSettings = {
  enabled: true,
  startHour: 9,
  endHour: 17,
  workingDays: [1, 2, 3, 4, 5, 6],
  slotMinutes: 60,
  minNoticeHours: 2,
  horizonDays: 14,
  showServices: true,
  requireService: false,
  autoConfirm: false,
  depositMode: "none",
  depositFixedCents: 5000,
  depositPercent: 25,
  holdMinutes: 60,
};

export function parseOnlineBookingSettings(raw: unknown): OnlineBookingSettings {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...DEFAULT_ONLINE_BOOKING_SETTINGS };
  const shape = onlineBookingSettingsSchema.shape;
  for (const key of Object.keys(shape) as Array<keyof typeof shape>) {
    if (!(key in obj)) continue;
    const parsed = shape[key].safeParse(obj[key]);
    if (parsed.success) out[key] = parsed.data;
  }
  const s = out as OnlineBookingSettings;
  if (s.endHour <= s.startHour) return { ...s, startHour: DEFAULT_ONLINE_BOOKING_SETTINGS.startHour, endHour: DEFAULT_ONLINE_BOOKING_SETTINGS.endHour };
  return s;
}

// ── Services & deposits ─────────────────────────────────────────────────────

export interface CatalogService {
  id: string;
  label: string;
  description: string | null;
  pricing_type: string;
  rate_cents: number;
  minimum_cents: number;
  unit_label: string | null;
}

export interface BookableService {
  id: string;
  label: string;
  description: string | null;
  /** The price when it's a fixed price, else null. */
  priceCents: number | null;
  /** How the price is shown: "$450", "$12 per foot", "From $200", or null. */
  priceLabel: string | null;
  depositCents: number | null;
}

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** Fixed price of a flat service (rate, but never under its minimum), else null. */
export function flatPrice(s: CatalogService): number | null {
  if (s.pricing_type !== "flat") return null;
  const p = Math.max(s.rate_cents, s.minimum_cents);
  return p > 0 ? p : null;
}

export function depositFor(priceCents: number | null, settings: OnlineBookingSettings, stripeReady: boolean): number | null {
  if (!stripeReady || settings.depositMode === "none" || !priceCents) return null;
  const raw = settings.depositMode === "fixed" ? settings.depositFixedCents : Math.round((priceCents * settings.depositPercent) / 100);
  const d = Math.min(raw, priceCents);
  return d >= 100 ? d : null; // under $1 isn't worth a payment
}

export function bookableService(s: CatalogService, settings: OnlineBookingSettings, stripeReady: boolean): BookableService {
  const price = flatPrice(s);
  let priceLabel: string | null = null;
  if (price) priceLabel = money(price);
  else if (s.rate_cents > 0 && s.unit_label) priceLabel = `${money(s.rate_cents)} per ${s.unit_label}`;
  else if (s.minimum_cents > 0) priceLabel = `From ${money(s.minimum_cents)}`;
  return { id: s.id, label: s.label, description: s.description, priceCents: price, priceLabel, depositCents: depositFor(price, settings, stripeReady) };
}

// ── Open times ──────────────────────────────────────────────────────────────

export interface OpenTime {
  startsAt: string;
  /** Local calendar day (YYYY-MM-DD). */
  day: string;
  windowKey: string | null;
  durationMinutes: number;
}

export interface OpenTimesQuery {
  now: Date;
  timeZone: string;
  /** The brand books by half-day window (companies.booking_policy); else hourly per settings. */
  policy: BookingPolicy | null;
  settings: OnlineBookingSettings;
  /** Non-cancelled bookings around the horizon (excluding the one being moved). */
  busy: BusyBooking[];
  /** Nothing earlier than this (a cutoff); defaults to now + the brand's notice. */
  earliestMs?: number;
  /** Hourly mode: the visit's length (default: the brand's slot length). */
  durationMinutes?: number;
  limit?: number;
}

function overlapsBusy(start: number, end: number, busy: BusyBooking[]): boolean {
  return busy.some((b) => {
    const s = Date.parse(b.scheduledFor);
    if (!Number.isFinite(s)) return false;
    const e = s + Math.max(1, b.durationMinutes) * 60_000;
    return start < e && s < end;
  });
}

export function openTimes(q: OpenTimesQuery): OpenTime[] {
  const limit = q.limit ?? 400;
  if (q.policy) {
    const earliest = q.earliestMs ?? q.now.getTime();
    return findOpenWindows({ now: q.now, timeZone: q.timeZone, policy: q.policy, bookings: q.busy, limit: Math.min(limit, 120) })
      .filter((w) => Date.parse(w.startsAt) >= earliest)
      .map((w) => ({ startsAt: w.startsAt, day: w.date, windowKey: w.windowKey, durationMinutes: w.durationMinutes }));
  }
  const s = q.settings;
  const duration = q.durationMinutes ?? s.slotMinutes;
  const earliest = q.earliestMs ?? q.now.getTime() + s.minNoticeHours * 3_600_000;
  const working = new Set(s.workingDays);
  const out: OpenTime[] = [];
  const first = localDate(q.now, q.timeZone);
  for (let i = 0; i <= s.horizonDays && out.length < limit; i++) {
    const day = addDays(first, i);
    if (!working.has(weekdayOf(day))) continue;
    for (let minute = s.startHour * 60; minute + duration <= s.endHour * 60; minute += s.slotMinutes) {
      const hh = String(Math.floor(minute / 60)).padStart(2, "0");
      const mm = String(minute % 60).padStart(2, "0");
      const start = zonedInstant(day, `${hh}:${mm}`, q.timeZone).getTime();
      if (start < earliest) continue;
      if (overlapsBusy(start, start + duration * 60_000, q.busy)) continue;
      out.push({ startsAt: new Date(start).toISOString(), day, windowKey: null, durationMinutes: duration });
      if (out.length >= limit) break;
    }
  }
  return out;
}

// ── Labels ──────────────────────────────────────────────────────────────────

export interface PresentedTime extends OpenTime {
  /** "Tuesday, October 6" */
  dayLabel: string;
  /** "9:00 a.m." or, for a booking window, "Morning". */
  label: string;
}

export function presentOpenTimes(times: OpenTime[], policy: BookingPolicy | null, timeZone: string): PresentedTime[] {
  return times.map((t) => {
    const d = new Date(t.startsAt);
    const dayLabel = d.toLocaleDateString("en-CA", { timeZone, weekday: "long", month: "long", day: "numeric" });
    let label = d.toLocaleTimeString("en-CA", { timeZone, hour: "numeric", minute: "2-digit" });
    const w = t.windowKey && policy ? policy.windows.find((x) => x.key === t.windowKey) : null;
    if (w) {
      const spoken = w.spoken.replace(/^in the /, "");
      label = spoken.charAt(0).toUpperCase() + spoken.slice(1);
    }
    return { ...t, dayLabel, label };
  });
}
