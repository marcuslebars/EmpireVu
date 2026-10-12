/**
 * One-line heads-ups other AI staff want in the morning briefing (docs/ai-staff.md → "Office
 * manager"): expiring insurance/WSIB (Compliance), materials to pick up (Purchasing), unpaid plan
 * renewals (Service plans), HST due soon (Receipts & HST). Each role's `briefingItems` decides for
 * itself whether it's on for the company; a role that fails is left out, never the briefing.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { briefingItems as complianceItems } from "@/server/services/staff/compliance/briefing-items";
import { briefingItems as purchasingItems } from "@/server/services/staff/purchasing/briefing-items";
import { briefingItems as servicePlanItems } from "@/server/services/staff/service-plans/briefing-items";
import { briefingItems as taxClerkItems } from "@/server/services/staff/tax-clerk/briefing-items";

type ItemsFn = (admin: AdminClient, scope: { organizationId: string; companyId: string; timeZone?: string }, localDate: string) => Promise<string[]>;

/** Most time-sensitive first: an expired certificate or today's pickup beats an HST reminder. */
const SOURCES: Array<{ name: string; items: ItemsFn }> = [
  { name: "compliance", items: complianceItems },
  { name: "purchasing", items: purchasingItems },
  { name: "service plans", items: servicePlanItems },
  { name: "tax clerk", items: taxClerkItems },
];

export const MAX_STAFF_ITEMS = 4;

export async function staffBriefingItems(
  admin: AdminClient,
  scope: { organizationId: string; companyId: string; timeZone: string },
  localDate: string,
  sources: Array<{ name: string; items: ItemsFn }> = SOURCES,
): Promise<string[]> {
  const lists = await Promise.all(
    sources.map(async (s) => {
      try {
        const items = await s.items(admin, scope, localDate);
        return Array.isArray(items) ? items.filter((x) => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : [];
      } catch (err) {
        console.error(`[office-manager] ${s.name} briefing items failed`, err instanceof Error ? err.message : err);
        return [];
      }
    }),
  );
  return lists.flat().slice(0, MAX_STAFF_ITEMS);
}
