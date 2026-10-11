/**
 * Settings → AI front desk → Dispatcher: what the panel shows, and the owner's change (merged
 * into companies.ai_settings.dispatch only — other sections untouched, optimistic write).
 * The route checks membership / role and that the company is in the org; reads here are pinned
 * to that org + company.
 */
import { updateAiSettings } from "@/server/services/front-desk/ai-settings-write";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { placesApiKey } from "@/server/services/dfy/places";
import { loadDispatchCompany } from "./company";
import type { Db } from "./db-types";
import { enRouteAutomationActive } from "./on-our-way";
import { defaultWeatherSensitivity, mergeDispatchSettings, type DispatchSettings, type DispatchSettingsPatch } from "./settings";

export interface DispatchSettingsView {
  companyId: string;
  companyName: string;
  settings: DispatchSettings;
  /** What "use the default" means for this trade. */
  tradeDefaultSensitivity: "all" | "none";
  services: Array<{ key: string; label: string }>;
  location: { known: boolean; source: string | null; canLookUp: boolean };
  crew: { members: number; withPhone: number };
  /** The company's own "On my way" automation is on — it texts, so the Dispatcher stays quiet. */
  onOurWayAutomationActive: boolean;
  last30d: { onOurWay: number; crewTexts: number; jobsMoved: number; gapOffers: number };
}

export async function getDispatchSettingsView(admin: AdminClient, organizationId: string, companyId: string, nowMs = Date.now()): Promise<DispatchSettingsView> {
  const company = await loadDispatchCompany(admin, organizationId, companyId);
  if (!company) throw new Error("Company not found.");
  const db = admin as Db;
  const [{ data: row }, { data: items }, { data: members }, { data: recent }] = await Promise.all([
    db.from("companies").select("name, industry_pack, location_source").eq("organization_id", organizationId).eq("id", companyId).maybeSingle(),
    db.from("service_catalog_items").select("service_key, label, active").eq("organization_id", organizationId).eq("company_id", companyId).limit(200),
    db.from("organization_memberships").select("profile_id, phone_e164").eq("organization_id", organizationId).limit(500),
    db
      .from("dispatch_messages")
      .select("kind, status")
      .eq("organization_id", organizationId)
      .eq("company_id", companyId)
      .eq("status", "sent")
      .gte("created_at", new Date(nowMs - 30 * 86_400_000).toISOString())
      .limit(5000),
  ]);
  const r = row as { name: string; industry_pack: unknown; location_source: string | null } | null;
  const sent = (recent ?? []) as Array<{ kind: string }>;
  const count = (...kinds: string[]) => sent.filter((m) => kinds.includes(m.kind)).length;
  const memberRows = (members ?? []) as Array<{ phone_e164: string | null }>;
  return {
    companyId,
    companyName: company.businessName,
    settings: company.settings,
    tradeDefaultSensitivity: defaultWeatherSensitivity({ industryPack: r?.industry_pack ?? null, hints: [r?.name ?? company.businessName] }),
    services: ((items ?? []) as Array<{ service_key: string; label: string; active: boolean }>).filter((i) => i.active !== false).map((i) => ({ key: i.service_key, label: i.label })),
    location: { known: company.latitude !== null && company.longitude !== null, source: r?.location_source ?? null, canLookUp: Boolean(placesApiKey()) },
    crew: { members: memberRows.length, withPhone: memberRows.filter((m) => Boolean(m.phone_e164)).length },
    onOurWayAutomationActive: await enRouteAutomationActive(admin, company),
    last30d: { onOurWay: count("on_our_way"), crewTexts: count("crew_schedule", "crew_update"), jobsMoved: count("job_moved"), gapOffers: count("gap_offer") },
  };
}

/** Write with the service role (ai_settings isn't client-writable); the caller checked the role + company. */
export async function updateDispatchSettings(admin: AdminClient, organizationId: string, companyId: string, patch: DispatchSettingsPatch): Promise<void> {
  const written = await updateAiSettings(admin, { organizationId, companyId }, (current) => mergeDispatchSettings(current, patch));
  if (!written) throw new Error("Company not found.");
}
