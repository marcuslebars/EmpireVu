/**
 * Customer import settings: companies.ai_settings.import, read with defaults. The ONE typed reader
 * (docs/ai-staff.md → "Customer import").
 *
 *   enabled   the import page, the texted link and the owner tools. Default ON for CrankLeads
 *             orgs, OFF for house orgs (A1…) unless the owner turns it on.
 *
 * PURE apart from loadImportCompany / importerActiveFor.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db } from "./db-types";

export const SETTINGS_KEY = "import";

export interface ImportSettings {
  enabled: boolean;
  /** `enabled` came from the default (no explicit choice yet). */
  enabledIsDefault: boolean;
}

export interface ImportPatch {
  enabled?: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** companies.ai_settings (any shape) → the import section with defaults. PURE. */
export function readImportSettings(aiSettings: unknown, org: { crankleads: boolean }): ImportSettings {
  const s = record(record(aiSettings)[SETTINGS_KEY]);
  const explicit = typeof s.enabled === "boolean" ? s.enabled : null;
  return { enabled: explicit ?? org.crankleads, enabledIsDefault: explicit === null };
}

/** The new ai_settings with ONLY `import` changed. PURE. */
export function mergeImportSettings(aiSettings: unknown, patch: ImportPatch): Record<string, unknown> {
  const all = { ...record(aiSettings) };
  const section = { ...record(all[SETTINGS_KEY]) };
  if (typeof patch.enabled === "boolean") section.enabled = patch.enabled;
  all[SETTINGS_KEY] = section;
  return all;
}

export interface ImportCompany {
  organizationId: string;
  companyId: string;
  /** The name customers and the owner know (brand_from_name, else the company name). */
  name: string;
  timeZone: string;
  crankleads: boolean;
  platformBrand: string;
  /** The VERIFIED owner cell, else null (no owner texts). */
  ownerPhone: string | null;
  invoiceSettings: unknown;
  settings: ImportSettings;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** One company (service role). Null → no such company in that org. */
export async function loadImportCompany(admin: AdminClient, organizationId: string, companyId: string): Promise<ImportCompany | null> {
  const db = admin as Db;
  const { data } = await db
    .from("companies")
    .select("id, organization_id, name, brand_from_name, timezone, owner_phone_e164, owner_phone_verified_at, ai_settings, invoice_settings")
    .eq("organization_id", organizationId)
    .eq("id", companyId)
    .maybeSingle();
  if (!data) return null;
  const c = data as Record<string, unknown>;
  const { data: org } = await db.from("organizations").select("platform_brand").eq("id", organizationId).maybeSingle();
  const platformBrand = str(record(org).platform_brand) ?? "empirevu";
  const crankleads = platformBrand === "crankleads";
  return {
    organizationId,
    companyId,
    name: str(c.brand_from_name) ?? str(c.name) ?? "your business",
    timeZone: str(c.timezone) ?? "America/Toronto",
    crankleads,
    platformBrand,
    ownerPhone: str(c.owner_phone_e164) && c.owner_phone_verified_at ? str(c.owner_phone_e164) : null,
    invoiceSettings: c.invoice_settings ?? null,
    settings: readImportSettings(c.ai_settings, { crankleads }),
  };
}

/** True when the import is on for this company (gates the owner tools and notes). Never throws. */
export async function importerActiveFor(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<boolean> {
  try {
    return (await loadImportCompany(admin, scope.organizationId, scope.companyId))?.settings.enabled === true;
  } catch {
    return false;
  }
}
