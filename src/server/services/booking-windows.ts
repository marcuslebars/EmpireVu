/**
 * Half-day booking windows — the booking model for mobile crews.
 *
 * PURE: policy + today's bookings in, open windows out. No I/O, so the calendar math is
 * testable to the day (including DST) without a database.
 *
 * Ported from a1marinecare/src/lib/retell/slots.ts and generalised: the windows, the
 * capacity, the lead time and the working days are the COMPANY's policy
 * (companies.booking_policy), not constants. A1 Marine Care's policy is the default below,
 * so its behaviour is unchanged.
 *
 * Dates are plain "YYYY-MM-DD" strings in the company's zone; the LLM never parses a
 * date — it is handed ready-to-read labels ("Tuesday, September 29th in the morning").
 */
import { z } from "zod";

export interface BookingWindowDef {
  key: string;
  /** Local wall-clock start, "HH:MM". */
  start: string;
  durationMinutes: number;
  /** How the window is said out loud: "in the morning". */
  spoken: string;
}

export interface BookingPolicy {
  mode: "windows";
  windows: BookingWindowDef[];
  capacityPerWindow: number;
  leadTimeHours: number;
  horizonDays: number;
  /** 0 = Sunday. */
  workingDays: number[];
}

export const DEFAULT_WINDOWS: BookingWindowDef[] = [
  { key: "morning", start: "09:00", durationMinutes: 180, spoken: "in the morning" },
  { key: "afternoon", start: "13:00", durationMinutes: 180, spoken: "in the afternoon" },
];

export const DEFAULT_BOOKING_POLICY: BookingPolicy = {
  mode: "windows",
  windows: DEFAULT_WINDOWS,
  capacityPerWindow: 2,
  leadTimeHours: 24,
  horizonDays: 21,
  workingDays: [1, 2, 3, 4, 5, 6],
};

const windowSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  durationMinutes: z.number().int().min(30).max(720),
  spoken: z.string().min(1).max(60),
});

const policySchema = z.object({
  mode: z.literal("windows"),
  windows: z.array(windowSchema).min(1).max(6).optional(),
  capacityPerWindow: z.number().int().min(1).max(50).optional(),
  leadTimeHours: z.number().int().min(0).max(24 * 14).optional(),
  horizonDays: z.number().int().min(1).max(120).optional(),
  workingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
});

/**
 * The company's policy, or null when it doesn't book by window. Partial policies are
 * filled from the defaults; a malformed one is logged and treated as the default — a
 * typo in settings must not stop Marina taking a booking.
 */
export function parseBookingPolicy(raw: unknown): BookingPolicy | null {
  if (raw == null) return null;
  const parsed = policySchema.safeParse(raw);
  if (!parsed.success) {
    console.error("[booking-windows] invalid booking_policy; using defaults:", parsed.error.issues[0]?.message);
    return DEFAULT_BOOKING_POLICY;
  }
  const p = parsed.data;
  return {
    mode: "windows",
    windows: (p.windows as BookingWindowDef[] | undefined) ?? DEFAULT_WINDOWS,
    capacityPerWindow: p.capacityPerWindow ?? DEFAULT_BOOKING_POLICY.capacityPerWindow,
    leadTimeHours: p.leadTimeHours ?? DEFAULT_BOOKING_POLICY.leadTimeHours,
    horizonDays: p.horizonDays ?? DEFAULT_BOOKING_POLICY.horizonDays,
    workingDays: [...new Set(p.workingDays ?? DEFAULT_BOOKING_POLICY.workingDays)].sort(),
  };
}

// ── Calendar math (DST-safe, no dependency) ─────────────────────────────────────

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function toDateString(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return toDateString(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export function weekdayOf(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isValidDateString(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() + 1 === m && t.getUTCDate() === d;
}

/** The local calendar date of an instant in a zone. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Offset (local wall clock − UTC) in ms at an instant. */
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(utcMs));
  const map: Record<string, number> = {};
  for (const part of parts) if (part.type !== "literal") map[part.type] = Number(part.value);
  return Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second) - utcMs;
}

/** The UTC instant of a local wall-clock time ("YYYY-MM-DD", "HH:MM") in a zone. */
export function zonedInstant(dateStr: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0);
  // Two passes settle the offset across a DST boundary.
  let utc = naive - tzOffsetMs(naive, timeZone);
  utc = naive - tzOffsetMs(utc, timeZone);
  return new Date(utc);
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/** "Tuesday, September 29th in the morning". */
export function spokenWindowLabel(dateStr: string, window: BookingWindowDef): string {
  const [, m, d] = dateStr.split("-").map(Number);
  return `${DAYS[weekdayOf(dateStr)]}, ${MONTHS[m - 1]} ${ordinal(d)} ${window.spoken}`;
}

/** "morning", "AM", "afternoon please" → the policy's window key, or null. */
export function parseWindowKey(value: unknown, policy: BookingPolicy): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  const exact = policy.windows.find((w) => w.key === v);
  if (exact) return exact.key;
  const byPrefix = policy.windows.find((w) => v.startsWith(w.key.slice(0, 4)) || w.key.startsWith(v.slice(0, 4)));
  if (byPrefix) return byPrefix.key;
  // "am" / "pm" against the first window that starts before / after noon.
  if (v === "am") return policy.windows.find((w) => Number(w.start.slice(0, 2)) < 12)?.key ?? null;
  if (v === "pm") return policy.windows.find((w) => Number(w.start.slice(0, 2)) >= 12)?.key ?? null;
  return null;
}

