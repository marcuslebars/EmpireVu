/**
 * When things are due, and the one-line wording for the owner (PURE; tested with fixtures).
 *
 *   Vehicle service   by date (last done + every N months) and/or by km (last done km + every N
 *                     km, against the PROJECTED odometer: last reading + average km/day × days
 *                     since). "due" = within 7 days, or within 10% of the interval in km (300–1,000
 *                     km); "overdue" = past either. The reading is "stale" after 30 days: we ask
 *                     for a new one.
 *   Plate sticker /   stages 30 days before, 7 days before and on the day (caught up for 3 days).
 *   safety inspection
 *   Equipment         by date (every N months) and/or by hour meter (every N hours, 10% / ≥ 5 h
 *                     ahead).
 *   Rentals           "before" (due back tomorrow; the afternoon text), "day" (due back later
 *                     today; the morning text), "overdue" (every morning until returned).
 */
import { addMonths, daysBetween, fmtNum, localDateOf, money, plural, shortDate, timeLabel, addDays } from "./dates";
import { num, type EquipmentRow, type RentalRow, type ServiceItemRow, type VehicleRow } from "./db-types";

const DAY_MS = 86_400_000;
export const STALE_READING_DAYS = 30;
export const SERVICE_DATE_LEAD_DAYS = 7;
/** Sanity cap: a work truck averaging more than this a day is a typo. */
export const MAX_AVG_KM_PER_DAY = 2000;

export function kmLead(everyKm: number): number {
  return Math.min(1000, Math.max(300, Math.round(everyKm * 0.1)));
}

export function hoursLead(everyHours: number): number {
  return Math.max(5, everyHours * 0.1);
}

/** "Oil change" → "oil change"; "DEF top-up" stays. */
export function lowerFirst(label: string): string {
  const t = label.trim();
  if (t.length > 1 && t[1] === t[1].toLowerCase() && t[0] !== t[0].toLowerCase()) return t[0].toLowerCase() + t.slice(1);
  return t;
}

// ── Odometer ───────────────────────────────────────────────────────────────────────────

/**
 * Average km/day from odometer readings: the oldest and newest reading of the last 180 days, at
 * least 7 days apart, never going backwards. Null when there isn't enough history.
 */
export function avgKmPerDay(readings: Array<{ km: number; atMs: number }>, nowMs: number): number | null {
  const recent = readings.filter((r) => Number.isFinite(r.km) && r.atMs <= nowMs + DAY_MS && r.atMs >= nowMs - 180 * DAY_MS).sort((a, b) => a.atMs - b.atMs);
  if (recent.length < 2) return null;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const days = (last.atMs - first.atMs) / DAY_MS;
  if (days < 7 || last.km < first.km) return null;
  const avg = (last.km - first.km) / days;
  if (avg > MAX_AVG_KM_PER_DAY) return null;
  return Math.round(avg * 10) / 10;
}

export interface Projection {
  /** Best guess of today's odometer (null without any reading). */
  km: number | null;
  /** The last reading is older than 30 days (or there is none). */
  stale: boolean;
  daysOld: number | null;
}

export function projectedKm(v: Pick<VehicleRow, "odometer_km" | "odometer_at" | "avg_km_per_day">, nowMs: number): Projection {
  if (v.odometer_km == null || !v.odometer_at) return { km: v.odometer_km ?? null, stale: true, daysOld: null };
  const days = Math.max(0, (nowMs - Date.parse(v.odometer_at)) / DAY_MS);
  const avg = num(v.avg_km_per_day);
  return { km: Math.round(v.odometer_km + (avg ?? 0) * days), stale: days > STALE_READING_DAYS, daysOld: Math.floor(days) };
}

// ── Vehicle service ────────────────────────────────────────────────────────────────────

export type DueState = "ok" | "due" | "overdue" | "unknown";

