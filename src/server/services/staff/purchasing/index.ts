/**
 * Purchasing (docs/ai-staff.md → "Purchasing"): materials lists, supplier orders, pickups.
 *
 *   Drafting   confirmed jobs with a quote, `lead_days`–14 days out → recipe lines × quote
 *              quantities (else an AI estimate, marked "estimate") → a purchase order (PO-<n>) and
 *              the owner's `materials_order` question ("Y 12 delivery", "Y 12 no nails" understood).
 *   Sending    Y emails the supplier (from the business name, reply-to the owner) with the PO
 *              number, list, needed-by, pickup/delivery and account; no supplier email → the owner
 *              is texted the list to call in.
 *   Tracking   owner tools materials_status / mark_materials / order_materials / add_supplier /
 *              set_recipe, a reminder the afternoon before the job, the list on the crew's job
 *              sheet, and briefing items for the Office manager (briefing-items.ts).
 *   Costing    never writes job_materials or expenses (receipts are the actual cost).
 *
 * Sweeps: purchasing:draft, purchasing:reminders. Off for house orgs unless switched on.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { emptyRole, type StaffRoleModule, type StaffSweep } from "@/server/services/staff/types";
import { executeMaterialsOrder, MATERIALS_ORDER_KIND } from "./orders";
import { purchasingOwnerTools } from "./owner-tools";
import { loadPurchasingCompanies, purchasingActiveFor, type PurchasingCompany } from "./settings";
import { runCompanyDrafts, runCompanyJobChanges, runCompanyReminders } from "./sweeps";

let cached: { atMs: number; companies: PurchasingCompany[] } | null = null;

/** The feature-on companies, loaded at most once per 30 s and shared by the sweeps. */
async function companiesFor(admin: AdminClient, nowMs: number): Promise<PurchasingCompany[]> {
  if (cached && Math.abs(nowMs - cached.atMs) < 30_000) return cached.companies;
  const companies = await loadPurchasingCompanies(admin);
  cached = { atMs: nowMs, companies };
  return companies;
}

/** Test hook. */
export function resetPurchasingCompanyCache(): void {
  cached = null;
}

async function eachCompany(admin: AdminClient, nowMs: number, run: (company: PurchasingCompany) => Promise<unknown>): Promise<void> {
  for (const company of await companiesFor(admin, nowMs)) {
    try {
      await run(company);
    } catch (err) {
      console.error("[purchasing] company pass failed", company.companyId, err instanceof Error ? err.message : err);
    }
  }
}

export const PURCHASING_SWEEPS: StaffSweep[] = [
  { name: "purchasing:draft", intervalMs: 10 * 60_000, run: (admin, nowMs) => eachCompany(admin, nowMs, (c) => runCompanyDrafts(admin, c, nowMs)) },
  {
    name: "purchasing:reminders",
    intervalMs: 10 * 60_000,
    run: (admin, nowMs) =>
      eachCompany(admin, nowMs, async (c) => {
        await runCompanyJobChanges(admin, c, nowMs);
        await runCompanyReminders(admin, c, nowMs);
      }),
  },
];

export const purchasingRole: StaffRoleModule = {
  ...emptyRole("purchasing"),
  activeFor: purchasingActiveFor,
  approvalExecutors: {
    [MATERIALS_ORDER_KIND]: (admin, approval, decision) => executeMaterialsOrder(admin, approval, decision),
  },
  ownerTools: purchasingOwnerTools(),
  ownerPromptNotes: [
    'Materials (purchasing): before a job with a quote the owner gets a materials order question (#code) - Y emails the supplier, "Y <code> delivery" has it delivered, "Y <code> no nails" leaves an item out, "Y <code> 25 bundles shingles" changes an amount. You can\'t approve it yourself. Use materials_status for "what\'s ordered / did the materials come in / how did the materials cost compare", mark_materials for "PO-12 ready", "picked up the Jones stuff", "PO-12 delivered" or "cancel PO-12", order_materials to start an order for a job now (relay its tell_owner_exactly word for word), add_supplier and set_recipe when they tell you about a supplier or what a job takes. Never invent prices; estimates are estimates.',
  ],
  sweeps: PURCHASING_SWEEPS,
};
