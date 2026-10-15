/**
 * Fleet settings: companies.ai_settings.fleet, read with defaults (docs/ai-staff.md → "Fleet &
 * equipment"). The ONE typed reader; the route merges owner changes into this key only.
 *
 *   fleet = {
 *     enabled,    // the role: owner tools, prompt note, Settings, the odometer photo, the reminders
 *     reminders,  // the daily heads-up text (service, plate sticker, safety, equipment, rentals)
 *   }
 *
 * `enabled` defaults ON for done-for-you orgs (inert until a vehicle, machine or rental is added) and
 * OFF for house orgs (A1 etc.). `reminders` defaults on and only matters while `enabled`.
 */
import { isDoneForYou } from "@/lib/product-line";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db } from "./db-types";

export const SETTINGS_KEY = "fleet";
export const DEFAULT_TIMEZONE = "America/Toronto";

export interface FleetSettings {
  enabled: boolean;
  reminders: boolean;
  /** The org's default for the switch (done-for-you → on). */
  defaultEnabled: boolean;
  enabledIsDefault: boolean;
}

export interface FleetSettingsPatch {
  enabled?: boolean;
  reminders?: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** companies.ai_settings (any shape) → the Fleet section with defaults. PURE. */
export function readFleetSettings(aiSettings: unknown, org: { doneForYou: boolean }): FleetSettings {
  const s = record(record(aiSettings)[SETTINGS_KEY]);
  const enabled = typeof s.enabled === "boolean" ? s.enabled : null;
  return {
    enabled: enabled ?? org.doneForYou,
    reminders: typeof s.reminders === "boolean" ? s.reminders : true,
    defaultEnabled: org.doneForYou,
    enabledIsDefault: enabled === null,
  };
}

/** The whole ai_settings with ONLY `fleet` changed (for updateAiSettings). PURE. */
export function mergeFleetSettings(aiSettings: unknown, patch: FleetSettingsPatch): Record<string, unknown> {
  const all = { ...record(aiSettings) };
  const section = { ...record(all[SETTINGS_KEY]) };
  if (typeof patch.enabled === "boolean") section.enabled = patch.enabled;
  if (typeof patch.reminders === "boolean") section.reminders = patch.reminders;
  all[SETTINGS_KEY] = section;
  return all;
}

export function zoneOf(timeZone: string | null | undefined): string {
  const tz = timeZone?.trim();
  if (!tz) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** One company as Fleet sees it. */
export interface FleetCompany {
  organizationId: string;
  companyId: string;
  name: string;
  timeZone: string;
  platformBrand: string | null;
  /** Verified owner cell (the reminders go here), else null. */
  ownerPhone: string | null;
  active: boolean;
  settings: FleetSettings;
}

const COMPANY_COLUMNS = "id, organization_id, name, brand_from_name, timezone, ai_settings, owner_phone_e164, owner_phone_verified_at, stage";

interface CompanyRow {
  id: string;
  organization_id: string;
  name: string | null;
  brand_from_name?: string | null;
  timezone: string | null;
  ai_settings: unknown;
  owner_phone_e164: string | null;
  owner_phone_verified_at: string | null;
  stage?: string | null;
}

function toCompany(row: CompanyRow, platformBrand: string | null): FleetCompany {
  return {
    organizationId: row.organization_id,
    companyId: row.id,
    name: (row.brand_from_name?.trim() || row.name?.trim() || "").trim() || "the business",
    timeZone: zoneOf(row.timezone),
    platformBrand,
    ownerPhone: row.owner_phone_verified_at && row.owner_phone_e164?.trim() ? row.owner_phone_e164.trim() : null,
    active: !row.stage || !["archived", "paused", "cancelled"].includes(row.stage),
    settings: readFleetSettings(row.ai_settings, { doneForYou: isDoneForYou(platformBrand) }),
  };
}

/** One company (service role), scoped by org. Null → no such company in that org. */
export async function loadFleetCompany(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<FleetCompany | null> {
  const db = admin as Db;
  const { data, error } = await db.from("companies").select(COMPANY_COLUMNS).eq("organization_id", scope.organizationId).eq("id", scope.companyId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: org } = await db.from("organizations").select("platform_brand").eq("id", scope.organizationId).maybeSingle();
  return toCompany(data as CompanyRow, (record(org).platform_brand as string | null) ?? null);
}

/** Several companies by id (the sweep), each with its own org's brand. */
export async function loadFleetCompanies(admin: AdminClient, companyIds: string[]): Promise<FleetCompany[]> {
  if (companyIds.length === 0) return [];
  const db = admin as Db;
  const out: FleetCompany[] = [];
  for (let i = 0; i < companyIds.length; i += 200) {
    const { data, error } = await db.from("companies").select(COMPANY_COLUMNS).in("id", companyIds.slice(i, i + 200));
    if (error) throw error;
    const rows = (data ?? []) as CompanyRow[];
    const orgIds = [...new Set(rows.map((r) => r.organization_id))];
    const { data: orgs, error: orgError } = orgIds.length ? await db.from("organizations").select("id, platform_brand").in("id", orgIds) : { data: [], error: null };
    if (orgError) throw orgError;
    const brand = new Map(((orgs ?? []) as Array<{ id: string; platform_brand: string | null }>).map((o) => [o.id, o.platform_brand]));
    out.push(...rows.map((r) => toCompany(r, brand.get(r.organization_id) ?? null)));
  }
  return out;
}

/** Is Fleet on for this company (its tools, prompt note, photo intake, briefing items)? Never throws. */
export async function fleetActiveFor(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<boolean> {
  try {
    const company = await loadFleetCompany(admin, scope);
    return Boolean(company && company.active && company.settings.enabled);
  } catch {
    return false;
  }
}