/** The first date that respects the lead time, in the company's zone. */
export function earliestBookableDate(now: Date, policy: BookingPolicy, timeZone: string): string {
  return localDate(new Date(now.getTime() + policy.leadTimeHours * 3_600_000), timeZone);
}

// ── Capacity ────────────────────────────────────────────────────────────────────

/** A non-cancelled booking, as far as capacity is concerned. */
export interface BusyBooking {
  scheduledFor: string;
  durationMinutes: number;
  windowKey?: string | null;
}

/**
 * How many jobs occupy a window on a date. A booking counts when it was booked INTO the
 * window, or when it simply overlaps the window's hours (a job added by hand in the app
 * takes the crew just the same).
 */
export function windowLoad(
  bookings: BusyBooking[],
  dateStr: string,
  window: BookingWindowDef,
  timeZone: string,
): number {
  const start = zonedInstant(dateStr, window.start, timeZone).getTime();
  const end = start + window.durationMinutes * 60_000;
  return bookings.filter((b) => {
    const s = Date.parse(b.scheduledFor);
    if (!Number.isFinite(s)) return false;
    if (b.windowKey) return b.windowKey === window.key && localDate(new Date(s), timeZone) === dateStr;
    const e = s + Math.max(1, b.durationMinutes) * 60_000;
    return s < end && start < e;
  }).length;
}

export interface OpenWindow {
  date: string;
  windowKey: string;
  label: string;
  remaining: number;
  startsAt: string;
  durationMinutes: number;
}

export interface AvailabilityQuery {
  now: Date;
  timeZone: string;
  policy: BookingPolicy;
  bookings: BusyBooking[];
  preferredDate?: string | null;
  preferredWindow?: string | null;
  limit?: number;
}

/**
 * Next open windows, nearest first. A preferred date + window that's open comes first;
 * otherwise the nearest alternatives from the preferred date (or the earliest bookable
 * date) forward. Preferred window is tried first on each day.
 */
export function findOpenWindows(q: AvailabilityQuery): OpenWindow[] {
  const limit = q.limit ?? 3;
  const { policy, timeZone } = q;
  const earliest = earliestBookableDate(q.now, policy, timeZone);
  const lastDate = addDays(earliest, policy.horizonDays);
  const working = new Set(policy.workingDays);

  let start = earliest;
  if (q.preferredDate && isValidDateString(q.preferredDate) && q.preferredDate > earliest) start = q.preferredDate;

  const results: OpenWindow[] = [];
  const push = (date: string, w: BookingWindowDef) => {
    if (results.length >= limit) return;
    if (results.some((r) => r.date === date && r.windowKey === w.key)) return;
    const startsAt = zonedInstant(date, w.start, timeZone);
    // Lead time works by DATE, as the Care site did (24 h notice → "from tomorrow's
    // date"), but never offer a window that has already started.
    if (date < earliest || startsAt.getTime() <= q.now.getTime()) return;
    const used = windowLoad(q.bookings, date, w, timeZone);
    if (used >= policy.capacityPerWindow) return;
    results.push({
      date,
      windowKey: w.key,
      label: spokenWindowLabel(date, w),
      remaining: policy.capacityPerWindow - used,
      startsAt: startsAt.toISOString(),
      durationMinutes: w.durationMinutes,
    });
  };

  const preferred = q.preferredWindow ? policy.windows.find((w) => w.key === q.preferredWindow) : undefined;
  if (q.preferredDate && preferred && start === q.preferredDate && working.has(weekdayOf(start))) {
    push(start, preferred);
  }

  const order = preferred ? [preferred, ...policy.windows.filter((w) => w !== preferred)] : policy.windows;
  for (let date = start; date <= lastDate && results.length < limit; date = addDays(date, 1)) {
    if (!working.has(weekdayOf(date))) continue;
    for (const w of order) push(date, w);
  }
  return results;
}

/** Is this exact window bookable right now? Returns the window when it is. */
export function checkWindow(
  q: Omit<AvailabilityQuery, "preferredDate" | "preferredWindow" | "limit"> & { date: string; windowKey: string },
): { ok: true; window: OpenWindow } | { ok: false; reason: "not_bookable" | "full" } {
  const w = q.policy.windows.find((x) => x.key === q.windowKey);
  if (!w || !isValidDateString(q.date)) return { ok: false, reason: "not_bookable" };
  if (!new Set(q.policy.workingDays).has(weekdayOf(q.date))) return { ok: false, reason: "not_bookable" };
  const startsAt = zonedInstant(q.date, w.start, q.timeZone);
  const earliest = earliestBookableDate(q.now, q.policy, q.timeZone);
  if (q.date < earliest || startsAt.getTime() <= q.now.getTime()) return { ok: false, reason: "not_bookable" };
  if (q.date > addDays(earliest, q.policy.horizonDays)) return { ok: false, reason: "not_bookable" };
  const used = windowLoad(q.bookings, q.date, w, q.timeZone);
  if (used >= q.policy.capacityPerWindow) return { ok: false, reason: "full" };
  return {
    ok: true,
    window: {
      date: q.date,
      windowKey: w.key,
      label: spokenWindowLabel(q.date, w),
      remaining: q.policy.capacityPerWindow - used,
      startsAt: startsAt.toISOString(),
      durationMinutes: w.durationMinutes,
    },
  };
}