export interface ServiceDue {
  state: DueState;
  dueOn: string | null;
  daysLeft: number | null;
  dueKm: number | null;
  kmLeft: number | null;
  kmSince: number | null;
  /** What made it due: the km side, the date side (km wins when both). */
  reason: "km" | "date" | null;
  /** The km side used a reading older than 30 days. */
  staleKm: boolean;
}

export function serviceDue(item: Pick<ServiceItemRow, "every_km" | "every_months" | "last_done_km" | "last_done_on">, vehicle: Pick<VehicleRow, "odometer_km" | "odometer_at" | "avg_km_per_day">, today: string, nowMs: number): ServiceDue {
  let dueOn: string | null = null;
  let daysLeft: number | null = null;
  if (item.every_months && item.last_done_on) {
    dueOn = addMonths(item.last_done_on, item.every_months);
    daysLeft = daysBetween(today, dueOn);
  }
  let dueKm: number | null = null;
  let kmLeft: number | null = null;
  let kmSince: number | null = null;
  let staleKm = false;
  if (item.every_km && item.last_done_km != null) {
    dueKm = item.last_done_km + item.every_km;
    const p = projectedKm(vehicle, nowMs);
    if (p.km != null) {
      kmLeft = dueKm - p.km;
      kmSince = Math.max(0, p.km - item.last_done_km);
      staleKm = p.stale;
    }
  }
  if (daysLeft == null && kmLeft == null) return { state: "unknown", dueOn, daysLeft, dueKm, kmLeft, kmSince, reason: null, staleKm };
  const kmDue = kmLeft != null && item.every_km ? kmLeft <= kmLead(item.every_km) : false;
  const dateDue = daysLeft != null && daysLeft <= SERVICE_DATE_LEAD_DAYS;
  const overdue = (kmLeft != null && kmLeft < 0) || (daysLeft != null && daysLeft < 0);
  const state: DueState = overdue ? "overdue" : kmDue || dateDue ? "due" : "ok";
  const kmOver = kmLeft != null && kmLeft < 0;
  const dateOver = daysLeft != null && daysLeft < 0;
  const reason = state === "ok" ? null : state === "overdue" ? (kmOver ? "km" : dateOver ? "date" : null) : kmDue ? "km" : "date";
  return { state, dueOn, daysLeft, dueKm, kmLeft, kmSince, reason, staleKm };
}

const round100 = (n: number) => Math.round(n / 100) * 100;

/** "Truck 2 oil change due (about 8,100 km since last)" / "… overdue since Oct 1" / "… due Oct 20". */
export function serviceLine(vehicleName: string, label: string, due: ServiceDue): string {
  const what = `${vehicleName} ${lowerFirst(label)}`;
  const guess = due.staleKm ? ", a guess - text me the km" : "";
  if (due.reason === "km" && due.kmSince != null) return `${what} ${due.state === "overdue" ? "overdue" : "due"} (about ${fmtNum(round100(due.kmSince))} km since last${guess})`;
  if (due.dueOn && due.daysLeft != null) {
    if (due.daysLeft < 0) return `${what} overdue since ${shortDate(due.dueOn)}`;
    if (due.daysLeft === 0) return `${what} due today`;
    return `${what} due ${shortDate(due.dueOn)}`;
  }
  return `${what} due`;
}

/** For replies and status: "due in about 1,800 km" / "due Nov 3" / "overdue" / "no last service logged". */
export function nextDueWords(due: ServiceDue): string {
  if (due.state === "unknown") return "no last service logged";
  if (due.state === "overdue") return due.reason === "km" && due.kmLeft != null ? `overdue by about ${fmtNum(round100(-due.kmLeft))} km` : due.dueOn ? `overdue since ${shortDate(due.dueOn)}` : "overdue";
  const parts: string[] = [];
  if (due.kmLeft != null) parts.push(`in about ${fmtNum(round100(due.kmLeft))} km`);
  if (due.dueOn) parts.push(due.daysLeft === 0 ? "today" : `by ${shortDate(due.dueOn)}`);
  return `due ${parts.join(" or ")}`;
}

