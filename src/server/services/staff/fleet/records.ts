/**
 * Fleet records (service role; every query scoped by organization_id AND company_id): vehicles,
 * service schedules, odometer readings, services done, equipment check-outs, rentals. Shared by
 * the owner tools, the Settings route and the odometer photo. Names from a text are only matched
 * inside the one company (never trust an id that came from a text).
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { zonedInstant } from "@/server/services/booking-windows";
import { addDays, fmtNum, isValidDateString, localDateOf, prettyDate } from "./dates";
import { num, type Db, type EquipmentRow, type EquipmentStatus, type FleetLogSource, type RentalRow, type ServiceItemRow, type VehicleRow } from "./db-types";
import { avgKmPerDay, MAX_AVG_KM_PER_DAY, nextDueWords, projectedKm, serviceDue, equipmentDue } from "./due";
import type { FleetCompany } from "./settings";

type Scope = Pick<FleetCompany, "organizationId" | "companyId" | "timeZone">;
type Result<T> = T | { error: string };
const DAY_MS = 86_400_000;
export const MAX_KM = 3_000_000;
export const MAX_HOURS = 1_000_000;

// ── Matching words to rows ─────────────────────────────────────────────────────────────

export function norm(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/#/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const compact = (s: string | null | undefined) => norm(s).replace(/ /g, "");
const STOP = new Set(["the", "my", "our", "a", "an", "rental", "rented"]);

/** Rows whose names match the words: exact (ignoring case, spaces, "#") first, else every word found. */
export function pickByName<T>(items: T[], ref: string, names: (t: T) => Array<string | null | undefined>): T[] {
  const q = norm(ref);
  if (!q) return [];
  const qc = compact(ref);
  const exact = items.filter((t) => names(t).some((n) => n && (norm(n) === q || compact(n) === qc)));
  if (exact.length) return exact;
  const words = q.split(" ").filter((w) => !STOP.has(w));
  if (words.length === 0) return [];
  return items.filter((t) => {
    const hay = names(t).filter(Boolean).map((n) => norm(n)).join(" ");
    const hayWords = new Set(hay.split(" "));
    const hayCompact = hay.replace(/ /g, "");
    return words.every((w) => hayWords.has(w) || (w.length >= 3 && hayCompact.includes(w)));
  });
}

export function vehicleNames(v: VehicleRow): string[] {
  return [v.name, v.plate, [v.make, v.model].filter(Boolean).join(" "), v.model].filter((n): n is string => Boolean(n));
}

/** "2019 Ford F-150, plate ABCD 123" */
export function vehicleDescription(v: VehicleRow): string {
  const ymm = [v.year, v.make, v.model].filter(Boolean).join(" ");
  return [ymm, v.plate ? `plate ${v.plate}` : null].filter(Boolean).join(", ");
}

// ── Small cleaners ─────────────────────────────────────────────────────────────────────

export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // Control characters, angle brackets and runs of whitespace → one space.
  const t = [...value].map((ch) => (ch.charCodeAt(0) < 32 || ch === "<" || ch === ">" ? " " : ch)).join("").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

export function cleanPhone(raw: unknown): string | null | undefined {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  if (!t) return null;
  const digits = t.replace(/\D/g, "");
  if (t.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : undefined;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return undefined;
}

function cleanVin(raw: unknown): string | null | undefined {
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string") return undefined;
  const v = raw.toUpperCase().replace(/[\s-]/g, "");
  if (!v) return null;
  return /^[A-Z0-9]{5,17}$/.test(v) ? v : undefined;
}

const isMissingTable = (error: unknown) => {
  const e = error as { code?: string; message?: string } | null;
  return Boolean(e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|could not find the table/i.test(e.message ?? "")));
};

/** A fleet_log row that's history, not the action itself: a failure is logged, never thrown. */
async function insertLog(admin: AdminClient, row: Record<string, unknown>): Promise<void> {
  const { error } = await (admin as Db).from("fleet_log").insert(row);
  if (error) console.error("[fleet] log row failed:", (error as { message?: string }).message);
}

// ── Loading ────────────────────────────────────────────────────────────────────────────

export async function loadVehicles(admin: AdminClient, scope: Scope, opts: { activeOnly?: boolean } = { activeOnly: true }): Promise<VehicleRow[]> {
  let q = (admin as Db).from("vehicles").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId);
  if (opts.activeOnly !== false) q = q.eq("active", true);
  const { data, error } = await q.order("name", { ascending: true }).limit(500);
  if (error) throw error;
  return (data ?? []) as VehicleRow[];
}

export async function loadServiceItems(admin: AdminClient, scope: Scope, vehicleIds?: string[]): Promise<ServiceItemRow[]> {
  if (vehicleIds && vehicleIds.length === 0) return [];
  let q = (admin as Db).from("vehicle_service_items").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("active", true);
  if (vehicleIds) q = q.in("vehicle_id", vehicleIds);
  const { data, error } = await q.order("label", { ascending: true }).limit(2000);
  if (error) throw error;
  return (data ?? []) as ServiceItemRow[];
}

