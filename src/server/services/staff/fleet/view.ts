/**
 * Settings → AI front desk → Fleet & equipment: what the section shows and the actions it takes
 * (through the route; owners/admins change things, members read). Service role, scoped.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { updateAiSettings } from "@/server/services/front-desk/ai-settings-write";
import { zonedInstant } from "@/server/services/booking-windows";
import { daysBetween, isValidDateString, localDateOf } from "./dates";
import { num, type Db, type EquipmentStatus, type RentalRow } from "./db-types";
import { equipmentDue, rentalStage, serviceDue } from "./due";
import { collectCandidates } from "./reminders";
import {
  equipmentBack,
  equipmentOut,
  loadCrew,
  loadEquipment,
  loadOpenRentals,
  loadServiceItems,
  loadVehicles,
  logEquipmentService,
  logVehicleService,
  returnRental,
  saveEquipment,
  saveRental,
  saveServiceItem,
  saveVehicle,
  vehicleInsurance,
  type EquipmentInput,
  type ServiceItemInput,
  type VehicleInput,
} from "./records";
import { loadFleetCompany, mergeFleetSettings, type FleetCompany, type FleetSettings, type FleetSettingsPatch } from "./settings";
import { equipmentWords, odometerWords, rentalWords, serviceWords } from "./status";

type Scope = { organizationId: string; companyId: string };
type Tone = "ok" | "soon" | "late";

export interface FleetView {
  companyId: string;
  companyName: string;
  settings: FleetSettings;
  ownerPhoneOnFile: boolean;
  vehicles: Array<{
    id: string;
    name: string;
    year: number | null;
    make: string | null;
    model: string | null;
    plate: string | null;
    vin: string | null;
    driverProfileId: string | null;
    driverName: string | null;
    odometerKm: number | null;
    odometerWords: string;
    plateStickerDue: string | null;
    plateTone: Tone | null;
    safetyInspectionRequired: boolean;
    safetyInspectionDue: string | null;
    safetyTone: Tone | null;
    notes: string | null;
    services: Array<{ id: string; label: string; everyKm: number | null; everyMonths: number | null; lastDoneKm: number | null; lastDoneOn: string | null; words: string; tone: Tone | null }>;
  }>;
  equipment: Array<{
    id: string;
    name: string;
    serial: string | null;
    valueCents: number | null;
    status: EquipmentStatus;
    location: string | null;
    hours: number | null;
    serviceEveryHours: number | null;
    serviceEveryMonths: number | null;
    lastServicedOn: string | null;
    statusWords: string;
    serviceWords: string | null;
    tone: Tone | null;
  }>;
  rentals: Array<{ id: string; item: string; vendor: string | null; vendorPhone: string | null; dueBackAt: string | null; rateCentsPerDay: number | null; returnedAt: string | null; words: string; tone: Tone | null }>;
  vehicleInsurance: Array<{ issuer: string | null; expiresOn: string | null; status: string }>;
  crew: Array<{ profileId: string; name: string }>;
  attention: string[];
}

function dateTone(due: string | null, today: string): Tone | null {
  if (!due) return null;
  const days = daysBetween(today, due);
  return days < 0 ? "late" : days <= 30 ? "soon" : "ok";
}

const stateTone = (state: string): Tone | null => (state === "overdue" ? "late" : state === "due" ? "soon" : state === "ok" ? "ok" : null);

async function recentReturned(admin: AdminClient, scope: Scope, nowMs: number): Promise<RentalRow[]> {
  const { data, error } = await (admin as Db)
    .from("rentals")
    .select("*")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .gte("returned_at", new Date(nowMs - 30 * 86_400_000).toISOString())
    .order("returned_at", { ascending: false })
    .limit(10);
  if (error) throw error;
  return (data ?? []) as RentalRow[];
}

export async function getFleetView(admin: AdminClient, scope: Scope, nowMs = Date.now()): Promise<FleetView | null> {
  const company = await loadFleetCompany(admin, scope);
  if (!company) return null;
  const today = localDateOf(nowMs, company.timeZone);
  const [vehicles, equipment, open, returned, crew, insurance] = await Promise.all([
    loadVehicles(admin, company),
    loadEquipment(admin, company),
    loadOpenRentals(admin, company),
    recentReturned(admin, company, nowMs),
    loadCrew(admin, company.organizationId),
    vehicleInsurance(admin, company),
  ]);
  const items = await loadServiceItems(admin, company, vehicles.map((v) => v.id));
  const crewName = new Map(crew.map((c) => [c.profileId, c.name]));
  return {
    companyId: company.companyId,
    companyName: company.name,
    settings: company.settings,
    ownerPhoneOnFile: Boolean(company.ownerPhone),
    vehicles: vehicles.map((v) => ({
      id: v.id,
      name: v.name,
      year: v.year,
      make: v.make,
      model: v.model,
      plate: v.plate,
      vin: v.vin,
      driverProfileId: v.profile_id,
      driverName: v.profile_id ? crewName.get(v.profile_id) ?? null : null,
      odometerKm: v.odometer_km,
      odometerWords: odometerWords(v, nowMs, company.timeZone),
      plateStickerDue: v.plate_sticker_due,
      plateTone: dateTone(v.plate_sticker_due, today),
      safetyInspectionRequired: v.safety_inspection_required,
      safetyInspectionDue: v.safety_inspection_due,
      safetyTone: v.safety_inspection_required ? dateTone(v.safety_inspection_due, today) : null,
      notes: v.notes,
      services: items
        .filter((i) => i.vehicle_id === v.id)
        .map((i) => ({
          id: i.id,
          label: i.label,
          everyKm: i.every_km,
          everyMonths: i.every_months,
          lastDoneKm: i.last_done_km,
          lastDoneOn: i.last_done_on,
          words: serviceWords(i, v, today, nowMs),
          tone: stateTone(serviceDue(i, v, today, nowMs).state),
        })),
    })),
    equipment: equipment.map((e) => {
      const words = equipmentWords(e, today, company.timeZone);
      return {
        id: e.id,
        name: e.name,
        serial: e.serial,
        valueCents: e.value_cents == null ? null : Number(e.value_cents),
        status: e.status,
        location: e.location,
        hours: num(e.hours),
        serviceEveryHours: num(e.service_every_hours),
        serviceEveryMonths: e.service_every_months,
        lastServicedOn: e.last_serviced_on,
        statusWords: words.status,
        serviceWords: words.service,
        tone: stateTone(equipmentDue(e, today).state),
      };
    }),
    rentals: [...open, ...returned].map((r) => {
      const stage = rentalStage(r, nowMs, company.timeZone);
      return {
        id: r.id,
        item: r.item,
        vendor: r.vendor,
        vendorPhone: r.vendor_phone,
        dueBackAt: r.due_back_at,
        rateCentsPerDay: r.rate_cents_per_day,
        returnedAt: r.returned_at,
        words: rentalWords(r, company.timeZone),
        tone: r.returned_at ? null : stage?.stage === "overdue" ? "late" : stage ? "soon" : "ok",
      };
    }),
    vehicleInsurance: insurance,
    crew: crew.map((c) => ({ profileId: c.profileId, name: c.name })),
    attention: collectCandidates({ vehicles, items, equipment, rentals: open }, nowMs, company.timeZone).map((c) => c.line).slice(0, 8),
  };
}

export async function updateFleetSettings(admin: AdminClient, scope: Scope, patch: FleetSettingsPatch): Promise<FleetView | null> {
  const written = await updateAiSettings(admin, scope, (current) => mergeFleetSettings(current, patch));
  if (!written) return null;
  return getFleetView(admin, scope);
}

export type FleetAction =
  | { action: "save_vehicle"; vehicle: VehicleInput }
  | { action: "save_service_item"; vehicleId: string; item: ServiceItemInput }
  | { action: "service_done"; vehicleId?: string; equipmentId?: string; label: string; km?: number | null; hours?: number | null; date?: string | null }
  | { action: "save_equipment"; equipment: EquipmentInput }
  | { action: "equipment_status"; equipmentId: string; status: "out" | "available" | "in_shop"; location?: string | null }
  | { action: "save_rental"; rental: { id?: string | null; item?: string; vendor?: string | null; vendorPhone?: string | null; dueBackLocal?: string | null; rateCentsPerDay?: number | null; notes?: string | null } }
  | { action: "return_rental"; rentalId: string };

/** "2026-10-15T17:00" (company-local) → ms. Undefined → leave; null/"" → clear. */
function localToMs(raw: string | null | undefined, company: FleetCompany): number | null | undefined | "bad" {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(raw);
  if (!m || !isValidDateString(m[1])) return "bad";
  return zonedInstant(m[1], m[2], company.timeZone).getTime();
}

