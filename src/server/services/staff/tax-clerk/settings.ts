/**
 * The Tax Clerk's settings: companies.ai_settings.tax_clerk, read with defaults. The ONE typed
 * reader (docs/ai-staff.md → "Receipts & HST").
 *
 *   tax_clerk = {
 *     receipts: { enabled },                          // receipts by text
 *     hst: { registrant: boolean | null,              // null → registered when the HST # is set
 *            frequency: "monthly" | "quarterly" | "annual",
 *            fiscal_year_end_month: 1..12,           // the fiscal year ends on that month's last day
 *            filer: "individual" | "corporation",    // annual filers: who files (due dates differ)
 *            reminders: boolean,                     // the 10-day reminder + packet ask
 *            accountant_email: string | null },      // the packet goes here, else the owner
 *     nudges: { weekly, tip },                        // Monday receipt nudge, first-week tip
 *     any_on: boolean                                 // marker for the sweeps' house-org filter
 *   }
 *
 * Everything defaults ON for CrankLeads orgs and OFF for house orgs (A1 …) unless turned on.
 * HST reminders only run for a registrant (default: companies.tax_registration_number is set).
 * Defaults: quarterly, fiscal year ending Dec 31, corporation.
 */
import { isDoneForYou, PRODUCT_LINE_DB_VALUES } from "@/lib/product-line";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db, FilerType, HstFrequency } from "./db-types";

export const SETTINGS_KEY = "tax_clerk";
export const HST_FREQUENCIES: readonly HstFrequency[] = ["monthly", "quarterly", "annual"];
export const FILER_TYPES: readonly FilerType[] = ["individual", "corporation"];
export const DEFAULT_TIMEZONE = "America/Toronto";

export interface TaxClerkSettings {
  receipts: { enabled: boolean };
  hst: {
    /** As set (null → follow the HST number). */
    registrantSetting: boolean | null;
    /** What counts: the setting, else "has an HST number". */
    registrant: boolean;
    frequency: HstFrequency;
    fiscalYearEndMonth: number;
    filer: FilerType;
    reminders: boolean;
    accountantEmail: string | null;
  };
  nudges: { weekly: boolean; tip: boolean };
  /** The org's default for every switch (CrankLeads → on). */
  defaultEnabled: boolean;
}

export interface TaxClerkPatch {
  receipts?: { enabled?: boolean };
  hst?: {
    registrant?: boolean | null;
    frequency?: HstFrequency;
    fiscalYearEndMonth?: number;
    filer?: FilerType;
    reminders?: boolean;
    accountantEmail?: string | null;
  };
  nudges?: { weekly?: boolean; tip?: boolean };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;

export function isEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && EMAIL_RE.test(value.trim());
}

const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const month = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 12 ? value : null);

/** companies.ai_settings (any shape) → the Tax Clerk section with defaults. PURE. */
export function readTaxClerkSettings(aiSettings: unknown, org: { doneForYou: boolean; hasHstNumber: boolean }): TaxClerkSettings {
  const section = record(record(aiSettings)[SETTINGS_KEY]);
  const receipts = record(section.receipts);
  const hst = record(section.hst);
  const nudges = record(section.nudges);
  const on = org.doneForYou;
  const registrantSetting = bool(hst.registrant);
  return {
    receipts: { enabled: bool(receipts.enabled) ?? on },
    hst: {
      registrantSetting,
      registrant: registrantSetting ?? org.hasHstNumber,
      frequency: HST_FREQUENCIES.includes(hst.frequency as HstFrequency) ? (hst.frequency as HstFrequency) : "quarterly",
      fiscalYearEndMonth: month(hst.fiscal_year_end_month) ?? 12,
      filer: FILER_TYPES.includes(hst.filer as FilerType) ? (hst.filer as FilerType) : "corporation",
      reminders: bool(hst.reminders) ?? on,
      accountantEmail: isEmail(hst.accountant_email) ? hst.accountant_email.trim().toLowerCase() : null,
    },
    nudges: { weekly: bool(nudges.weekly) ?? on, tip: bool(nudges.tip) ?? on },
    defaultEnabled: on,
  };
}

/** HST reminders actually run: switched on AND a registrant. PURE. */
export function hstRemindersOn(settings: TaxClerkSettings): boolean {
  return settings.hst.reminders && settings.hst.registrant;
}

/** The new ai_settings with ONLY `tax_clerk` changed. PURE. */
export function mergeTaxClerkSettings(aiSettings: unknown, patch: TaxClerkPatch): Record<string, unknown> {
  const all = { ...record(aiSettings) };
  const section = { ...record(all[SETTINGS_KEY]) };
  if (patch.receipts && typeof patch.receipts.enabled === "boolean") section.receipts = { ...record(section.receipts), enabled: patch.receipts.enabled };
  if (patch.hst) {
    const h = { ...record(section.hst) };
    const p = patch.hst;
    if (p.registrant === null) delete h.registrant;
    else if (typeof p.registrant === "boolean") h.registrant = p.registrant;
    if (p.frequency && HST_FREQUENCIES.includes(p.frequency)) h.frequency = p.frequency;
    if (month(p.fiscalYearEndMonth)) h.fiscal_year_end_month = p.fiscalYearEndMonth;
    if (p.filer && FILER_TYPES.includes(p.filer)) h.filer = p.filer;
    if (typeof p.reminders === "boolean") h.reminders = p.reminders;
    if (p.accountantEmail === null || p.accountantEmail === "") delete h.accountant_email;
    else if (isEmail(p.accountantEmail)) h.accountant_email = p.accountantEmail.trim().toLowerCase();
    section.hst = h;
  }
  if (patch.nudges) {
    const n = { ...record(section.nudges) };
    if (typeof patch.nudges.weekly === "boolean") n.weekly = patch.nudges.weekly;
    if (typeof patch.nudges.tip === "boolean") n.tip = patch.nudges.tip;
    section.nudges = n;
  }
  section.any_on = record(section.receipts).enabled === true || record(section.hst).reminders === true || record(section.nudges).weekly === true;
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

/** One company as the Tax Clerk sees it. */
export interface TaxClerkCompany {
  organizationId: string;
  companyId: string;
  name: string;
  timeZone: string;
  doneForYou: boolean;
  platformBrand: string | null;
  ownerPhone: string | null;
  ownerEmail: string | null;
  hstNumber: string | null;
  createdAt: string | null;
  /** Archived / paused companies are skipped by the sweeps. */
  active: boolean;
  settings: TaxClerkSettings;
}

const COMPANY_COLUMNS = "id, organization_id, name, brand_from_name, timezone, ai_settings, owner_phone_e164, owner_phone_verified_at, owner_email, tax_registration_number, stage, created_at";

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
  tax_registration_number?: string | null;
  stage?: string | null;
  created_at?: string | null;
}