export async function loadEquipment(admin: AdminClient, scope: Scope, opts: { includeRetired?: boolean } = {}): Promise<EquipmentRow[]> {
  let q = (admin as Db).from("equipment").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId);
  if (!opts.includeRetired) q = q.in("status", ["available", "out", "in_shop"]);
  const { data, error } = await q.order("name", { ascending: true }).limit(500);
  if (error) throw error;
  return (data ?? []) as EquipmentRow[];
}

export async function loadOpenRentals(admin: AdminClient, scope: Scope): Promise<RentalRow[]> {
  const { data, error } = await (admin as Db)
    .from("rentals")
    .select("*")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .is("returned_at", null)
    .order("due_back_at", { ascending: true })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as RentalRow[];
}

export interface CrewMember {
  profileId: string;
  name: string;
}

export async function loadCrew(admin: AdminClient, organizationId: string): Promise<CrewMember[]> {
  const db = admin as Db;
  const { data, error } = await db.from("organization_memberships").select("profile_id").eq("organization_id", organizationId).limit(500);
  if (error) throw error;
  const ids = ((data ?? []) as Array<{ profile_id: string }>).map((m) => m.profile_id);
  if (ids.length === 0) return [];
  const { data: profiles, error: pErr } = await db.from("profiles").select("id, full_name").in("id", ids);
  if (pErr) throw pErr;
  return ((profiles ?? []) as Array<{ id: string; full_name: string | null }>).filter((p) => p.full_name?.trim()).map((p) => ({ profileId: p.id, name: (p.full_name as string).trim() }));
}

/** A crew member by name words ("Mike", "Mike Dunn"); null when none or more than one. */
export function pickCrew(crew: CrewMember[], ref: string | null): CrewMember | null {
  if (!ref) return null;
  const full = crew.filter((c) => norm(c.name) === norm(ref));
  if (full.length === 1) return full[0];
  const first = crew.filter((c) => norm(c.name).split(" ")[0] === norm(ref).split(" ")[0] && norm(ref).split(" ").length === 1);
  return first.length === 1 ? first[0] : null;
}

/**
 * Vehicle insurance as Compliance has it (read-only, tolerant: [] when Compliance's table isn't
 * there or the read fails). Fleet never reminds about it; Compliance does.
 */
export async function vehicleInsurance(admin: AdminClient, scope: Scope): Promise<Array<{ issuer: string | null; title: string | null; expiresOn: string | null; status: string }>> {
  try {
    const { data, error } = await (admin as Db)
      .from("compliance_documents")
      .select("issuer, title, expires_on, status")
      .eq("organization_id", scope.organizationId)
      .eq("company_id", scope.companyId)
      .eq("kind", "vehicle_insurance")
      .in("status", ["current", "expiring", "expired"])
      .limit(20);
    if (error) {
      if (!isMissingTable(error)) console.error("[fleet] vehicle insurance read failed:", (error as { message?: string }).message);
      return [];
    }
    return ((data ?? []) as Array<{ issuer: string | null; title: string | null; expires_on: string | null; status: string }>)
      .map((d) => ({ issuer: d.issuer, title: d.title, expiresOn: d.expires_on, status: d.status }))
      .sort((a, b) => (a.expiresOn ?? "").localeCompare(b.expiresOn ?? ""));
  } catch {
    return [];
  }
}

/** "Vehicle insurance: Intact, expires Mar 31, 2027" / "… EXPIRED Oct 1, 2026" / null when none on file. */
export function insuranceWords(docs: Array<{ issuer: string | null; expiresOn: string | null; status: string }>): string | null {
  if (docs.length === 0) return null;
  return docs
    .slice(0, 3)
    .map((d) => `${d.issuer ? `${d.issuer}, ` : ""}${d.expiresOn ? `${d.status === "expired" ? "expired" : "expires"} ${prettyDate(d.expiresOn)}` : "no expiry on file"}`)
    .join("; ");
}

// ── Jobs (for check-outs and rentals) ──────────────────────────────────────────────────

export interface JobRef {
  bookingId: string;
  label: string;
  scheduledFor: string;
}

