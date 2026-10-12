/**
 * Lines for the Office manager's 07:00 briefing (docs/ai-staff.md → "Fleet & equipment";
 * integration wires this in). Read-only, never claims or texts anything, never throws. [] when
 * Fleet is off for the company (house orgs), when nothing is due, or when a read fails.
 *
 *   "Rental mini-ex due back today 5pm (Sunbelt)"
 *   "Truck 2 oil change due (about 8,100 km since last)"
 *   "Truck 1 plate sticker expires in 7 days"
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { zonedInstant } from "@/server/services/booking-windows";
import { daysBetween, isValidDateString } from "./dates";
import { equipmentDue, equipmentLine, plateLine, rentalBriefingLine, rentalStage, safetyLine, serviceDue, serviceLine } from "./due";
import { loadEquipment, loadOpenRentals, loadServiceItems, loadVehicles } from "./records";
import { loadFleetCompany } from "./settings";

const MAX_ITEMS = 4;

export async function briefingItems(admin: AdminClient, scope: { organizationId: string; companyId: string }, localDate: string): Promise<string[]> {
  try {
    if (!isValidDateString(localDate)) return [];
    const company = await loadFleetCompany(admin, scope);
    if (!company || !company.active || !company.settings.enabled) return [];
    const nowMs = zonedInstant(localDate, "07:00", company.timeZone).getTime();
    const [vehicles, equipment, rentals] = await Promise.all([loadVehicles(admin, company), loadEquipment(admin, company), loadOpenRentals(admin, company)]);
    if (vehicles.length + equipment.length + rentals.length === 0) return [];
    const items = await loadServiceItems(admin, company, vehicles.map((v) => v.id));
    const lines: Array<{ rank: number; line: string }> = [];
    for (const r of rentals) {
      const stage = rentalStage(r, nowMs, company.timeZone);
      if (stage && stage.stage !== "before") lines.push({ rank: stage.stage === "overdue" ? 0 : 1, line: rentalBriefingLine(r, stage, company.timeZone) });
    }
    const byId = new Map(vehicles.map((v) => [v.id, v]));
    for (const item of items) {
      const v = byId.get(item.vehicle_id);
      if (!v) continue;
      const due = serviceDue(item, v, localDate, nowMs);
      if (due.state === "due" || due.state === "overdue") lines.push({ rank: due.state === "overdue" ? 2 : 4, line: serviceLine(v.name, item.label, due) });
    }
    for (const v of vehicles) {
      if (v.plate_sticker_due) {
        const days = daysBetween(localDate, v.plate_sticker_due);
        if (days <= 7 && days >= -30) lines.push({ rank: 3, line: plateLine(v.name, v.plate_sticker_due, localDate) });
      }
      if (v.safety_inspection_required && v.safety_inspection_due) {
        const days = daysBetween(localDate, v.safety_inspection_due);
        if (days <= 7 && days >= -30) lines.push({ rank: 3, line: safetyLine(v.name, v.safety_inspection_due, localDate) });
      }
    }
    for (const e of equipment) {
      const due = equipmentDue(e, localDate);
      if (due.state === "due" || due.state === "overdue") lines.push({ rank: due.state === "overdue" ? 2 : 5, line: equipmentLine(e.name, due) });
    }
    const sorted = lines.sort((a, b) => a.rank - b.rank).map((l) => l.line);
    return sorted.length > MAX_ITEMS ? [...sorted.slice(0, MAX_ITEMS - 1), `+${sorted.length - (MAX_ITEMS - 1)} more fleet items - text "fleet"`] : sorted;
  } catch (err) {
    console.error("[fleet] briefing items failed:", err instanceof Error ? err.message : err);
    return [];
  }
}
