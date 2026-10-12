/**
 * Lines for the Office manager's 07:00 briefing (integration wires this in; read-only, never
 * marks anything): documents expiring in the next 7 days or expired in the last 7, most urgent
 * first, and texted certificates still waiting for "whose is it?". Nothing when Compliance is off.
 *
 *   "Liability insurance expires in 7 days"
 *   "Mike's Electric WSIB clearance expired"
 *   "1 certificate waiting - text me whose it is"
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { ComplianceDocumentRow, Db } from "./db-types";
import { expiryLine, holderLabelFor } from "./documents";
import { firstName, loadCrew, loadSubs, subLabel } from "./holders";
import { addDays } from "./kinds";
import { loadComplianceCompany } from "./settings";

const MAX_ITEMS = 3;

export async function briefingItems(admin: AdminClient, scope: { organizationId: string; companyId: string }, localDate: string): Promise<string[]> {
  const company = await loadComplianceCompany(admin, scope);
  if (!company || !company.settings.enabled) return [];
  const { data, error } = await (admin as Db)
    .from("compliance_documents")
    .select("*")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .in("status", ["current", "expiring", "expired", "pending"])
    .limit(1000);
  if (error) throw error;
  const docs = (data ?? []) as ComplianceDocumentRow[];
  const from = addDays(localDate, -7);
  const to = addDays(localDate, 7);
  const soon = docs
    .filter((d) => d.status !== "pending" && d.holder_type && d.expires_on && d.expires_on >= from && d.expires_on <= to)
    .sort((a, b) => (a.expires_on ?? "").localeCompare(b.expires_on ?? ""));
  const items: string[] = [];
  if (soon.length) {
    const [crew, subs] = await Promise.all([loadCrew(admin, scope.organizationId), loadSubs(admin, scope)]);
    const crewNames = new Map(crew.map((m) => [m.profileId, firstName(m.name) || m.name]));
    const subNames = new Map(subs.map((s) => [s.id, subLabel(s)]));
    const activeSub = new Set(subs.filter((s) => s.active).map((s) => s.id));
    for (const d of soon) {
      if (d.holder_type === "subcontractor" && (!d.subcontractor_id || !activeSub.has(d.subcontractor_id))) continue;
      items.push(expiryLine(d, holderLabelFor(d, crewNames, subNames), localDate));
    }
  }
  const pending = docs.filter((d) => d.status === "pending").length;
  const shown = items.slice(0, pending ? MAX_ITEMS - 1 : MAX_ITEMS);
  if (items.length > shown.length) shown.push(`+${items.length - shown.length} more documents expiring - text "compliance"`);
  if (pending) shown.push(`${pending} certificate${pending === 1 ? "" : "s"} waiting - text me whose ${pending === 1 ? "it is" : "they are"}`);
  return shown.slice(0, MAX_ITEMS + 1);
}