/** A job by customer name / title words, among jobs from 14 days ago to 60 days out (nearest wins). */
export async function findJob(admin: AdminClient, scope: Scope, ref: string, nowMs: number): Promise<JobRef | null> {
  const db = admin as Db;
  const { data, error } = await db
    .from("bookings")
    .select("id, title, scheduled_for, status, contact_id")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .gte("scheduled_for", new Date(nowMs - 14 * DAY_MS).toISOString())
    .lt("scheduled_for", new Date(nowMs + 60 * DAY_MS).toISOString())
    .limit(500);
  if (error) throw error;
  const rows = ((data ?? []) as Array<{ id: string; title: string | null; scheduled_for: string; status: string; contact_id: string | null }>).filter((b) => b.status !== "cancelled");
  if (rows.length === 0) return null;
  const contactIds = [...new Set(rows.map((r) => r.contact_id).filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (contactIds.length) {
    const { data: contacts } = await db.from("contacts").select("id, first_name, last_name").eq("organization_id", scope.organizationId).in("id", contactIds);
    for (const c of (contacts ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>) names.set(c.id, [c.first_name, c.last_name].filter(Boolean).join(" "));
  }
  const hits = pickByName(rows, ref, (b) => [b.contact_id ? names.get(b.contact_id) : null, b.title, [b.contact_id ? names.get(b.contact_id) : null, b.title].filter(Boolean).join(" ")]);
  if (hits.length === 0) return null;
  hits.sort((a, b) => Math.abs(Date.parse(a.scheduled_for) - nowMs) - Math.abs(Date.parse(b.scheduled_for) - nowMs));
  const b = hits[0];
  const who = b.contact_id ? names.get(b.contact_id) : null;
  return { bookingId: b.id, label: who?.split(" ").slice(-1)[0] || b.title || "the job", scheduledFor: b.scheduled_for };
}

// ── Vehicles ───────────────────────────────────────────────────────────────────────────

export interface VehicleInput {
  id?: string | null;
  name?: string | null;
  year?: number | null;
  make?: string | null;
  model?: string | null;
  plate?: string | null;
  vin?: string | null;
  profileId?: string | null;
  plateStickerDue?: string | null;
  safetyInspectionRequired?: boolean;
  safetyInspectionDue?: string | null;
  odometerKm?: number | null;
  notes?: string | null;
  active?: boolean;
}

function dateOrError(value: string | null | undefined, label: string): Result<string | null | undefined> {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return isValidDateString(value) ? value : { error: `${label} must be a date like 2027-03-31.` };
}

const isErr = (v: unknown): v is { error: string } => Boolean(v && typeof v === "object" && "error" in (v as object));

export async function saveVehicle(admin: AdminClient, scope: Scope, input: VehicleInput, nowMs: number, source: FleetLogSource): Promise<Result<{ vehicle: VehicleRow; created: boolean; odometerNote: string | null }>> {
  const db = admin as Db;
  const fields: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = cleanText(input.name, 60);
    if (!name) return { error: "Give the vehicle a name, like Truck 2." };
    fields.name = name;
  }
  if (input.year !== undefined) {
    if (input.year !== null && !(Number.isInteger(input.year) && input.year >= 1950 && input.year <= 2100)) return { error: "The year looks off." };
    fields.year = input.year;
  }
  if (input.make !== undefined) fields.make = cleanText(input.make, 40);
  if (input.model !== undefined) fields.model = cleanText(input.model, 60);
  if (input.plate !== undefined) fields.plate = cleanText(input.plate, 12)?.toUpperCase() ?? null;
  if (input.vin !== undefined) {
    const vin = cleanVin(input.vin);
    if (vin === undefined) return { error: "That VIN doesn't look right (letters and numbers, up to 17)." };
    fields.vin = vin;
  }
  if (input.notes !== undefined) fields.notes = cleanText(input.notes, 500);
  if (input.active !== undefined) fields.active = input.active;
  if (input.safetyInspectionRequired !== undefined) fields.safety_inspection_required = input.safetyInspectionRequired;
  const sticker = dateOrError(input.plateStickerDue, "The plate sticker date");
  if (isErr(sticker)) return sticker;
  if (sticker !== undefined) fields.plate_sticker_due = sticker;
  const safety = dateOrError(input.safetyInspectionDue, "The safety inspection date");
  if (isErr(safety)) return safety;
  if (safety !== undefined) {
    fields.safety_inspection_due = safety;
    if (safety && input.safetyInspectionRequired === undefined) fields.safety_inspection_required = true;
  }
  if (input.profileId !== undefined) {
    if (input.profileId) {
      const crew = await loadCrew(admin, scope.organizationId);
      if (!crew.some((c) => c.profileId === input.profileId)) return { error: "That person isn't on your team." };
    }
    fields.profile_id = input.profileId || null;
  }
  if (input.odometerKm !== undefined && input.odometerKm !== null && !(Number.isInteger(input.odometerKm) && input.odometerKm >= 0 && input.odometerKm <= MAX_KM)) return { error: "The odometer reading looks off." };

  let existing: VehicleRow | null = null;
  if (input.id) {
    const { data, error } = await db.from("vehicles").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("id", input.id).maybeSingle();
    if (error) throw error;
    if (!data) return { error: "Vehicle not found." };
    existing = data as VehicleRow;
  } else {
    if (!fields.name) return { error: "Give the vehicle a name, like Truck 2." };
    const same = (await loadVehicles(admin, scope)).filter((v) => norm(v.name) === norm(fields.name as string));
    existing = same[0] ?? null;
    // "truck 2" for an existing "Truck 2" is the same vehicle, not a rename.
    if (existing) delete fields.name;
  }
  if (existing && fields.name && norm(fields.name as string) !== norm(existing.name)) {
    const clash = (await loadVehicles(admin, scope)).some((v) => v.id !== existing!.id && norm(v.name) === norm(fields.name as string));
    if (clash) return { error: `There's already a vehicle called ${fields.name as string}.` };
  }

  let vehicle: VehicleRow;
  let created = false;
  if (existing) {
    if (Object.keys(fields).length) {
      const { data, error } = await db.from("vehicles").update(fields).eq("id", existing.id).eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).select("*");
      if (error) return error.code === "23505" ? { error: `There's already a vehicle called ${fields.name as string}.` } : Promise.reject(error);
      vehicle = ((data ?? []) as VehicleRow[])[0] ?? { ...existing, ...fields };
    } else vehicle = existing;
  } else {
    const { data, error } = await db
      .from("vehicles")
      .insert({ organization_id: scope.organizationId, company_id: scope.companyId, active: true, safety_inspection_required: false, ...fields })
      .select("*")
      .single();
    if (error) return error.code === "23505" ? { error: `There's already a vehicle called ${fields.name as string}.` } : Promise.reject(error);
    vehicle = data as VehicleRow;
    created = true;
  }

  let odometerNote: string | null = null;
  if (input.odometerKm != null && input.odometerKm !== vehicle.odometer_km) {
    const logged = await logOdometer(admin, scope, vehicle, input.odometerKm, nowMs, { source, correct: source === "settings" || created });
    if ("error" in logged) odometerNote = logged.error;
    else if ("ask" in logged) odometerNote = logged.ask;
    else if ("vehicle" in logged) vehicle = logged.vehicle;
  }
  return { vehicle, created, odometerNote };
}

export type OdometerResult = { vehicle: VehicleRow; km: number } | { duplicate: true } | { ask: string } | { error: string };

/**
 * Log a reading: a fleet_log row (idempotent on sourceKey), then the vehicle's odometer and its
 * average km/day from the readings. A lower reading or an impossible jump is asked about first
 * unless `correct`.
 */
export async function logOdometer(
  admin: AdminClient,
  scope: Scope,
  vehicle: VehicleRow,
  km: number,
  nowMs: number,
  opts: { source: FleetLogSource; sourceKey?: string | null; correct?: boolean },
): Promise<OdometerResult> {
  if (!Number.isFinite(km) || km < 0 || km > MAX_KM) return { error: "The odometer reading looks off." };
  km = Math.round(km);
  const db = admin as Db;
  if (!opts.correct && vehicle.odometer_km != null) {
    const when = vehicle.odometer_at ? ` on ${prettyDate(localDateOf(Date.parse(vehicle.odometer_at), scope.timeZone))}` : "";
    if (km < vehicle.odometer_km) return { ask: `${vehicle.name} was at ${fmtNum(vehicle.odometer_km)} km${when} - ${fmtNum(km)} is lower. Is that right? Say "correct it" and I'll fix it.` };
    const days = vehicle.odometer_at ? Math.max(1, (nowMs - Date.parse(vehicle.odometer_at)) / DAY_MS) : null;
    if (days != null && km - vehicle.odometer_km > (days + 1) * MAX_AVG_KM_PER_DAY) {
      return { ask: `${vehicle.name} was at ${fmtNum(vehicle.odometer_km)} km${when} - ${fmtNum(km)} is ${fmtNum(km - vehicle.odometer_km)} km more. Is that right? Say "correct it" and I'll log it.` };
    }
  }
  if (opts.sourceKey) {
    // The unique (company_id, source_key) index is the real guard; this answers a redelivery early.
    const { data: seen } = await db.from("fleet_log").select("id").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("source_key", opts.sourceKey).limit(1);
    if (((seen ?? []) as unknown[]).length) return { duplicate: true };
  }
  const at = new Date(nowMs).toISOString();
  const { error } = await db.from("fleet_log").insert({
    organization_id: scope.organizationId,
    company_id: scope.companyId,
    vehicle_id: vehicle.id,
    kind: "odometer",
    reading: km,
    source: opts.source,
    source_key: opts.sourceKey ?? null,
    happened_at: at,
  });
  if (error) {
    if (error.code === "23505") return { duplicate: true };
    throw error;
  }
  const { data: logs, error: logErr } = await db
    .from("fleet_log")
    .select("reading, happened_at")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("vehicle_id", vehicle.id)
    .eq("kind", "odometer")
    .gte("happened_at", new Date(nowMs - 200 * DAY_MS).toISOString())
    .limit(1000);
  if (logErr) throw logErr;
  const readings = ((logs ?? []) as Array<{ reading: unknown; happened_at: string }>).map((l) => ({ km: num(l.reading) ?? NaN, atMs: Date.parse(l.happened_at) }));
  const avg = avgKmPerDay(readings, nowMs);
  const fields: Record<string, unknown> = { odometer_km: km, odometer_at: at };
  if (avg != null || readings.length >= 2) fields.avg_km_per_day = avg;
  const { data, error: upErr } = await db.from("vehicles").update(fields).eq("id", vehicle.id).eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).select("*");
  if (upErr) throw upErr;
  return { vehicle: ((data ?? []) as VehicleRow[])[0] ?? { ...vehicle, ...fields }, km };
}