// ── Plate sticker / safety inspection ──────────────────────────────────────────────────

export type DateStage = 30 | 7 | 0;

/** 30 (8–30 days out), 7 (1–7 days out), 0 (the day, caught up for 3 days); null otherwise. */
export function dateStage(due: string, today: string): DateStage | null {
  const days = daysBetween(today, due);
  if (days > 30) return null;
  if (days > 7) return 30;
  if (days > 0) return 7;
  if (days >= -3) return 0;
  return null;
}

/** "Truck 1 plate sticker expires in 7 days" / "… expires today" / "… expired Oct 10". */
export function plateLine(vehicleName: string, due: string, today: string): string {
  const days = daysBetween(today, due);
  if (days > 0) return `${vehicleName} plate sticker expires in ${plural(days, "day")}`;
  if (days === 0) return `${vehicleName} plate sticker expires today`;
  return `${vehicleName} plate sticker expired ${shortDate(due)}`;
}

export function safetyLine(vehicleName: string, due: string, today: string): string {
  const days = daysBetween(today, due);
  if (days > 0) return `${vehicleName} safety inspection due in ${plural(days, "day")}`;
  if (days === 0) return `${vehicleName} safety inspection due today`;
  return `${vehicleName} safety inspection overdue since ${shortDate(due)}`;
}

// ── Equipment ──────────────────────────────────────────────────────────────────────────

export interface EquipmentDue {
  state: DueState;
  dueOn: string | null;
  daysLeft: number | null;
  hoursLeft: number | null;
  hoursSince: number | null;
  reason: "hours" | "date" | null;
}

export function equipmentDue(eq: Pick<EquipmentRow, "service_every_hours" | "service_every_months" | "last_serviced_on" | "last_serviced_hours" | "hours">, today: string): EquipmentDue {
  let dueOn: string | null = null;
  let daysLeft: number | null = null;
  if (eq.service_every_months && eq.last_serviced_on) {
    dueOn = addMonths(eq.last_serviced_on, eq.service_every_months);
    daysLeft = daysBetween(today, dueOn);
  }
  const every = num(eq.service_every_hours);
  const last = num(eq.last_serviced_hours);
  const hours = num(eq.hours);
  let hoursLeft: number | null = null;
  let hoursSince: number | null = null;
  if (every && last != null && hours != null) {
    hoursLeft = Math.round((last + every - hours) * 10) / 10;
    hoursSince = Math.max(0, Math.round((hours - last) * 10) / 10);
  }
  if (daysLeft == null && hoursLeft == null) return { state: "unknown", dueOn, daysLeft, hoursLeft, hoursSince, reason: null };
  const hoursDue = hoursLeft != null && every ? hoursLeft <= hoursLead(every) : false;
  const dateDue = daysLeft != null && daysLeft <= SERVICE_DATE_LEAD_DAYS;
  const hoursOver = hoursLeft != null && hoursLeft < 0;
  const dateOver = daysLeft != null && daysLeft < 0;
  const state: DueState = hoursOver || dateOver ? "overdue" : hoursDue || dateDue ? "due" : "ok";
  const reason = state === "ok" ? null : state === "overdue" ? (hoursOver ? "hours" : "date") : hoursDue ? "hours" : "date";
  return { state, dueOn, daysLeft, hoursLeft, hoursSince, reason };
}

/** "Mini-ex service due (262 hours since last)" / "Mower service overdue since Oct 1". */
export function equipmentLine(name: string, due: EquipmentDue): string {
  if (due.reason === "hours" && due.hoursSince != null) return `${name} service ${due.state === "overdue" ? "overdue" : "due"} (${fmtNum(due.hoursSince)} hours since last)`;
  if (due.dueOn && due.daysLeft != null) {
    if (due.daysLeft < 0) return `${name} service overdue since ${shortDate(due.dueOn)}`;
    if (due.daysLeft === 0) return `${name} service due today`;
    return `${name} service due ${shortDate(due.dueOn)}`;
  }
  return `${name} service due`;
}