/** Owner/admin actions from Settings. { error } for a bad input (400), null when the company isn't the org's. */
export async function runFleetAction(admin: AdminClient, scope: Scope, body: FleetAction, nowMs = Date.now()): Promise<{ error: string } | { ok: true } | null> {
  const company = await loadFleetCompany(admin, scope);
  if (!company) return null;
  switch (body.action) {
    case "save_vehicle": {
      const saved = await saveVehicle(admin, company, body.vehicle, nowMs, "settings");
      if ("error" in saved) return saved;
      return saved.odometerNote ? { error: saved.odometerNote } : { ok: true };
    }
    case "save_service_item": {
      const vehicle = (await loadVehicles(admin, company)).find((v) => v.id === body.vehicleId);
      if (!vehicle) return { error: "Vehicle not found." };
      const saved = await saveServiceItem(admin, company, vehicle, body.item);
      return "error" in saved ? saved : { ok: true };
    }
    case "service_done": {
      if (body.vehicleId) {
        const vehicle = (await loadVehicles(admin, company)).find((v) => v.id === body.vehicleId);
        if (!vehicle) return { error: "Vehicle not found." };
        const done = await logVehicleService(admin, company, vehicle, { label: body.label, km: body.km ?? null, date: body.date ?? null }, nowMs, "settings");
        return "error" in done ? done : { ok: true };
      }
      const eq = (await loadEquipment(admin, company)).find((e) => e.id === body.equipmentId);
      if (!eq) return { error: "Equipment not found." };
      const done = await logEquipmentService(admin, company, eq, { label: body.label, hours: body.hours ?? null, date: body.date ?? null }, nowMs, "settings");
      return "error" in done ? done : { ok: true };
    }
    case "save_equipment": {
      const saved = await saveEquipment(admin, company, body.equipment);
      return "error" in saved ? saved : { ok: true };
    }
    case "equipment_status": {
      const eq = (await loadEquipment(admin, company)).find((e) => e.id === body.equipmentId);
      if (!eq) return { error: "Equipment not found." };
      if (body.status === "out") await equipmentOut(admin, company, eq, { location: body.location ?? null }, nowMs, "settings");
      else {
        const back = await equipmentBack(admin, company, eq, { inShop: body.status === "in_shop", location: body.location ?? null }, nowMs, "settings");
        if ("error" in back) return back;
      }
      return { ok: true };
    }
    case "save_rental": {
      const due = localToMs(body.rental.dueBackLocal, company);
      if (due === "bad") return { error: "The due-back time looks off." };
      const saved = await saveRental(
        admin,
        company,
        { id: body.rental.id ?? undefined, item: body.rental.item, vendor: body.rental.vendor, vendorPhone: body.rental.vendorPhone, dueBackAtMs: due, rateCentsPerDay: body.rental.rateCentsPerDay, notes: body.rental.notes },
        nowMs,
        "settings",
      );
      return "error" in saved ? saved : { ok: true };
    }
    case "return_rental": {
      const rental = (await loadOpenRentals(admin, company)).find((r) => r.id === body.rentalId);
      if (!rental) return { error: "That rental isn't out." };
      await returnRental(admin, company, rental, nowMs, "settings");
      return { ok: true };
    }
  }
}