// ── Service schedules and services done ────────────────────────────────────────────────

export interface ServiceItemInput {
  id?: string | null;
  label?: string | null;
  everyKm?: number | null;
  everyMonths?: number | null;
  lastDoneKm?: number | null;
  lastDoneOn?: string | null;
  notes?: string | null;
  active?: boolean;
}

export function matchServiceItem(items: ServiceItemRow[], label: string): ServiceItemRow[] {
  return pickByName(items, label, (i) => [i.label]);
}

export async function saveServiceItem(admin: AdminClient, scope: Scope, vehicle: VehicleRow, input: ServiceItemInput): Promise<Result<{ item: ServiceItemRow; created: boolean }>> {
  const db = admin as Db;
  const fields: Record<string, unknown> = {};
  if (input.label !== undefined) {
    const label = cleanText(input.label, 60);
    if (!label) return { error: "What's the service called (e.g. Oil change)?" };
    fields.label = label;
  }
  if (input.everyKm !== undefined) {
    if (input.everyKm !== null && !(Number.isInteger(input.everyKm) && input.everyKm >= 100 && input.everyKm <= 200_000)) return { error: "Every how many km? (100 to 200,000)" };
    fields.every_km = input.everyKm;
  }
  if (input.everyMonths !== undefined) {
    if (input.everyMonths !== null && !(Number.isInteger(input.everyMonths) && input.everyMonths >= 1 && input.everyMonths <= 60)) return { error: "Every how many months? (1 to 60)" };
    fields.every_months = input.everyMonths;
  }
  if (input.lastDoneKm !== undefined) {
    if (input.lastDoneKm !== null && !(Number.isInteger(input.lastDoneKm) && input.lastDoneKm >= 0 && input.lastDoneKm <= MAX_KM)) return { error: "The last-done km looks off." };
    fields.last_done_km = input.lastDoneKm;
  }
  const lastOn = dateOrError(input.lastDoneOn, "The last-done date");
  if (isErr(lastOn)) return lastOn;
  if (lastOn !== undefined) fields.last_done_on = lastOn;
  if (input.notes !== undefined) fields.notes = cleanText(input.notes, 500);
  if (input.active !== undefined) fields.active = input.active;

  const items = await loadServiceItems(admin, scope, [vehicle.id]);
  let existing: ServiceItemRow | null = null;
  if (input.id) {
    existing = items.find((i) => i.id === input.id) ?? null;
    if (!existing) return { error: "Service not found." };
  } else {
    if (!fields.label) return { error: "What's the service called (e.g. Oil change)?" };
    existing = items.find((i) => norm(i.label) === norm(fields.label as string)) ?? null;
  }
  const merged = { every_km: existing?.every_km ?? null, every_months: existing?.every_months ?? null, ...fields } as { every_km: number | null; every_months: number | null };
  if (fields.active !== false && merged.every_km == null && merged.every_months == null) return { error: "How often? Give every N km and/or every N months." };
  if (existing) {
    const { data, error } = await db.from("vehicle_service_items").update(fields).eq("id", existing.id).eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).select("*");
    if (error) return error.code === "23505" ? { error: `${vehicle.name} already has a ${fields.label as string}.` } : Promise.reject(error);
    return { item: ((data ?? []) as ServiceItemRow[])[0] ?? ({ ...existing, ...fields } as ServiceItemRow), created: false };
  }
  const { data, error } = await db
    .from("vehicle_service_items")
    .insert({ organization_id: scope.organizationId, company_id: scope.companyId, vehicle_id: vehicle.id, active: true, ...fields })
    .select("*")
    .single();
  if (error) return error.code === "23505" ? { error: `${vehicle.name} already has a ${fields.label as string}.` } : Promise.reject(error);
  return { item: data as ServiceItemRow, created: true };
}

