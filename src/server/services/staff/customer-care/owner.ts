/**
 * Owner texts from Customer care (the platform number, to the verified owner cell): 08:00–21:00
 * local only, inside the per-company owner-alert budget (ownerAlertGate). Never throws.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { OWNER_ALERTS_SUMMARY, ownerAlertGate, sendOwnerSms } from "@/server/services/owner-channel/common";
import type { CareCompany } from "./settings";
import { inOwnerWindow } from "./time";

export type OwnerTextOutcome = "sent" | "held" | "no_phone" | "failed" | "blocked";

export async function textOwner(admin: AdminClient, company: CareCompany, body: string, nowMs: number, options: { anyTime?: boolean } = {}): Promise<OwnerTextOutcome> {
  try {
    if (!company.ownerPhone) return "no_phone";
    if (!options.anyTime && !inOwnerWindow(nowMs, company.timeZone)) return "held";
    const gate = await ownerAlertGate(admin, company.companyId);
    if (gate !== "send") {
      if (gate === "summary") {
        await sendOwnerSms(admin, { to: company.ownerPhone, body: OWNER_ALERTS_SUMMARY, organizationId: company.organizationId, companyId: company.companyId, platformBrand: company.platformBrand });
      }
      return "held";
    }
    const sent = await sendOwnerSms(admin, { to: company.ownerPhone, body, organizationId: company.organizationId, companyId: company.companyId, platformBrand: company.platformBrand });
    // "blocked": the owner opted out of platform texts (STOP) — retrying won't help; the app still works.
    return sent.status === "sent" ? "sent" : sent.status === "blocked" ? "blocked" : "failed";
  } catch (err) {
    console.error("[customer-care] owner text failed:", err instanceof Error ? err.message : err);
    return "failed";
  }
}