function toCompany(row: CompanyRow, platformBrand: string | null): TaxClerkCompany {
  const doneForYou = isDoneForYou(platformBrand);
  const hstNumber = row.tax_registration_number?.trim() || null;
  return {
    organizationId: row.organization_id,
    companyId: row.id,
    name: (row.brand_from_name?.trim() || row.name || "").trim() || "the business",
    timeZone: zoneOf(row.timezone),
    doneForYou,
    platformBrand,
    ownerPhone: row.owner_phone_verified_at && row.owner_phone_e164?.trim() ? row.owner_phone_e164.trim() : null,
    ownerEmail: isEmail(row.owner_email) ? row.owner_email.trim() : null,
    hstNumber,
    createdAt: row.created_at ?? null,
    active: !row.stage || !["archived", "paused", "cancelled"].includes(row.stage),
    settings: readTaxClerkSettings(row.ai_settings, { doneForYou, hasHstNumber: Boolean(hstNumber) }),
  };
}

/** One company (service role), scoped by org. Null → no such company in that org. */
export async function loadTaxClerkCompany(admin: AdminClient, organizationId: string, companyId: string): Promise<TaxClerkCompany | null> {
  const db = admin as Db;
  const { data } = await db.from("companies").select(COMPANY_COLUMNS).eq("organization_id", organizationId).eq("id", companyId).maybeSingle();
  if (!data) return null;
  const { data: org } = await db.from("organizations").select("platform_brand").eq("id", organizationId).maybeSingle();
  return toCompany(data as CompanyRow, (record(org).platform_brand as string | null) ?? null);
}

/** Anything of the Tax Clerk on for this company? PURE. */
export function taxClerkOn(company: Pick<TaxClerkCompany, "settings">): boolean {
  return company.settings.receipts.enabled || hstRemindersOn(company.settings);
}

/** Is the Tax Clerk on for this company? (Gates its tools, notes and receipts by text.) Never throws. */
export async function taxClerkActiveFor(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<boolean> {
  try {
    const company = await loadTaxClerkCompany(admin, scope.organizationId, scope.companyId);
    return Boolean(company && taxClerkOn(company));
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
 * Companies where the Tax Clerk may work: every company of a CrankLeads org, plus house-org
 * companies that switched something on (ai_settings.tax_clerk.any_on). House orgs are filtered
 * out at the query, so A1-style tenants never enter a sweep unless they opted in.
 */
export async function loadTaxClerkCompanies(admin: AdminClient): Promise<TaxClerkCompany[]> {
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
  const unknownOrgs = [...new Set(optedIn.map((r) => r.organization_id).filter((id) => !brands.has(id)))];
  for (const id of unknownOrgs) {
    const { data } = await db.from("organizations").select("id, platform_brand").eq("id", id).maybeSingle();
    brands.set(id, (record(data).platform_brand as string | null) ?? null);
  }
  for (const r of optedIn) rows.set(r.id, r);
  const out: TaxClerkCompany[] = [];
  for (const r of rows.values()) {
    const company = toCompany(r, brands.get(r.organization_id) ?? null);
    if (company.active && taxClerkOn(company)) out.push(company);
  }
  return out;
}

/**
 * The owner's profile for `created_by` (expenses must point at a real person): the member whose
 * cell matches the owner's verified phone (owners/admins first), else the org's first owner.
 */
export async function ownerProfileId(admin: AdminClient, organizationId: string, ownerPhone: string | null): Promise<string | null> {
  const db = admin as Db;
  const { data } = await db.from("organization_memberships").select("profile_id, role, phone_e164").eq("organization_id", organizationId).limit(200);
  const members = ((data ?? []) as Array<{ profile_id: string; role: string; phone_e164?: string | null }>).filter((m) => m.profile_id);
  const rank = (role: string) => (role === "owner" ? 0 : role === "admin" ? 1 : 2);
  const last10 = (p: string | null | undefined) => (p ?? "").replace(/\D/g, "").slice(-10);
  if (ownerPhone && last10(ownerPhone).length === 10) {
    const byPhone = members.filter((m) => last10(m.phone_e164) === last10(ownerPhone)).sort((a, b) => rank(a.role) - rank(b.role) || a.profile_id.localeCompare(b.profile_id));
    if (byPhone[0]) return byPhone[0].profile_id;
  }
  const owners = members.filter((m) => m.role === "owner").sort((a, b) => a.profile_id.localeCompare(b.profile_id));
  return owners[0]?.profile_id ?? null;
}