/** When a service happened: now for today, else noon local that day. */
function happenedAt(date: string, today: string, nowMs: number, timeZone: string): string {
  return date === today ? new Date(nowMs).toISOString() : zonedInstant(date, "12:00", timeZone).toISOString();
}

export interface ServiceDone {
  label: string;
  km?: number | null;
  date?: string | null;
  everyKm?: number | null;
  everyMonths?: number | null;
  sourceKey?: string | null;
}

/** "oil change done on truck 2 at 84,200" → the schedule's last-done moves on; a log row; the reply. */
export async function logVehicleService(admin: AdminClient, scope: Scope, vehicle: VehicleRow, done: ServiceDone, nowMs: number, source: FleetLogSource): Promise<Result<{ message: string }>> {
  const label = cleanText(done.label, 60);
  if (!label) return { error: "Which service (e.g. oil change)?" };
  const today = localDateOf(nowMs, scope.timeZone);
  const date = done.date ?? today;
  if (!isValidDateString(date) || date > addDays(today, 1)) return { error: "The date looks off (YYYY-MM-DD, not in the future)." };
  if (done.km != null && !(Number.isFinite(done.km) && done.km >= 0 && done.km <= MAX_KM)) return { error: "The km looks off." };

  let current = vehicle;
  let km: number | null = done.km != null ? Math.round(done.km) : null;
  let kmGuess = false;
  if (km != null && (current.odometer_km == null || km > current.odometer_km) && date === today) {
    const logged = await logOdometer(admin, scope, current, km, nowMs, { source });
    if ("vehicle" in logged) current = logged.vehicle;
  }
  if (km == null) {
    const p = projectedKm(current, nowMs);
    if (p.km != null && date === today) {
      km = p.km;
      kmGuess = !(current.odometer_at && nowMs - Date.parse(current.odometer_at) < 3 * DAY_MS);
    }
  }

  const items = await loadServiceItems(admin, scope, [current.id]);
  const hits = matchServiceItem(items, label);
  if (hits.length > 1) return { error: `Which one: ${hits.map((h) => h.label).join(", ")}?` };
  let item: ServiceItemRow | null = hits[0] ?? null;
  const schedule = done.everyKm !== undefined || done.everyMonths !== undefined ? { everyKm: done.everyKm ?? undefined, everyMonths: done.everyMonths ?? undefined } : {};
  if (item || done.everyKm != null || done.everyMonths != null) {
    const saved = await saveServiceItem(admin, scope, current, { id: item?.id, label: item ? undefined : label, ...schedule, lastDoneOn: date, lastDoneKm: km });
    if ("error" in saved) return saved;
    item = saved.item;
  }
  const { error } = await (admin as Db).from("fleet_log").insert({
    organization_id: scope.organizationId,
    company_id: scope.companyId,
    vehicle_id: current.id,
    service_item_id: item?.id ?? null,
    kind: "service",
    reading: km,
    label: item?.label ?? label,
    source,
    source_key: done.sourceKey ?? null,
    happened_at: happenedAt(date, today, nowMs, scope.timeZone),
  });
  if (error && error.code !== "23505") throw error;

  const at = km != null ? ` at ${kmGuess ? "about " : ""}${fmtNum(km)} km` : "";
  const head = `Logged: ${current.name} ${(item?.label ?? label).toLowerCase()}${at} (${prettyDate(date)}).`;
  if (!item) return { message: `${head} Want reminders? Text me "${label.toLowerCase()} every 8,000 km on ${current.name.toLowerCase()}".` };
  const next = serviceDue(item, current, today, nowMs);
  const nextWords = next.state === "unknown" ? "" : ` Next one ${nextDueWords(next)}.`;
  const tail = item.every_km && km == null ? ` Text me the km it was done at so I can track the next one by km.` : kmGuess ? ` Text me the exact km if you have it.` : "";
  return { message: `${head}${nextWords}${tail}` };
}

