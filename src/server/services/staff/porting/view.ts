/**
 * Settings → AI front desk → Keep your number: the view and the owner/admin changes behind
 * /api/organizations/:org/companies/:company/ai-settings/porting. Nothing here returns the
 * account number or PIN.
 */
import { prettyPhone } from "@/lib/carrier-forwarding";
import { updateAiSettings } from "@/server/services/front-desk/ai-settings-write";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { portingKey } from "@/server/services/staff/porting/crypto";
import { BUSINESS_LINE_MODE, type Db } from "@/server/services/staff/porting/db-types";
import { cancelPort, loadLatestPort, normalizePortNumber, portSummary, startPort, type PortSummary, type Scope } from "@/server/services/staff/porting/service";
import { loadPortingCompany, mergePortingSettings, type PortingSettingsPatch, type RingSettings } from "@/server/services/staff/porting/settings";
import { OWNER_CANCELLABLE } from "@/server/services/staff/porting/status";

export interface PortingSettingsView {
  companyId: string;
  enabled: boolean;
  enabledIsDefault: boolean;
  defaultEnabled: boolean;
  ring: RingSettings;
  ownerPhone: string | null;
  ownerPhoneVerified: boolean;
  businessLine: string | null;
  businessLineIsCell: boolean;
  /** The account number and PIN can be collected in the form (PORTING_ENCRYPTION_KEY is set). */
  collectsAccountDetails: boolean;
  port: (PortSummary & { ownerCanCancel: boolean }) | null;
  /** Ported numbers now ringing through us. */
  portedLines: string[];
  crewWithCells: number;
}

export async function getPortingView(admin: AdminClient, scope: Scope): Promise<PortingSettingsView | null> {
  const company = await loadPortingCompany(admin, scope);
  if (!company) return null;
  const db = admin as Db;
  const port = await loadLatestPort(admin, scope);
  const { data: lines } = await db
    .from("voice_numbers")
    .select("phone_e164")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("mode", BUSINESS_LINE_MODE)
    .eq("active", true);
  const { data: members } = await db.from("organization_memberships").select("phone_e164").eq("organization_id", scope.organizationId);
  const businessLine = normalizePortNumber(company.businessLine);
  return {
    companyId: scope.companyId,
    enabled: company.settings.enabled,
    enabledIsDefault: company.settings.enabledIsDefault,
    defaultEnabled: company.settings.defaultEnabled,
    ring: company.settings.ring,
    ownerPhone: company.ownerPhone ? prettyPhone(company.ownerPhone) : null,
    ownerPhoneVerified: company.ownerPhoneVerified,
    businessLine: businessLine ? prettyPhone(businessLine) : null,
    businessLineIsCell: company.businessPhoneKind === "cell",
    collectsAccountDetails: portingKey() !== null,
    port: port ? { ...portSummary(port, company.platformBrand), ownerCanCancel: OWNER_CANCELLABLE.includes(port.status) } : null,
    portedLines: ((lines ?? []) as Array<{ phone_e164: string }>).map((l) => prettyPhone(l.phone_e164)),
    crewWithCells: ((members ?? []) as Array<{ phone_e164: string | null }>).filter((m) => Boolean(m.phone_e164)).length,
  };
}

export async function updatePortingSettings(admin: AdminClient, scope: Scope, patch: PortingSettingsPatch): Promise<PortingSettingsView | null> {
  const written = await updateAiSettings(admin, scope, (current) => mergePortingSettings(current, patch));
  if (!written) return null;
  return getPortingView(admin, scope);
}

export async function startPortFromSettings(admin: AdminClient, scope: Scope, number: string | null): Promise<{ view: PortingSettingsView | null; url: string; texted: boolean }> {
  const result = await startPort(admin, scope, { createdVia: "settings", number });
  return { view: await getPortingView(admin, scope), url: result.url, texted: result.texted };
}

export async function cancelPortFromSettings(admin: AdminClient, scope: Scope, portId: string): Promise<PortingSettingsView | null> {
  await cancelPort(admin, scope, portId, { by: "owner" });
  return getPortingView(admin, scope);
}
