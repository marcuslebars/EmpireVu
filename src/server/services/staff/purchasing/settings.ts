/**
 * The Purchasing settings: companies.ai_settings.purchasing, read with defaults. The ONE typed
 * reader (docs/ai-staff.md → "Purchasing").
 *
 *   purchasing = {
 *     enabled,                       // Done-for-you on, house orgs (A1 …) off unless switched on
 *     lead_days: 2,                  // 1–14: draft only for jobs at least this many days out
 *     max_per_day: 3,                // 1–20: materials_order questions per company per local day
 *     default_fulfilment: "pickup",  // or "delivery"
 *     ai_estimate: true,             // no recipe → an AI estimate from the quote (marked "estimate")
 *     any_on                         // marker for the sweeps' server-side filter (house orgs that opted in)
 *   }
 */
import { isDoneForYou, PRODUCT_LINE_DB_VALUES } from "@/lib/product-line";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db, Fulfilment } from "./db-types";

export const SETTINGS_KEY = "purchasing";
export const DEFAULT_TIMEZONE = "America/Toronto";
export const DEFAULT_LEAD_DAYS = 2;
export const DEFAULT_MAX_PER_DAY = 3;
/** Jobs further out than this aren't drafted yet (prices and plans change). */
export const HORIZON_DAYS = 14;

export interface PurchasingSettings {
  enabled: boolean;
  leadDays: number;
  maxPerDay: number;
  defaultFulfilment: Fulfilment;
  aiEstimate: boolean;
  /** The org's default for the switch (done-for-you → on). */
  defaultEnabled: boolean;
  enabledIsDefault: boolean;
}

