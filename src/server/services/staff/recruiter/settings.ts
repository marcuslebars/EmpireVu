/**
 * The Recruiter's settings: companies.ai_settings.recruiter, read with defaults. The ONE typed
 * reader (docs/ai-staff.md → "Hiring & payroll").
 *
 *   recruiter = {
 *     payroll: { enabled, frequency: "weekly" | "biweekly" | "semimonthly",
 *                anchor_date: "YYYY-MM-DD", csv_email: string | null },
 *     hiring:  { enabled },
 *     any_on:  boolean   // marker for the sweeps' server-side filter (house orgs that opted in)
 *   }
 *
 * Both switches default ON for done-for-you orgs and OFF for house orgs (A1 …) unless turned on.
 * The anchor is the first day of any one pay period (weekly / bi-weekly); semi-monthly periods
 * are always the 1st–15th and 16th–end of month. The CSV goes to `csv_email`, else the org
 * owner's email.
 */
import { isDoneForYou, PRODUCT_LINE_DB_VALUES } from "@/lib/product-line";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db, PayFrequency } from "./db-types";

export const SETTINGS_KEY = "recruiter";
export const PAY_FREQUENCIES: readonly PayFrequency[] = ["weekly", "biweekly", "semimonthly"];
export const DEFAULT_FREQUENCY: PayFrequency = "biweekly";
/** A Monday: weekly / bi-weekly periods run Monday–Sunday unless the owner picks another anchor. */
export const DEFAULT_ANCHOR = "2026-01-05";
export const DEFAULT_TIMEZONE = "America/Toronto";

export interface RecruiterSettings {
  payroll: {
    enabled: boolean;
    frequency: PayFrequency;
    anchorDate: string;
    /** Where the CSV goes; null → the org owner's email. */
    csvEmail: string | null;
  };
  hiring: { enabled: boolean };
  /** The org's default for every switch (done-for-you → on). */
  defaultEnabled: boolean;
}

export interface RecruiterSettingsPatch {
  payroll?: { enabled?: boolean; frequency?: PayFrequency; anchorDate?: string; csvEmail?: string | null };
  hiring?: { enabled?: boolean };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;

/** A real calendar date "YYYY-MM-DD" between 2000 and 2100. PURE. */
export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && y <= 2100 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function isEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && EMAIL_RE.test(value.trim());
}

const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

/** companies.ai_settings (any shape) → the Recruiter section with defaults. PURE. */
export function readRecruiterSettings(aiSettings: unknown, org: { doneForYou: boolean }): RecruiterSettings {
  const section = record(record(aiSettings)[SETTINGS_KEY]);
  const payroll = record(section.payroll);
  const hiring = record(section.hiring);
  const on = org.doneForYou;
  const frequency = PAY_FREQUENCIES.includes(payroll.frequency as PayFrequency) ? (payroll.frequency as PayFrequency) : DEFAULT_FREQUENCY;
  return {
    payroll: {
      enabled: bool(payroll.enabled) ?? on,
      frequency,
      anchorDate: isDateKey(payroll.anchor_date) ? payroll.anchor_date : DEFAULT_ANCHOR,
      csvEmail: isEmail(payroll.csv_email) ? payroll.csv_email.trim().toLowerCase() : null,
    },
    hiring: { enabled: bool(hiring.enabled) ?? on },
    defaultEnabled: on,
  };
}

/** The new ai_settings with ONLY `recruiter` changed. PURE. */
export function mergeRecruiterSettings(aiSettings: unknown, patch: RecruiterSettingsPatch): Record<string, unknown> {
  const all = { ...record(aiSettings) };
  const section = { ...record(all[SETTINGS_KEY]) };
  if (patch.payroll) {
    const p = { ...record(section.payroll) };
    if (typeof patch.payroll.enabled === "boolean") p.enabled = patch.payroll.enabled;
    if (patch.payroll.frequency && PAY_FREQUENCIES.includes(patch.payroll.frequency)) p.frequency = patch.payroll.frequency;
    if (isDateKey(patch.payroll.anchorDate)) p.anchor_date = patch.payroll.anchorDate;
    if (patch.payroll.csvEmail === null || patch.payroll.csvEmail === "") delete p.csv_email;
    else if (isEmail(patch.payroll.csvEmail)) p.csv_email = patch.payroll.csvEmail.trim().toLowerCase();
    section.payroll = p;
  }
  if (patch.hiring && typeof patch.hiring.enabled === "boolean") section.hiring = { ...record(section.hiring), enabled: patch.hiring.enabled };
  section.any_on = record(section.payroll).enabled === true || record(section.hiring).enabled === true;
  all[SETTINGS_KEY] = section;
  return all;
}

/** organizations row → done-for-you? PURE. */
export function isDoneForYouOrg(org: unknown): boolean {
  return isDoneForYou(record(org).platform_brand);
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

/** One company as the Recruiter sees it. */
export interface RecruiterCompany {
  organizationId: string;
  companyId: string;
  name: string;
  timeZone: string;
  doneForYou: boolean;
  platformBrand: string | null;
  ownerPhone: string | null;
  /** Archived / paused companies are skipped by the sweeps. */
  active: boolean;
  settings: RecruiterSettings;
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

function toCompany(row: CompanyRow, platformBrand: string | null): RecruiterCompany {
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
    settings: readRecruiterSettings(row.ai_settings, { doneForYou }),
  };
}

/** One company (service role), scoped by org. Null → no such company in that org. */
export async function loadRecruiterCompany(admin: AdminClient, organizationId: string, companyId: string): Promise<RecruiterCompany | null> {
  const db = admin as Db;
  const { data } = await db.from("companies").select(COMPANY_COLUMNS).eq("organization_id", organizationId).eq("id", companyId).maybeSingle();
  if (!data) return null;
  const { data: org } = await db.from("organizations").select("platform_brand").eq("id", organizationId).maybeSingle();
  return toCompany(data as CompanyRow, (record(org).platform_brand as string | null) ?? null);
}

/** Is any Recruiter feature on for this company? (Gates its tools and prompt notes.) Never throws. */
export async function recruiterActiveFor(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<boolean> {
  try {
    const company = await loadRecruiterCompany(admin, scope.organizationId, scope.companyId);
    return Boolean(company && (company.settings.payroll.enabled || company.settings.hiring.enabled));
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
 * Companies where the Recruiter may work: every company of a done-for-you org, plus house-org
 * companies that switched something on (ai_settings.recruiter.any_on). House orgs are filtered
 * out at the query, so A1-style tenants never enter a sweep unless they opted in.
 */
export async function loadRecruiterCompanies(admin: AdminClient): Promise<RecruiterCompany[]> {
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
  for (const r of optedIn) rows.set(r.id, r);
  const out: RecruiterCompany[] = [];
  for (const r of rows.values()) {
    const company = toCompany(r, brands.get(r.organization_id) ?? null);
    if (company.active && (company.settings.payroll.enabled || company.settings.hiring.enabled)) out.push(company);
  }
  return out;
}
