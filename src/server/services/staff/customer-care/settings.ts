/**
 * Customer care settings: companies.ai_settings.customer_care, read with defaults. The ONE typed
 * reader (docs/ai-staff.md → "Customer care & warranty").
 *
 *   customer_care = {
 *     enabled,                       // Done-for-you on, house orgs (A1 …) off unless switched on
 *     checkins: {
 *       enabled: true,               // one "how did it go?" text after each completed job
 *       time: "10:00",               // local send time, 09:00–19:00
 *       delay_days: 1,               // days after the job (1–7)
 *       min_job_cents: 0,            // no check-in for jobs worth less than this
 *     },
 *     warranty: { months: 12, terms: "" },   // the default workmanship warranty (0 = none)
 *     any_on                         // marker for the sweeps' server-side filter (house orgs that opted in)
 *   }
 *
 * The role only works where the SMS agent is on too (replies to check-ins and visit offers come
 * back through it): careActiveFor = enabled + SMS agent active + company active.
 */
import { isDoneForYou, PRODUCT_LINE_DB_VALUES } from "@/lib/product-line";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { readSmsAgentSettings, smsAgentActive } from "@/server/services/sms-agent/settings";
import type { Db } from "./db-types";

export const SETTINGS_KEY = "customer_care";
export const DEFAULT_TIMEZONE = "America/Toronto";
export const DEFAULT_CHECKIN_TIME = "10:00";
export const DEFAULT_WARRANTY_MONTHS = 12;
export const MAX_WARRANTY_MONTHS = 600;

export interface CustomerCareSettings {
  enabled: boolean;
  checkins: { enabled: boolean; time: string; delayDays: number; minJobCents: number };
  warranty: { months: number; terms: string | null };
  /** The org's default for the switch (done-for-you → on). */
  defaultEnabled: boolean;
  enabledIsDefault: boolean;
}

export interface CustomerCareSettingsPatch {
  enabled?: boolean;
  checkins?: { enabled?: boolean; time?: string; delayDays?: number; minJobCents?: number };
  warranty?: { months?: number; terms?: string | null };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const intIn = (value: unknown, min: number, max: number): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;

/** "HH:MM" between 09:00 and 19:00 (check-ins go inside texting hours), else null. PURE. */
export function checkinTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h < 9 || h > 19 || (h === 19 && min > 0)) return null;
  return `${m[1]}:${m[2]}`;
}

function termsText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 500) : null;
}

/** companies.ai_settings (any shape) → the Customer care section with defaults. PURE. */
export function readCustomerCareSettings(aiSettings: unknown, org: { doneForYou: boolean }): CustomerCareSettings {
  const s = record(record(aiSettings)[SETTINGS_KEY]);
  const c = record(s.checkins);
  const w = record(s.warranty);
  const enabled = typeof s.enabled === "boolean" ? s.enabled : null;
  return {
    enabled: enabled ?? org.doneForYou,
    checkins: {
      enabled: typeof c.enabled === "boolean" ? c.enabled : true,
      time: checkinTime(c.time) ?? DEFAULT_CHECKIN_TIME,
      delayDays: intIn(c.delay_days, 1, 7) ?? 1,
      minJobCents: intIn(c.min_job_cents, 0, 100_000_000) ?? 0,
    },
    warranty: {
      months: intIn(w.months, 0, MAX_WARRANTY_MONTHS) ?? DEFAULT_WARRANTY_MONTHS,
      terms: termsText(w.terms),
    },
    defaultEnabled: org.doneForYou,
    enabledIsDefault: enabled === null,
  };
}

/** The new ai_settings with ONLY `customer_care` changed. PURE. */
export function mergeCustomerCareSettings(aiSettings: unknown, patch: CustomerCareSettingsPatch): Record<string, unknown> {
  const all = { ...record(aiSettings) };
  const section = { ...record(all[SETTINGS_KEY]) };
  if (typeof patch.enabled === "boolean") section.enabled = patch.enabled;
  if (patch.checkins) {
    const c = { ...record(section.checkins) };
    if (typeof patch.checkins.enabled === "boolean") c.enabled = patch.checkins.enabled;
    if (checkinTime(patch.checkins.time)) c.time = checkinTime(patch.checkins.time);
    if (intIn(patch.checkins.delayDays, 1, 7) != null) c.delay_days = patch.checkins.delayDays;
    if (intIn(patch.checkins.minJobCents, 0, 100_000_000) != null) c.min_job_cents = patch.checkins.minJobCents;
    section.checkins = c;
  }
  if (patch.warranty) {
    const w = { ...record(section.warranty) };
    if (intIn(patch.warranty.months, 0, MAX_WARRANTY_MONTHS) != null) w.months = patch.warranty.months;
    if (patch.warranty.terms !== undefined) w.terms = termsText(patch.warranty.terms);
    section.warranty = w;
  }
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

/** One company as Customer care sees it. */
export interface CareCompany {
  organizationId: string;
  companyId: string;
  name: string;
  timeZone: string;
  doneForYou: boolean;
  platformBrand: string | null;
  /** Verified owner cell (alerts + approvals), else null. */
  ownerPhone: string | null;
  active: boolean;
  /** The SMS agent answers this company's customers (check-in replies come back through it). */
  smsAgentOn: boolean;
  settings: CustomerCareSettings;
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

export function toCareCompany(row: CompanyRow, platformBrand: string | null): CareCompany {
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
    smsAgentOn: smsAgentActive(readSmsAgentSettings(row.ai_settings, { doneForYou })),
    settings: readCustomerCareSettings(row.ai_settings, { doneForYou }),
  };
}

/** Is the role working for this company? (enabled, SMS agent on, company active.) PURE. */
export function careWorks(company: CareCompany): boolean {
  return company.active && company.settings.enabled && company.smsAgentOn;
}

/** One company (service role), scoped by org. Null → no such company in that org. */
export async function loadCareCompany(admin: AdminClient, organizationId: string, companyId: string): Promise<CareCompany | null> {
  const db = admin as Db;
  const { data, error } = await db.from("companies").select(COMPANY_COLUMNS).eq("organization_id", organizationId).eq("id", companyId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: org } = await db.from("organizations").select("platform_brand").eq("id", organizationId).maybeSingle();
  return toCareCompany(data as CompanyRow, (record(org).platform_brand as string | null) ?? null);
}

/** Is Customer care on for this company? (Gates its tools, prompt notes and briefing items.) Never throws. */
export async function careActiveFor(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<boolean> {
  try {
    const company = await loadCareCompany(admin, scope.organizationId, scope.companyId);
    return Boolean(company && careWorks(company));
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
 * Companies where Customer care works: every company of a done-for-you org with it on, plus
 * house-org companies that switched it on (ai_settings.customer_care.any_on). House orgs are
 * filtered out at the query, so A1-style tenants never enter a sweep unless they opted in.
 */
export async function loadCareCompanies(admin: AdminClient): Promise<CareCompany[]> {
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
  const out: CareCompany[] = [];
  for (const r of rows.values()) {
    const company = toCareCompany(r, brands.get(r.organization_id) ?? null);
    if (careWorks(company)) out.push(company);
  }
  return out;
}
