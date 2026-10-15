/**
 * The Profit advisor's settings: companies.ai_settings.profit_advisor, read with defaults. The ONE
 * typed reader (docs/ai-staff.md → "Profit advisor").
 *
 *   profit_advisor = {
 *     enabled,                               // Done-for-you on, house orgs (A1 …) off unless switched on
 *     weekly: { enabled, day: 5, time: "15:00" },   // the money text: local weekday (0 = Sun) + time
 *     pricing_check: { enabled },            // the monthly check (first Tuesday) + price_change asks
 *     tight_cushion_cents: 0,                // "tight" = money out runs ahead of money in by more than this
 *     any_on                                 // marker for the sweeps' server-side filter (house orgs that opted in)
 *   }
 */
import { isDoneForYou, PRODUCT_LINE_DB_VALUES } from "@/lib/product-line";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db } from "./db-types";

export const SETTINGS_KEY = "profit_advisor";
export const DEFAULT_TIMEZONE = "America/Toronto";
export const DEFAULT_WEEKLY_DAY = 5;
export const DEFAULT_WEEKLY_TIME = "15:00";
/** The weekly text goes from 07:00 to 19:30 (it's sent until 20:00 local). */
export const WEEKLY_TIMES: readonly string[] = Array.from({ length: 26 }, (_, i) => `${String(7 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);
export const MAX_CUSHION_CENTS = 10_000_000;

export interface ProfitAdvisorSettings {
  enabled: boolean;
  weekly: { enabled: boolean; day: number; time: string };
  pricingCheck: { enabled: boolean };
  /** "Tight" = the likely running total (money in minus money out from today) drops below −cushion. */
  tightCushionCents: number;
  /** The org's default for the switches (done-for-you → on). */
  defaultEnabled: boolean;
  enabledIsDefault: boolean;
}

export interface ProfitAdvisorPatch {
  enabled?: boolean;
  weekly?: { enabled?: boolean; day?: number; time?: string };
  pricingCheck?: { enabled?: boolean };
  tightCushionCents?: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const intIn = (value: unknown, min: number, max: number): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);
const timeOk = (value: unknown): value is string => typeof value === "string" && WEEKLY_TIMES.includes(value);

/** companies.ai_settings (any shape) → the Profit advisor section with defaults. PURE. */
export function readProfitAdvisorSettings(aiSettings: unknown, org: { doneForYou: boolean }): ProfitAdvisorSettings {
  const s = record(record(aiSettings)[SETTINGS_KEY]);
  const weekly = record(s.weekly);
  const pricing = record(s.pricing_check);
  const enabled = typeof s.enabled === "boolean" ? s.enabled : null;
  return {
    enabled: enabled ?? org.doneForYou,
    weekly: {
      enabled: bool(weekly.enabled, true),
      day: intIn(weekly.day, 0, 6) ?? DEFAULT_WEEKLY_DAY,
      time: timeOk(weekly.time) ? weekly.time : DEFAULT_WEEKLY_TIME,
    },
    pricingCheck: { enabled: bool(pricing.enabled, true) },
    tightCushionCents: intIn(s.tight_cushion_cents, 0, MAX_CUSHION_CENTS) ?? 0,
    defaultEnabled: org.doneForYou,
    enabledIsDefault: enabled === null,
  };
}

/** The new ai_settings with ONLY `profit_advisor` changed. PURE. */
export function mergeProfitAdvisorSettings(aiSettings: unknown, patch: ProfitAdvisorPatch): Record<string, unknown> {
  const all = { ...record(aiSettings) };
  const section = { ...record(all[SETTINGS_KEY]) };
  if (typeof patch.enabled === "boolean") section.enabled = patch.enabled;
  if (patch.weekly) {
    const weekly = { ...record(section.weekly) };
    if (typeof patch.weekly.enabled === "boolean") weekly.enabled = patch.weekly.enabled;
    if (intIn(patch.weekly.day, 0, 6) != null) weekly.day = patch.weekly.day;
    if (timeOk(patch.weekly.time)) weekly.time = patch.weekly.time;
    section.weekly = weekly;
  }
  if (patch.pricingCheck && typeof patch.pricingCheck.enabled === "boolean") section.pricing_check = { ...record(section.pricing_check), enabled: patch.pricingCheck.enabled };
  if (intIn(patch.tightCushionCents, 0, MAX_CUSHION_CENTS) != null) section.tight_cushion_cents = patch.tightCushionCents;
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

/** One company as the Profit advisor sees it. */
export interface ProfitCompany {
  organizationId: string;
  companyId: string;
  name: string;
  timeZone: string;
  doneForYou: boolean;
  platformBrand: string | null;
  /** Verified owner cell (the weekly text and the price questions go here), else null. */
  ownerPhone: string | null;
  active: boolean;
  settings: ProfitAdvisorSettings;
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

function toCompany(row: CompanyRow, platformBrand: string | null): ProfitCompany {
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
    settings: readProfitAdvisorSettings(row.ai_settings, { doneForYou }),
  };
}

/** One company (service role), scoped by org. Null → no such company in that org. */
export async function loadProfitCompany(admin: AdminClient, organizationId: string, companyId: string): Promise<ProfitCompany | null> {
  const db = admin as Db;
  const { data, error } = await db.from("companies").select(COMPANY_COLUMNS).eq("organization_id", organizationId).eq("id", companyId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: org } = await db.from("organizations").select("platform_brand").eq("id", organizationId).maybeSingle();
  return toCompany(data as CompanyRow, (record(org).platform_brand as string | null) ?? null);
}

/** Is the Profit advisor on for this company? (Gates its tools, prompt notes and briefing items.) Never throws. */
export async function profitAdvisorActiveFor(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<boolean> {
  try {
    const company = await loadProfitCompany(admin, scope.organizationId, scope.companyId);
    return Boolean(company && company.active && company.settings.enabled);
  } catch {
    return false;
  }
}

const PAGE = 1000;

export async function readAll<T>(make: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>, max = 20_000): Promise<T[]> {
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
 * Companies where the Profit advisor works: every company of a done-for-you org with it on, plus
 * house-org companies that switched it on (ai_settings.profit_advisor.any_on). House orgs are
 * filtered out at the query, so A1-style tenants never enter a sweep unless they opted in.
 */
export async function loadProfitCompanies(admin: AdminClient): Promise<ProfitCompany[]> {
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
  const out: ProfitCompany[] = [];
  for (const r of rows.values()) {
    const company = toCompany(r, brands.get(r.organization_id) ?? null);
    if (company.active && company.settings.enabled) out.push(company);
  }
  return out;
}
