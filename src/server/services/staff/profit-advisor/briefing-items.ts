/**
 * Lines for the Office manager's 07:00 briefing (docs/ai-staff.md → "Profit advisor"): ONLY when
 * the cash forecast looks tight in the next 30 days, e.g. "Cash looks tight around Nov 6 (about
 * $2,400 short)". [] when the Profit advisor is off for the company (house orgs), when cash looks
 * fine, or when anything fails. Read-only; never throws.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { zonedInstant } from "@/server/services/booking-windows";
import { forecastFor } from "./forecast-data";
import { loadProfitCompany } from "./settings";
import { tightLine } from "./texts";

export async function briefingItems(admin: AdminClient, scope: { organizationId: string; companyId: string }, localDateKey: string): Promise<string[]> {
  try {
    const company = await loadProfitCompany(admin, scope.organizationId, scope.companyId);
    if (!company || !company.active || !company.settings.enabled) return [];
    // As of 07:00 on the briefing's day (the forecast starts that day).
    const nowMs = zonedInstant(localDateKey, "07:00", company.timeZone).getTime();
    const forecast = await forecastFor(admin, company, nowMs);
    const line = forecast ? tightLine(forecast, Number(localDateKey.slice(0, 4))) : null;
    return line ? [line] : [];
  } catch (err) {
    console.error("[profit-advisor] briefing items failed:", err instanceof Error ? err.message : err);
    return [];
  }
}
