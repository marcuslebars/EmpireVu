/**
 * Fleet & equipment (docs/ai-staff.md → "Fleet & equipment"): vehicles, equipment, rentals.
 *
 *   Records    vehicles (odometer, plate sticker, safety inspection, service schedules), the
 *              business's equipment (in / out to a job / in the shop, service interval), rentals
 *              (due back, rate) and a log of readings, services and check-outs — by text (owner
 *              tools) or in Settings. An odometer photo with "truck 2 km" is logged (ownerMedia).
 *   Reminders  fleet:reminders texts the owner ONE combined heads-up a day (09:00–20:00): service
 *              due by date or projected km, plate sticker / safety inspection 30 and 7 days
 *              before and on the day, equipment service, rentals due back today or overdue; an
 *              afternoon text for rentals due back tomorrow. Claimed per item and stage.
 *   Briefing   briefing-items.ts for the Office manager's 07:00 briefing.
 *
 * Record keeping only — nothing texts a customer or moves money, so there's no approval kind.
 * Vehicle insurance stays with Compliance (shown read-only). On for done-for-you orgs (inert until
 * something is added), off for house orgs unless switched on.
 */
import { emptyRole, type StaffRoleModule, type StaffSweep } from "@/server/services/staff/types";
import { fleetOwnerMedia } from "./media";
import { fleetOwnerTools } from "./owner-tools";
import { sweepFleetReminders } from "./reminders";
import { fleetActiveFor } from "./settings";

export const FLEET_SWEEPS: StaffSweep[] = [{ name: "fleet:reminders", intervalMs: 15 * 60_000, run: async (admin, nowMs) => void (await sweepFleetReminders(admin, nowMs)) }];

export const fleetRole: StaffRoleModule = {
  ...emptyRole("fleet"),
  activeFor: fleetActiveFor,
  ownerMedia: fleetOwnerMedia,
  ownerTools: fleetOwnerTools(),
  ownerPromptNotes: [
    'Fleet & equipment (the business\'s trucks, trailers, machines, tools and rentals): "truck 2 at 84,200" → log_odometer; "oil change done on truck 2 at 84,200" → log_service; "oil change every 8,000 km on truck 2" → set_service_schedule; "add truck 2, 2019 F-150, plate ABCD 123, sticker due Mar 31" → add_vehicle; "add the mini-ex, service every 250 hours" → add_fleet_equipment; "rented a mini-ex from Sunbelt, $380/day, back Thursday 5pm" → add_rental (turn day words into YYYY-MM-DD dates); "mini-ex is back" → rental_returned when it\'s a rental, equipment_back when it\'s theirs; "mini-ex out to the Jones job" → equipment_out; "what\'s due on the trucks" / "fleet" → fleet_status. Relay tell_owner; ask ask_owner. Vehicle insurance is Compliance\'s (a photo of the policy), not a fleet record.',
  ],
  sweeps: FLEET_SWEEPS,
};