// ── Equipment ──────────────────────────────────────────────────────────────────────────

export interface EquipmentInput {
  id?: string | null;
  name?: string | null;
  serial?: string | null;
  valueCents?: number | null;
  status?: EquipmentStatus;
  location?: string | null;
  serviceEveryHours?: number | null;
  serviceEveryMonths?: number | null;
  lastServicedOn?: string | null;
  lastServicedHours?: number | null;
  hours?: number | null;
  notes?: string | null;
}

const hoursOk = (v: number | null | undefined) => v == null || (Number.isFinite(v) && v >= 0 && v <= MAX_HOURS);

export async function saveEquipment(admin: AdminClient, scope: Scope, input: EquipmentInput): Promise<Result<{ equipment: EquipmentRow; created: boolean }>> {
  const db = admin as Db;
  const fields: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = cleanText(input.name, 60);
    if (!name) return { error: "Give it a name, like Mini-ex." };
    fields.name = name;
  }
  if (input.serial !== undefined) fields.serial = cleanText(input.serial, 60);
  if (input.valueCents !== undefined) {
    if (input.valueCents !== null && !(Number.isInteger(input.valueCents) && input.valueCents >= 0 && input.valueCents <= 10_000_000_000)) return { error: "The value looks off." };
    fields.value_cents = input.valueCents;
  }
  if (input.status !== undefined) {
    if (!["available", "out", "in_shop", "retired"].includes(input.status)) return { error: "Status is available, out, in shop or retired." };
    fields.status = input.status;
    if (input.status !== "out") Object.assign(fields, { booking_id: null, out_at: null, out_profile_id: null });
  }
  if (input.location !== undefined) fields.location = cleanText(input.location, 120);
  if (input.serviceEveryHours !== undefined) {
    if (input.serviceEveryHours !== null && !(input.serviceEveryHours > 0 && input.serviceEveryHours <= 100_000)) return { error: "Every how many hours?" };
    fields.service_every_hours = input.serviceEveryHours;
  }
  if (input.serviceEveryMonths !== undefined) {
    if (input.serviceEveryMonths !== null && !(Number.isInteger(input.serviceEveryMonths) && input.serviceEveryMonths >= 1 && input.serviceEveryMonths <= 60)) return { error: "Every how many months? (1 to 60)" };
    fields.service_every_months = input.serviceEveryMonths;
  }
  const last = dateOrError(input.lastServicedOn, "The last service date");
  if (isErr(last)) return last;
  if (last !== undefined) fields.last_serviced_on = last;
  if (!hoursOk(input.lastServicedHours) || !hoursOk(input.hours)) return { error: "The hours look off." };
  if (input.lastServicedHours !== undefined) fields.last_serviced_hours = input.lastServicedHours;
  if (input.hours !== undefined) fields.hours = input.hours;
  if (input.notes !== undefined) fields.notes = cleanText(input.notes, 500);

  const all = await loadEquipment(admin, scope);
  let existing: EquipmentRow | null = null;
  if (input.id) {
    const { data, error } = await db.from("equipment").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("id", input.id).maybeSingle();
    if (error) throw error;
    if (!data) return { error: "Equipment not found." };
    existing = data as EquipmentRow;
  } else {
    if (!fields.name) return { error: "Give it a name, like Mini-ex." };
    existing = all.find((e) => norm(e.name) === norm(fields.name as string)) ?? null;
    if (existing) delete fields.name;
  }
  // Service history starts now when an interval is set without one (so hours don't count from 0).
  const after = { ...(existing ?? {}), ...fields } as Partial<EquipmentRow>;
  if (after.service_every_hours && after.last_serviced_hours == null && after.hours != null && input.lastServicedHours === undefined) fields.last_serviced_hours = after.hours;
  if (existing) {
    const { data, error } = await db.from("equipment").update(fields).eq("id", existing.id).eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).select("*");
    if (error) return error.code === "23505" ? { error: `There's already equipment called ${fields.name as string}.` } : Promise.reject(error);
    return { equipment: ((data ?? []) as EquipmentRow[])[0] ?? ({ ...existing, ...fields } as EquipmentRow), created: false };
  }
  const { data, error } = await db
    .from("equipment")
    .insert({ organization_id: scope.organizationId, company_id: scope.companyId, status: "available", ...fields })
    .select("*")
    .single();
  if (error) return error.code === "23505" ? { error: `There's already equipment called ${fields.name as string}.` } : Promise.reject(error);
  return { equipment: data as EquipmentRow, created: true };
}

