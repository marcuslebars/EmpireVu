/**
 * Compliance settings: companies.ai_settings.compliance, read with defaults (docs/ai-staff.md →
 * "Compliance"). One typed reader; the route merges owner changes into this key only.
 *
 *   compliance = {
 *     enabled,     // the role: texted-in certificates, owner tools, Settings, the expiry chase
 *     reminders,   // expiry texts at 30 / 7 / 0 days (and the request_sub_docs asks)
 *     sharing,     // the texting assistant may offer to send a certificate (owner approves each)
 *   }
 *
 * `enabled` defaults ON for CrankLeads orgs (passive until a document exists) and OFF for house
 * orgs (A1 etc.). `reminders` and `sharing` default on and only matter while `enabled`.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db } from "./db-types";

export interface ComplianceSettings {
  enabled: boolean;
  enabledIsDefault: boolean;
  defaultEnabled: boolean;
  reminders: boolean;
  sharing: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function readComplianceSettings(aiSettings: unknown, ctx: { crankleads: boolean }): ComplianceSettings {
  const section = asRecord(asRecord(aiSettings).compliance);
  return {
    enabled: bool(section.enabled, ctx.crankleads),
    enabledIsDefault: typeof section.enabled !== "boolean",
    defaultEnabled: ctx.crankleads,
    reminders: bool(section.reminders, true),
    sharing: bool(section.sharing, true),
  };
}

export interface ComplianceSettingsPatch {
  enabled?: boolean;
  reminders?: boolean;
  sharing?: boolean;
}

/** The whole ai_settings with ONLY `compliance` changed (for updateAiSettings). */
export function mergeComplianceSettings(aiSettings: unknown, patch: ComplianceSettingsPatch): Record<string, unknown> {
  const all = { ...asRecord(aiSettings) };
  const section = { ...asRecord(all.compliance) };
  for (const key of ["enabled", "reminders", "sharing"] as const) {
    if (typeof patch[key] === "boolean") section[key] = patch[key];
  }
  all.compliance = section;
  return all;
}

export interface ComplianceCompany {
  organizationId: string;
  companyId: string;
  /** The name customers and subs know (brand_from_name, else the company name). */
  name: string;
  timeZone: string;
  ownerPhone: string | null;
  ownerPhoneVerified: boolean;
  ownerEmail: string | null;
  platformBrand: string | null;
  active: boolean;
  settings: ComplianceSettings;
  aiSettings: unknown;
}

const COMPANY_COLUMNS = "id, organization_id, name, brand_from_name, timezone, owner_phone_e164, owner_phone_verified_at, owner_email, ai_settings, stage";

interface CompanyRow {
  id: string;
  organization_id: string;
  name: string | null;
  brand_from_name?: string | null;
  timezone: string | null;
  owner_phone_e164: string | null;
  owner_phone_verified_at: string | null;
  owner_email?: string | null;
  ai_settings: unknown;
  stage?: string | null;
}

function toCompany(row: CompanyRow, platformBrand: string | null): ComplianceCompany {
  return {
    organizationId: row.organization_id,
    companyId: row.id,
    name: (row.brand_from_name?.trim() || row.name?.trim() || "").trim() || "the business",
    timeZone: row.timezone || "America/Toronto",
    ownerPhone: row.owner_phone_e164,
    ownerPhoneVerified: Boolean(row.owner_phone_e164 && row.owner_phone_verified_at),
    ownerEmail: row.owner_email?.trim() || null,
    platformBrand,
    active: !row.stage || !["paused", "archived"].includes(row.stage),
    settings: readComplianceSettings(row.ai_settings, { crankleads: platformBrand === "crankleads" }),
    aiSettings: row.ai_settings,
  };
}

/** The company + its compliance settings, or null when it isn't this org's. */
export async function loadComplianceCompany(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<ComplianceCompany | null> {
  const db = admin as Db;
  const { data, error } = await db.from("companies").select(COMPANY_COLUMNS).eq("organization_id", scope.organizationId).eq("id", scope.companyId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: org } = await db.from("organizations").select("platform_brand").eq("id", scope.organizationId).maybeSingle();
  return toCompany(data as CompanyRow, (org as { platform_brand: string | null } | null)?.platform_brand ?? null);
}

/** Several companies by id (the sweeps), each with its own org's brand. */
export async function loadComplianceCompanies(admin: AdminClient, companyIds: string[]): Promise<ComplianceCompany[]> {
  if (companyIds.length === 0) return [];
  const db = admin as Db;
  const out: ComplianceCompany[] = [];
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

/** Is Compliance on for the company (its tools, prompt notes and the photo intake)? Never throws. */
export async function complianceActiveFor(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<boolean> {
  try {
    const company = await loadComplianceCompany(admin, scope);
    return Boolean(company && company.settings.enabled);
  } catch {
    return false;
  }
}
