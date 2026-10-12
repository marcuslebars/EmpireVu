/**
 * Lines for the Office manager's 07:00 briefing (integration wires this in; nothing here sends):
 *   "HST due in 6 days (about $860)"  within 10 days of the payment due date, registrants with
 *                                     HST reminders on
 *   "2 receipt pictures need a total" receipts texted in that are waiting to be finished
 * Each item is one short line. Empty when the Tax Clerk is off for the company. Never throws.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db } from "./db-types";
import { daysBetween, money, worksheetFor } from "./hst";
import { periodToRemind } from "./reminders";
import { needsTotal } from "./receipts";
import { hstRemindersOn, loadTaxClerkCompany } from "./settings";

export async function briefingItems(admin: AdminClient, scope: { organizationId: string; companyId: string }, localDate: string): Promise<string[]> {
  try {
    const company = await loadTaxClerkCompany(admin, scope.organizationId, scope.companyId);
    if (!company) return [];
    const items: string[] = [];
    if (hstRemindersOn(company.settings)) {
      const period = periodToRemind(localDate, company);
      if (period) {
        const w = await worksheetFor(admin, company, period);
        const days = daysBetween(localDate, period.paymentDueDate);
        const when = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
        const amount = w.netCents > 0 ? ` (about ${money(w.netCents)})` : w.netCents < 0 ? ` (refund about ${money(-w.netCents)})` : "";
        items.push(`${period.label} HST due ${when}${amount}`);
      }
    }
    if (company.settings.receipts.enabled) {
      const { data } = await (admin as Db).from("receipt_texts").select("id, amount_cents, missing").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("status", "needs_review").limit(50);
      const waiting = (data ?? []) as Array<{ amount_cents: number | null; missing: string[] }>;
      const total = waiting.filter(needsTotal).length;
      const other = waiting.length - total;
      if (total) items.push(`${total} receipt picture${total === 1 ? " needs" : "s need"} a total`);
      if (other) items.push(`${other} texted receipt${other === 1 ? "" : "s"} to finish in Settings`);
    }
    return items;
  } catch (err) {
    console.error("[tax-clerk] briefing items failed:", err instanceof Error ? err.message : err);
    return [];
  }
}