export function matchEquipment(all: EquipmentRow[], ref: string): EquipmentRow[] {
  return pickByName(all, ref, (e) => [e.name, e.serial]);
}

export async function equipmentOut(admin: AdminClient, scope: Scope, eq: EquipmentRow, to: { job?: JobRef | null; profileId?: string | null; location?: string | null }, nowMs: number, source: FleetLogSource): Promise<EquipmentRow> {
  const db = admin as Db;
  const fields = { status: "out", booking_id: to.job?.bookingId ?? null, out_at: new Date(nowMs).toISOString(), out_profile_id: to.profileId ?? null, location: cleanText(to.location, 120) ?? (to.job ? `${to.job.label} job` : null) };
  const { data, error } = await db.from("equipment").update(fields).eq("id", eq.id).eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).select("*");
  if (error) throw error;
  await insertLog(admin, { organization_id: scope.organizationId, company_id: scope.companyId, equipment_id: eq.id, kind: "check_out", booking_id: fields.booking_id, profile_id: fields.out_profile_id, label: fields.location, source, happened_at: fields.out_at });
  return ((data ?? []) as EquipmentRow[])[0] ?? ({ ...eq, ...fields } as EquipmentRow);
}

export async function equipmentBack(admin: AdminClient, scope: Scope, eq: EquipmentRow, back: { hours?: number | null; inShop?: boolean; location?: string | null; note?: string | null }, nowMs: number, source: FleetLogSource): Promise<Result<EquipmentRow>> {
  if (!hoursOk(back.hours)) return { error: "The hours look off." };
  const db = admin as Db;
  const fields: Record<string, unknown> = { status: back.inShop ? "in_shop" : "available", booking_id: null, out_at: null, out_profile_id: null, location: cleanText(back.location, 120) };
  if (back.hours != null) fields.hours = back.hours;
  const { data, error } = await db.from("equipment").update(fields).eq("id", eq.id).eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).select("*");
  if (error) throw error;
  await insertLog(admin, { organization_id: scope.organizationId, company_id: scope.companyId, equipment_id: eq.id, kind: "check_in", reading: back.hours ?? null, label: back.inShop ? "in shop" : null, notes: cleanText(back.note, 500), source, happened_at: new Date(nowMs).toISOString() });
  return ((data ?? []) as EquipmentRow[])[0] ?? ({ ...eq, ...fields } as EquipmentRow);
}

/** An hour-meter reading ("mini-ex at 412 hours"). */
export async function logEquipmentHours(admin: AdminClient, scope: Scope, eq: EquipmentRow, hours: number, nowMs: number, source: FleetLogSource): Promise<Result<EquipmentRow>> {
  if (!hoursOk(hours)) return { error: "The hours look off." };
  const db = admin as Db;
  const { data, error } = await db.from("equipment").update({ hours }).eq("id", eq.id).eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).select("*");
  if (error) throw error;
  await insertLog(admin, { organization_id: scope.organizationId, company_id: scope.companyId, equipment_id: eq.id, kind: "hours", reading: hours, source, happened_at: new Date(nowMs).toISOString() });
  return ((data ?? []) as EquipmentRow[])[0] ?? ({ ...eq, hours } as EquipmentRow);
}

export async function logEquipmentService(admin: AdminClient, scope: Scope, eq: EquipmentRow, done: { label?: string | null; hours?: number | null; date?: string | null; sourceKey?: string | null }, nowMs: number, source: FleetLogSource): Promise<Result<{ message: string; equipment: EquipmentRow }>> {
  const today = localDateOf(nowMs, scope.timeZone);
  const date = done.date ?? today;
  if (!isValidDateString(date) || date > addDays(today, 1)) return { error: "The date looks off (YYYY-MM-DD, not in the future)." };
  if (!hoursOk(done.hours)) return { error: "The hours look off." };
  const hours = done.hours ?? num(eq.hours);
  const fields: Record<string, unknown> = { last_serviced_on: date, last_serviced_hours: hours };
  if (done.hours != null && (num(eq.hours) == null || done.hours > (num(eq.hours) as number))) fields.hours = done.hours;
  if (eq.status === "in_shop") fields.status = "available";
  const db = admin as Db;
  const { data, error } = await db.from("equipment").update(fields).eq("id", eq.id).eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).select("*");
  if (error) throw error;
  const updated = ((data ?? []) as EquipmentRow[])[0] ?? ({ ...eq, ...fields } as EquipmentRow);
  const { error: logErr } = await db.from("fleet_log").insert({
    organization_id: scope.organizationId,
    company_id: scope.companyId,
    equipment_id: eq.id,
    kind: "service",
    reading: hours,
    label: cleanText(done.label, 80) ?? "service",
    source,
    source_key: done.sourceKey ?? null,
    happened_at: happenedAt(date, today, nowMs, scope.timeZone),
  });
  if (logErr && logErr.code !== "23505") throw logErr;
  const next = equipmentDue(updated, today);
  const parts: string[] = [];
  if (next.hoursLeft != null) parts.push(`in ${fmtNum(next.hoursLeft)} hours`);
  if (next.dueOn) parts.push(`by ${prettyDate(next.dueOn)}`);
  const nextWords = parts.length ? ` Next service due ${parts.join(" or ")}.` : ` Set a service interval in Settings to get reminders.`;
  return { equipment: updated, message: `Logged: ${eq.name} ${cleanText(done.label, 60)?.toLowerCase() ?? "service"}${hours != null ? ` at ${fmtNum(hours)} hours` : ""} (${prettyDate(date)}).${fields.status ? " Marked back from the shop." : ""}${nextWords}` };
}

