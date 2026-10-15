/**
 * Service plans settings: companies.ai_settings.service_plans, read with defaults. The ONE typed
 * reader (docs/ai-staff.md → "Service plans").
 *
 *   service_plans = {
 *     enabled:   boolean,              // Done-for-you default on; house orgs are ALWAYS off
 *     heads_up:  { enabled: boolean }, // the text ~10 days before each plan visit
 *     renewals:  { enabled: boolean }, // the weekly renewal batch (plan_renewals)
 *   }
 *
 * The role only works for a company once it has an active plan (servicePlansActiveFor): until
 * the owner creates one, nothing is offered to the SMS agent or the owner agent.
 */
import { isDoneForYou } from "@/lib/product-line";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db } from "./db-types";

export const SETTINGS_KEY = "service_plans";
export const DEFAULT_TIMEZONE = "America/Toronto";
/** The heads-up goes this many days before a plan visit. */
export const HEADS_UP_DAYS = 10;
/** Renewals are asked about this many days before the term ends. */
export const RENEWAL_WINDOW_DAYS = 30;
/** A renewal not paid this many days after the term ended lapses. */
export const LAPSE_GRACE_DAYS = 14;
/** A sign-up whose payment never came is closed after this many days. */
export const PENDING_PAYMENT_DAYS = 3;

export interface ServicePlansSettings {
  enabled: boolean;
  headsUp: { enabled: boolean };
  renewals: { enabled: boolean };
  /** True for done-for-you orgs (the only ones the role may ever work for). */
  available: boolean;
}

export interface ServicePlansSettingsPatch {
  enabled?: boolean;
  headsUp?: { enabled?: boolean };
  renewals?: { enabled?: boolean };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

/** companies.ai_settings (any shape) → the service-plans section with defaults. PURE. */
export function readServicePlansSettings(aiSettings: unknown, org: { doneForYou: boolean }): ServicePlansSettings {
  const section = record(record(aiSettings)[SETTINGS_KEY]);
  const available = org.doneForYou;
  return {
    // House orgs (A1 …) are always off, whatever is stored.
    enabled: available && (bool(section.enabled) ?? true),
    headsUp: { enabled: bool(record(section.heads_up).enabled) ?? true },
    renewals: { enabled: bool(record(section.renewals).enabled) ?? true },
    available,
  };
}

/** The new ai_settings with ONLY `service_plans` changed. PURE. */
export function mergeServicePlansSettings(aiSettings: unknown, patch: ServicePlansSettingsPatch): Record<string, unknown> {
  const all = { ...record(aiSettings) };
  const section = { ...record(all[SETTINGS_KEY]) };
  if (typeof patch.enabled === "boolean") section.enabled = patch.enabled;
  if (patch.headsUp && typeof patch.headsUp.enabled === "boolean") section.heads_up = { ...record(section.heads_up), enabled: patch.headsUp.enabled };
  if (patch.renewals && typeof patch.renewals.enabled === "boolean") section.renewals = { ...record(section.renewals), enabled: patch.renewals.enabled };
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

/** One company as Service plans sees it. */
export interface PlanCompany {
  organizationId: string;
  companyId: string;
  name: string;
  timeZone: string;
  doneForYou: boolean;
  platformBrand: string | null;
  /** The verified owner cell (owner texts), or null. */
  ownerPhone: string | null;
  /** Archived / paused companies are skipped by the sweeps. */
  active: boolean;
  settings: ServicePlansSettings;
}

const COMPANY_COLUMNS = "id, organization_id, name, brand_from_name, timezone, ai_settings, owner_phone_e164, owner_phone_verified_at, stage";

interface CompanyRow {
  id: string;
  organization_id: string;
  name: string;
  brand_from_name?: string | null;
  timezone: string | null;
  ai_settings: unknown;
  owner_phone_e164: string | null;
  owner_phone_verified_at: string | null;
  stage?: string | null;
}

export function toPlanCompany(row: CompanyRow, platformBrand: string | null): PlanCompany {
  const doneForYou = isDoneForYou(platformBrand);
  return {
    organizationId: row.organization_id,
    companyId: row.id,
    name: (row.brand_from_name?.trim() || row.name || "").trim() || "the business",
    timeZone: zoneOf(row.timezone),
    doneForYou,
    platformBrand,
    ownerPhone: row.owner_phone_verified_at && row.owner_phone_e164?.trim() ? row.owner_phone_e164.trim() : null,
    active: !row.stage || !["archived", "paused", "cancelled"].includes(row.stage),
    settings: readServicePlansSettings(row.ai_settings, { doneForYou }),
  };
}

/** One company (service role), scoped by org. Null → no such company in that org. */
export async function loadPlanCompany(admin: AdminClient, organizationId: string, companyId: string): Promise<PlanCompany | null> {
  const db = admin as Db;
  const { data, error } = await db.from("companies").select(COMPANY_COLUMNS).eq("organization_id", organizationId).eq("id", companyId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: org } = await db.from("organizations").select("platform_brand").eq("id", organizationId).maybeSingle();
  return toPlanCompany(data as CompanyRow, (record(org).platform_brand as string | null) ?? null);
}

/** Companies by id (the sweeps: only the companies that have agreements in play). */
export async function loadPlanCompanies(admin: AdminClient, companyIds: string[]): Promise<Map<string, PlanCompany>> {
  const db = admin as Db;
  const out = new Map<string, PlanCompany>();
  const ids = [...new Set(companyIds)];
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    const { data, error } = await db.from("companies").select(COMPANY_COLUMNS).in("id", part);
    if (error) throw error;
    const rows = (data ?? []) as CompanyRow[];
    const orgIds = [...new Set(rows.map((r) => r.organization_id))];
    const { data: orgs, error: orgError } = orgIds.length ? await db.from("organizations").select("id, platform_brand").in("id", orgIds) : { data: [], error: null };
    if (orgError) throw orgError;
    const brands = new Map(((orgs ?? []) as Array<{ id: string; platform_brand: string | null }>).map((o) => [o.id, o.platform_brand]));
    for (const r of rows) out.set(r.id, toPlanCompany(r, brands.get(r.organization_id) ?? null));
  }
  return out;
}

/** Does the company have at least one active plan? */
export async function hasActivePlan(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<boolean> {
  const { data, error } = await (admin as Db)
    .from("service_plans")
    .select("id")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("active", true)
    .limit(1);
  if (error) throw error;
  return ((data ?? []) as unknown[]).length > 0;
}

/**
 * Is Service plans working for this company? Done-for-you org, switched on, company active, and at
 * least one active plan. House orgs: never. Never throws (a failed read counts as off).
 */
export async function servicePlansActiveFor(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<boolean> {
  try {
    const company = await loadPlanCompany(admin, scope.organizationId, scope.companyId);
    if (!company || !company.doneForYou || !company.active || !company.settings.enabled) return false;
    return await hasActivePlan(admin, scope);
  } catch {
    return false;
  }
}
