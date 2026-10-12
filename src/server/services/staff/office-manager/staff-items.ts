/**
 * One-line heads-ups other AI staff want in the morning briefing (docs/ai-staff.md → "Office
 * manager"): unhappy customers and warranty visits (Customer care), expiring insurance/WSIB
 * (Compliance), materials to pick up (Purchasing), vehicle service and rentals due back (Fleet),
 * customer emails waiting (Email inbox), unpaid plan renewals (Service plans), cash tight (Profit
 * advisor), HST due soon (Receipts & HST). Each role's `briefingItems` decides for
 * itself whether it's on for the company; a role that fails is left out, never the briefing.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { briefingItems as complianceItems } from "@/server/services/staff/compliance/briefing-items";
import { briefingItems as purchasingItems } from "@/server/services/staff/purchasing/briefing-items";
import { briefingItems as servicePlanItems } from "@/server/services/staff/service-plans/briefing-items";
import { briefingItems as taxClerkItems } from "@/server/services/staff/tax-clerk/briefing-items";
import { briefingItems as customerCareItems } from "@/server/services/staff/customer-care/briefing-items";
import { briefingItems as emailClerkItems } from "@/server/services/staff/email-clerk/briefing-items";
import { briefingItems as fleetItems } from "@/server/services/staff/fleet/briefing-items";
import { briefingItems as profitAdvisorItems } from "@/server/services/staff/profit-advisor/briefing-items";

type ItemsFn = (admin: AdminClient, scope: { organizationId: string; companyId: string; timeZone?: string }, localDate: string) => Promise<string[]>;

/**
 * Most time-sensitive first: an unhappy customer, an expired certificate, today's pickup or a
 * rental due back beat customer emails, renewals, a cash warning or an HST reminder.
 */
const SOURCES: Array<{ name: string; items: ItemsFn }> = [
  { name: "customer care", items: customerCareItems },
  { name: "compliance", items: complianceItems },
  { name: "purchasing", items: purchasingItems },
  { name: "fleet", items: fleetItems },
  { name: "email", items: emailClerkItems },
  { name: "service plans", items: servicePlanItems },
  { name: "profit advisor", items: profitAdvisorItems },
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
  return pickFairly(lists, MAX_STAFF_ITEMS);
}

/**
 * Each role's most urgent line first (in role order), then each role's second line, and so on,
 * up to `max` — so one busy role can't crowd an unhappy customer or an expired certificate out.
 * PURE.
 */
export function pickFairly(lists: string[][], max: number): string[] {
  const out: string[] = [];
  for (let round = 0; out.length < max; round += 1) {
    let any = false;
    for (const list of lists) {
      if (round < list.length) {
        any = true;
        if (out.length < max) out.push(list[round]);
      }
    }
    if (!any) break;
  }
  return out;
}