// ── Rentals ────────────────────────────────────────────────────────────────────────────

export interface RentalInput {
  id?: string | null;
  item?: string | null;
  vendor?: string | null;
  vendorPhone?: string | null;
  bookingId?: string | null;
  outAtMs?: number | null;
  dueBackAtMs?: number | null;
  rateCentsPerDay?: number | null;
  notes?: string | null;
}

export function matchRental(open: RentalRow[], ref: string): RentalRow[] {
  return pickByName(open, ref, (r) => [r.item, r.vendor, [r.vendor, r.item].filter(Boolean).join(" ")]);
}

export async function saveRental(admin: AdminClient, scope: Scope, input: RentalInput, nowMs: number, via: "owner_sms" | "settings"): Promise<Result<{ rental: RentalRow; created: boolean }>> {
  const db = admin as Db;
  const fields: Record<string, unknown> = {};
  if (input.item !== undefined) {
    const item = cleanText(input.item, 80);
    if (!item) return { error: "What did you rent (e.g. mini-ex)?" };
    fields.item = item;
  }
  if (input.vendor !== undefined) fields.vendor = cleanText(input.vendor, 80);
  if (input.vendorPhone !== undefined) {
    const phone = cleanPhone(input.vendorPhone);
    if (phone === undefined) return { error: "That phone number doesn't look right." };
    fields.vendor_phone = phone;
  }
  if (input.bookingId !== undefined) {
    if (input.bookingId) {
      const { data } = await db.from("bookings").select("id").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("id", input.bookingId).maybeSingle();
      if (!data) return { error: "Job not found." };
    }
    fields.booking_id = input.bookingId || null;
  }
  if (input.outAtMs !== undefined) fields.out_at = input.outAtMs == null ? null : new Date(input.outAtMs).toISOString();
  if (input.dueBackAtMs !== undefined) fields.due_back_at = input.dueBackAtMs == null ? null : new Date(input.dueBackAtMs).toISOString();
  if (input.rateCentsPerDay !== undefined) {
    if (input.rateCentsPerDay !== null && !(Number.isInteger(input.rateCentsPerDay) && input.rateCentsPerDay >= 0 && input.rateCentsPerDay <= 10_000_000)) return { error: "The daily rate looks off." };
    fields.rate_cents_per_day = input.rateCentsPerDay;
  }
  if (input.notes !== undefined) fields.notes = cleanText(input.notes, 500);
  if (fields.out_at && fields.due_back_at && Date.parse(fields.due_back_at as string) < Date.parse(fields.out_at as string)) return { error: "It can't be due back before it went out." };

  if (input.id) {
    const { data, error } = await db.from("rentals").update(fields).eq("id", input.id).eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).select("*");
    if (error) throw error;
    const row = ((data ?? []) as RentalRow[])[0];
    if (!row) return { error: "Rental not found." };
    return { rental: row, created: false };
  }
  if (!fields.item) return { error: "What did you rent (e.g. mini-ex)?" };
  if (fields.out_at === undefined) fields.out_at = new Date(nowMs).toISOString();
  const { data, error } = await db
    .from("rentals")
    .insert({ organization_id: scope.organizationId, company_id: scope.companyId, created_via: via, ...fields })
    .select("*")
    .single();
  if (error) throw error;
  const rental = data as RentalRow;
  await insertLog(admin, { organization_id: scope.organizationId, company_id: scope.companyId, rental_id: rental.id, kind: "rental_out", booking_id: rental.booking_id, label: rental.item, source: via, happened_at: rental.out_at ?? new Date(nowMs).toISOString() });
  return { rental, created: true };
}

/** Mark a rental returned (claimed: only an open one). Null when it was already returned. */
export async function returnRental(admin: AdminClient, scope: Scope, rental: RentalRow, atMs: number, source: FleetLogSource): Promise<RentalRow | null> {
  const db = admin as Db;
  const at = new Date(atMs).toISOString();
  const { data, error } = await db.from("rentals").update({ returned_at: at }).eq("id", rental.id).eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).is("returned_at", null).select("*");
  if (error) throw error;
  const row = ((data ?? []) as RentalRow[])[0];
  if (!row) return null;
  await insertLog(admin, { organization_id: scope.organizationId, company_id: scope.companyId, rental_id: rental.id, kind: "rental_returned", label: rental.item, source, happened_at: at });
  return row;
}