// ── Rentals ────────────────────────────────────────────────────────────────────────────

export type RentalStage = { stage: "before" } | { stage: "day" } | { stage: "overdue"; daysLate: number };

export function rentalStage(r: Pick<RentalRow, "due_back_at" | "returned_at">, nowMs: number, timeZone: string): RentalStage | null {
  if (r.returned_at || !r.due_back_at) return null;
  const dueMs = Date.parse(r.due_back_at);
  if (!Number.isFinite(dueMs)) return null;
  const today = localDateOf(nowMs, timeZone);
  const dueDay = localDateOf(dueMs, timeZone);
  if (dueMs <= nowMs) return { stage: "overdue", daysLate: Math.max(0, daysBetween(dueDay, today)) };
  if (dueDay === today) return { stage: "day" };
  if (dueDay === addDays(today, 1)) return { stage: "before" };
  return null;
}

/** "Sunbelt mini-ex" (vendor + item) or just the item. */
export function rentalName(r: Pick<RentalRow, "item" | "vendor">): string {
  return r.vendor?.trim() ? `${r.vendor.trim()} ${r.item.trim()}` : r.item.trim();
}

/** The owner text line, e.g. "Rental: Sunbelt mini-ex due back today 5pm - $380/day after". */
export function rentalLine(r: Pick<RentalRow, "item" | "vendor" | "due_back_at" | "rate_cents_per_day">, stage: RentalStage, timeZone: string): string {
  const name = rentalName(r);
  const dueMs = Date.parse(r.due_back_at as string);
  const time = timeLabel(dueMs, timeZone);
  const rate = r.rate_cents_per_day ? money(r.rate_cents_per_day) : null;
  if (stage.stage === "before") return `Rental: ${name} due back tomorrow ${time}`;
  if (stage.stage === "day") return `Rental: ${name} due back today ${time}${rate ? ` - ${rate}/day after` : ""}`;
  if (stage.daysLate === 0) return `Rental: ${name} was due back today ${time}${rate ? ` - ${rate}/day after` : ""}`;
  const extra = r.rate_cents_per_day ? `, about ${money(r.rate_cents_per_day * stage.daysLate)} extra` : "";
  return `Rental: ${name} was due back ${shortDate(localDateOf(dueMs, timeZone))} (${plural(stage.daysLate, "day")} late${extra})`;
}

/** The briefing's shorter form: "Rental mini-ex due back today 5pm (Sunbelt)". */
export function rentalBriefingLine(r: Pick<RentalRow, "item" | "vendor" | "due_back_at">, stage: RentalStage, timeZone: string): string {
  const vendor = r.vendor?.trim() ? ` (${r.vendor.trim()})` : "";
  const dueMs = Date.parse(r.due_back_at as string);
  if (stage.stage === "before") return `Rental ${r.item.trim()} due back tomorrow ${timeLabel(dueMs, timeZone)}${vendor}`;
  if (stage.stage === "day" || stage.daysLate === 0) return `Rental ${r.item.trim()} due back today ${timeLabel(dueMs, timeZone)}${vendor}`;
  return `Rental ${r.item.trim()} overdue since ${shortDate(localDateOf(dueMs, timeZone))}${vendor}`;
}

/** Days billed from out to back (a part day counts after a 2-hour grace; at least 1). */
export function rentalDays(outAt: string | null, backAtMs: number): number | null {
  if (!outAt) return null;
  const out = Date.parse(outAt);
  if (!Number.isFinite(out) || backAtMs < out) return null;
  const hours = (backAtMs - out) / 3_600_000;
  return Math.max(1, Math.ceil((hours - 2) / 24));
}