export interface PurchasingSettingsPatch {
  enabled?: boolean;
  leadDays?: number;
  maxPerDay?: number;
  defaultFulfilment?: Fulfilment;
  aiEstimate?: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const intIn = (value: unknown, min: number, max: number): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;

/** companies.ai_settings (any shape) → the Purchasing section with defaults. PURE. */
export function readPurchasingSettings(aiSettings: unknown, org: { doneForYou: boolean }): PurchasingSettings {
  const s = record(record(aiSettings)[SETTINGS_KEY]);
  const enabled = typeof s.enabled === "boolean" ? s.enabled : null;
  return {
    enabled: enabled ?? org.doneForYou,
    leadDays: intIn(s.lead_days, 1, 14) ?? DEFAULT_LEAD_DAYS,
    maxPerDay: intIn(s.max_per_day, 1, 20) ?? DEFAULT_MAX_PER_DAY,
    defaultFulfilment: s.default_fulfilment === "delivery" ? "delivery" : "pickup",
    aiEstimate: typeof s.ai_estimate === "boolean" ? s.ai_estimate : true,
    defaultEnabled: org.doneForYou,
    enabledIsDefault: enabled === null,
  };
}

/** The new ai_settings with ONLY `purchasing` changed. PURE. */
export function mergePurchasingSettings(aiSettings: unknown, patch: PurchasingSettingsPatch): Record<string, unknown> {
  const all = { ...record(aiSettings) };
  const section = { ...record(all[SETTINGS_KEY]) };
  if (typeof patch.enabled === "boolean") section.enabled = patch.enabled;
  if (intIn(patch.leadDays, 1, 14) != null) section.lead_days = patch.leadDays;
  if (intIn(patch.maxPerDay, 1, 20) != null) section.max_per_day = patch.maxPerDay;
  if (patch.defaultFulfilment === "pickup" || patch.defaultFulfilment === "delivery") section.default_fulfilment = patch.defaultFulfilment;
  if (typeof patch.aiEstimate === "boolean") section.ai_estimate = patch.aiEstimate;
  section.any_on = section.enabled === true;
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

/** One company as Purchasing sees it. */
export interface PurchasingCompany {
  organizationId: string;
  companyId: string;
  name: string;
  timeZone: string;
  doneForYou: boolean;
  platformBrand: string | null;
  /** Verified owner cell (approvals + reminders go here), else null. */
  ownerPhone: string | null;
  ownerEmail: string | null;
  industryPack: unknown;
  serviceArea: string | null;
  active: boolean;
  settings: PurchasingSettings;
}

const COMPANY_COLUMNS = "id, organization_id, name, brand_from_name, timezone, ai_settings, owner_phone_e164, owner_phone_verified_at, owner_email, industry_pack, service_area, stage";

interface CompanyRow {
  id: string;
  organization_id: string;
  name: string;
  brand_from_name?: string | null;
  timezone: string | null;
  ai_settings: unknown;
  owner_phone_e164: string | null;
  owner_phone_verified_at: string | null;
  owner_email?: string | null;
  industry_pack?: unknown;
  service_area?: string | null;
  stage?: string | null;
}

function toCompany(row: CompanyRow, platformBrand: string | null): PurchasingCompany {
  const doneForYou = isDoneForYou(platformBrand);
  return {
    organizationId: row.organization_id,
    companyId: row.id,
    name: (row.brand_from_name?.trim() || row.name || "").trim() || "the business",
    timeZone: zoneOf(row.timezone),
    doneForYou,
    platformBrand,
    ownerPhone: row.owner_phone_verified_at && row.owner_phone_e164?.trim() ? row.owner_phone_e164.trim() : null,
    ownerEmail: row.owner_email?.trim() || null,
    industryPack: row.industry_pack ?? null,
    serviceArea: typeof row.service_area === "string" ? row.service_area : null,
    active: !row.stage || !["archived", "paused", "cancelled"].includes(row.stage),
    settings: readPurchasingSettings(row.ai_settings, { doneForYou }),
  };
}

/** One company (service role), scoped by org. Null → no such company in that org. */
export async function loadPurchasingCompany(admin: AdminClient, organizationId: string, companyId: string): Promise<PurchasingCompany | null> {
  const db = admin as Db;
  const { data, error } = await db.from("companies").select(COMPANY_COLUMNS).eq("organization_id", organizationId).eq("id", companyId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: org } = await db.from("organizations").select("platform_brand").eq("id", organizationId).maybeSingle();
  return toCompany(data as CompanyRow, (record(org).platform_brand as string | null) ?? null);
}

/** Is Purchasing on for this company? (Gates its tools, prompt notes and briefing items.) Never throws. */
export async function purchasingActiveFor(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<boolean> {
  try {
    const company = await loadPurchasingCompany(admin, scope.organizationId, scope.companyId);
    return Boolean(company && company.active && company.settings.enabled);
  } catch {
    return false;
  }
}

const PAGE = 1000;

async function readAll<T>(make: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>, max = 20_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += PAGE) {
    const { data, error } = await make(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/**
 * Companies where Purchasing works: every company of a done-for-you org with it on, plus house-org
 * companies that switched it on (ai_settings.purchasing.any_on). House orgs are filtered out at
 * the query, so A1-style tenants never enter a sweep unless they opted in.
 */
export async function loadPurchasingCompanies(admin: AdminClient): Promise<PurchasingCompany[]> {
  const db = admin as Db;
  const orgs = await readAll<{ id: string; platform_brand: string | null }>((from, to) =>
    db.from("organizations").select("id, platform_brand").in("platform_brand", [...PRODUCT_LINE_DB_VALUES.done_for_you]).order("id", { ascending: true }).range(from, to),
  );
  const brands = new Map(orgs.map((o) => [o.id, o.platform_brand]));
  const rows = new Map<string, CompanyRow>();
  const ids = [...brands.keys()];
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    const page = await readAll<CompanyRow>((from, to) => db.from("companies").select(COMPANY_COLUMNS).in("organization_id", part).order("id", { ascending: true }).range(from, to));
    for (const r of page) rows.set(r.id, r);
  }
  const optedIn = await readAll<CompanyRow>((from, to) =>
    db.from("companies").select(COMPANY_COLUMNS).eq(`ai_settings->${SETTINGS_KEY}->>any_on`, "true").order("id", { ascending: true }).range(from, to),
  );
  const optedInOrgs = [...new Set(optedIn.map((r) => r.organization_id).filter((id) => !brands.has(id)))];
  for (let i = 0; i < optedInOrgs.length; i += 200) {
    const { data } = await db.from("organizations").select("id, platform_brand").in("id", optedInOrgs.slice(i, i + 200));
    for (const o of (data ?? []) as Array<{ id: string; platform_brand: string | null }>) brands.set(o.id, o.platform_brand);
  }
  for (const r of optedIn) rows.set(r.id, r);
  const out: PurchasingCompany[] = [];
  for (const r of rows.values()) {
    const company = toCompany(r, brands.get(r.organization_id) ?? null);
    if (company.active && company.settings.enabled) out.push(company);
  }
  return out;
}
