/**
 * The fleet at a glance (owner tool fleet_status, and the Settings view's due words): each
 * vehicle's odometer, plate sticker, safety inspection and service schedule; equipment and where
 * it is; rentals out; vehicle insurance as Compliance has it (read-only); what needs attention.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { fmtNum, localDateOf, money, prettyDate, shortDate, timeLabel } from "./dates";
import { num, type EquipmentRow, type RentalRow, type ServiceItemRow, type VehicleRow } from "./db-types";
import { equipmentDue, nextDueWords, projectedKm, serviceDue } from "./due";
import { collectCandidates } from "./reminders";
import { insuranceWords, loadCrew, loadEquipment, loadOpenRentals, loadServiceItems, loadVehicles, pickByName, vehicleDescription, vehicleInsurance, vehicleNames } from "./records";
import type { FleetCompany } from "./settings";

export function odometerWords(v: VehicleRow, nowMs: number, timeZone: string): string {
  if (v.odometer_km == null || !v.odometer_at) return "no odometer reading yet";
  const p = projectedKm(v, nowMs);
  const asOf = prettyDate(localDateOf(Date.parse(v.odometer_at), timeZone));
  const avg = num(v.avg_km_per_day);
  const proj = p.km != null && avg && p.km !== v.odometer_km ? `, about ${fmtNum(Math.round(p.km / 100) * 100)} now` : "";
  return `${fmtNum(v.odometer_km)} km on ${asOf}${proj}${avg ? ` (~${fmtNum(avg)} km/day)` : ""}${p.stale ? " - old reading" : ""}`;
}

export function serviceWords(item: ServiceItemRow, v: VehicleRow, today: string, nowMs: number): string {
  const every = [item.every_km ? `every ${fmtNum(item.every_km)} km` : null, item.every_months ? `every ${item.every_months} mo` : null].filter(Boolean).join(" / ");
  return `${item.label} (${every}): ${nextDueWords(serviceDue(item, v, today, nowMs))}`;
}

const EQUIPMENT_STATUS: Record<string, string> = { available: "in", out: "out", in_shop: "in the shop", retired: "retired" };

export function equipmentWords(e: EquipmentRow, today: string, timeZone: string, jobLabel?: string | null): { status: string; service: string | null } {
  let status = EQUIPMENT_STATUS[e.status] ?? e.status;
  if (e.status === "out") status = `out${e.location ? ` - ${e.location}` : jobLabel ? ` - ${jobLabel}` : ""}${e.out_at ? ` since ${shortDate(localDateOf(Date.parse(e.out_at), timeZone))}` : ""}`;
  else if (e.location) status = `${status} (${e.location})`;
  const due = equipmentDue(e, today);
  let service: string | null = null;
  if (due.state !== "unknown") {
    const parts: string[] = [];
    if (due.hoursLeft != null) parts.push(due.hoursLeft < 0 ? `${fmtNum(-due.hoursLeft)} hours overdue` : `in ${fmtNum(due.hoursLeft)} hours`);
    if (due.dueOn) parts.push(due.daysLeft != null && due.daysLeft < 0 ? `overdue since ${shortDate(due.dueOn)}` : `by ${shortDate(due.dueOn)}`);
    service = `service ${parts.join(" or ")}`;
  }
  return { status, service };
}

export function rentalWords(r: RentalRow, timeZone: string): string {
  const due = r.due_back_at ? `due back ${shortDate(localDateOf(Date.parse(r.due_back_at), timeZone))} ${timeLabel(Date.parse(r.due_back_at), timeZone)}` : "no due-back date";
  return [r.vendor ? `${r.vendor} ${r.item}` : r.item, due, r.rate_cents_per_day ? `${money(r.rate_cents_per_day)}/day` : null].filter(Boolean).join(", ");
}

export async function fleetStatus(admin: AdminClient, company: FleetCompany, nowMs: number, vehicleRef?: string | null): Promise<Record<string, unknown>> {
  const today = localDateOf(nowMs, company.timeZone);
  const [allVehicles, equipment, rentals, crew, insurance] = await Promise.all([
    loadVehicles(admin, company),
    loadEquipment(admin, company),
    loadOpenRentals(admin, company),
    loadCrew(admin, company.organizationId),
    vehicleInsurance(admin, company),
  ]);
  const vehicles = vehicleRef ? pickByName(allVehicles, vehicleRef, vehicleNames) : allVehicles;
  if (vehicleRef && vehicles.length === 0) return { error: `No vehicle matches "${vehicleRef}". You have: ${allVehicles.map((v) => v.name).join(", ") || "none yet"}.` };
  const items = await loadServiceItems(admin, company, allVehicles.map((v) => v.id));
  const crewName = new Map(crew.map((c) => [c.profileId, c.name]));
  const needs = collectCandidates({ vehicles: allVehicles, items, equipment, rentals }, nowMs, company.timeZone).map((c) => c.line);
  if (allVehicles.length + equipment.length + rentals.length === 0) {
    return { ok: true, empty: true, tell_owner: 'Nothing in your fleet yet. Text me "add truck 2, 2019 F-150, plate ABCD 123, sticker due Mar 31" or add vehicles, equipment and rentals in Settings > AI front desk > Fleet & equipment.' };
  }
  return {
    ok: true,
    vehicles: vehicles.map((v) => ({
      name: v.name,
      description: vehicleDescription(v) || null,
      driver: v.profile_id ? crewName.get(v.profile_id) ?? null : null,
      odometer: odometerWords(v, nowMs, company.timeZone),
      plate_sticker: v.plate_sticker_due ? `expires ${prettyDate(v.plate_sticker_due)}` : "no date on file",
      safety_inspection: v.safety_inspection_required ? (v.safety_inspection_due ? `due ${prettyDate(v.safety_inspection_due)}` : "needed - no date on file") : null,
      services: items.filter((i) => i.vehicle_id === v.id).map((i) => serviceWords(i, v, today, nowMs)),
    })),
    equipment: vehicleRef ? undefined : equipment.map((e) => ({ name: e.name, ...equipmentWords(e, today, company.timeZone) })),
    rentals_out: vehicleRef ? undefined : rentals.map((r) => rentalWords(r, company.timeZone)),
    vehicle_insurance: insuranceWords(insurance) ?? "none on file (Compliance keeps it - text a photo of the pink slip / policy)",
    needs_attention: needs.slice(0, 8),
  };
}
