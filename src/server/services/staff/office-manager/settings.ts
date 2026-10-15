/**
 * The Office manager's settings: companies.ai_settings.office_manager, read with defaults. The ONE
 * typed reader (docs/ai-staff.md → "Office manager").
 *
 *   enabled   the morning briefing. Default ON for CrankLeads orgs, OFF for house orgs (A1…)
 *             unless the owner turns it on.
 *   time      local "HH:MM" between 06:00 and 09:00 (default 07:00).
 *   days      local weekdays (0 = Sunday … 6 = Saturday). Default Monday–Saturday.
 *   channels  ["sms"] (default) or ["sms", "email"] — the email copy has more detail. The text
 *             always goes; email is only ever a copy.
 *
 * PURE apart from the loaders at the bottom.
 */
import { isDoneForYou, PRODUCT_LINE_DB_VALUES } from "@/lib/product-line";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { chunks, isDoneForYouOrg, readAllPages } from "@/server/services/staff/bookkeeper/settings";
import { localParts } from "@/server/services/staff/bookkeeper/format";
import type { Db } from "./db-types";

export const SETTINGS_KEY = "office_manager";
export const DEFAULT_TIME = "07:00";
export const EARLIEST_TIME = "06:00";
export const LATEST_TIME = "09:00";
export const DEFAULT_DAYS = [1, 2, 3, 4, 5, 6];
/** A failed send can be retried until this local hour (then the day is given up). */
export const LAST_SEND_HOUR = 11;
/** Tries per day (the first + retries after a failed send or an unreadable part). */
export const MAX_ATTEMPTS = 3;

export type BriefingChannel = "sms" | "email";

export interface OfficeManagerSettings {
  enabled: boolean;
  /** `enabled` came from the default (no explicit choice yet). */
  enabledIsDefault: boolean;
  time: string;
  days: number[];
  channels: BriefingChannel[];
}

export interface OfficeManagerPatch {
  enabled?: boolean;
  time?: string;
  days?: number[];
  emailCopy?: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** "HH:MM" between 06:00 and 09:00 inclusive. PURE. */
export function isBriefingTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return false;
  const m = minutesOf(value);
  return m >= minutesOf(EARLIEST_TIME) && m <= minutesOf(LATEST_TIME);
}

/** Unique weekdays 0..6, ascending; null when nothing usable (an empty list isn't a schedule). PURE. */
export function normalizeDays(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const days = [...new Set(value.filter((d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
  return days.length ? days : null;
}

function normalizeChannels(value: unknown): BriefingChannel[] {
  const list = Array.isArray(value) ? value : [];
  return list.includes("email") ? ["sms", "email"] : ["sms"];
}

/** companies.ai_settings (any shape) → the Office manager section with defaults. PURE. */
export function readOfficeManagerSettings(aiSettings: unknown, org: { doneForYou: boolean }): OfficeManagerSettings {
  const s = record(record(aiSettings)[SETTINGS_KEY]);
  const explicit = typeof s.enabled === "boolean" ? s.enabled : null;
  return {
    enabled: explicit ?? org.doneForYou,
    enabledIsDefault: explicit === null,
    time: isBriefingTime(s.time) ? s.time : DEFAULT_TIME,
    days: normalizeDays(s.days) ?? DEFAULT_DAYS,
    channels: normalizeChannels(s.channels),
  };
}

/** The new ai_settings with ONLY `office_manager` changed. PURE. */
export function mergeOfficeManagerSettings(aiSettings: unknown, patch: OfficeManagerPatch): Record<string, unknown> {
  const all = { ...record(aiSettings) };
  const section = { ...record(all[SETTINGS_KEY]) };
  if (typeof patch.enabled === "boolean") section.enabled = patch.enabled;
  if (isBriefingTime(patch.time)) section.time = patch.time;
  if (patch.days !== undefined) {
    const days = normalizeDays(patch.days);
    if (days) section.days = days;
  }
  if (typeof patch.emailCopy === "boolean") section.channels = patch.emailCopy ? ["sms", "email"] : ["sms"];
  all[SETTINGS_KEY] = section;
  return all;
}

// ── When ─────────────────────────────────────────────────────────────────────

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Monday to Saturday", "every day", "weekdays", "Mon, Wed, Fri". PURE. */
export function daysLabel(days: number[]): string {
  const key = [...days].sort((a, b) => a - b).join(",");
  if (key === "0,1,2,3,4,5,6") return "every day";
  if (key === "1,2,3,4,5,6") return "Monday to Saturday";
  if (key === "1,2,3,4,5") return "weekdays";
  return [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => SHORT_DAYS[d]).join(", ");
}

/** "7am" / "7:30am" from "07:30". PURE. */
export function timeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
}

/** Is the briefing scheduled on this instant's LOCAL day (on, and the weekday is a briefing day)? PURE. */
export function briefingDay(settings: Pick<OfficeManagerSettings, "enabled" | "days">, nowMs: number, timeZone: string | null | undefined): boolean {
  return settings.enabled && settings.days.includes(localParts(nowMs, timeZone).weekday);
}

/**
 * Is it time to send (or retry) today's briefing? From the set time until 11:00 local, on a
 * briefing day. DST-safe: read from the wall clock, never by adding hours. PURE.
 */
export function briefingDue(settings: Pick<OfficeManagerSettings, "enabled" | "days" | "time">, nowMs: number, timeZone: string | null | undefined): boolean {
  if (!briefingDay(settings, nowMs, timeZone)) return false;
  const p = localParts(nowMs, timeZone);
  const now = p.hour * 60 + p.minute;
  return now >= minutesOf(settings.time) && p.hour < LAST_SEND_HOUR;
}

// ── Loaders ──────────────────────────────────────────────────────────────────

export const COMPANY_COLUMNS = "id, organization_id, name, brand_from_name, timezone, ai_settings, stage, owner_phone_e164, owner_phone_verified_at, owner_email";

export interface BriefingCompanyRow {
  id: string;
  organization_id: string;
  name: string;
  brand_from_name: string | null;
  timezone: string | null;
  ai_settings: unknown;
  stage: string | null;
  owner_phone_e164: string | null;
  owner_phone_verified_at: string | null;
  owner_email: string | null;
}

export interface BriefingCompany {
  organizationId: string;
  companyId: string;
  /** The name the owner knows (brand_from_name, else the company name). */
  name: string;
  timeZone: string;
  doneForYou: boolean;
  platformBrand: string;
  /** The VERIFIED owner cell, else null (no briefing). */
  ownerPhone: string | null;
  ownerEmail: string | null;
  active: boolean;
  settings: OfficeManagerSettings;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function toBriefingCompany(row: BriefingCompanyRow, platformBrand: string): BriefingCompany {
  const doneForYou = isDoneForYou(platformBrand);
  return {
    organizationId: row.organization_id,
    companyId: row.id,
    name: text(row.brand_from_name) ?? text(row.name) ?? "your business",
    timeZone: text(row.timezone) ?? process.env.BUSINESS_TIMEZONE?.trim() ?? "America/Toronto",
    doneForYou,
    platformBrand,
    ownerPhone: text(row.owner_phone_e164) && row.owner_phone_verified_at ? text(row.owner_phone_e164) : null,
    ownerEmail: text(row.owner_email),
    active: row.stage !== "paused" && row.stage !== "archived",
    settings: readOfficeManagerSettings(row.ai_settings, { doneForYou }),
  };
}

/** One company, scoped to its organization (service role). Null → no such company in that org. */
export async function loadBriefingCompany(admin: AdminClient, organizationId: string, companyId: string): Promise<BriefingCompany | null> {
  const db = admin as Db;
  const { data, error } = await db.from("companies").select(COMPANY_COLUMNS).eq("organization_id", organizationId).eq("id", companyId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: org } = await db.from("organizations").select("platform_brand").eq("id", organizationId).maybeSingle();
  const brand = text((org as Record<string, unknown> | null)?.platform_brand) ?? "empirevu";
  return toBriefingCompany(data as BriefingCompanyRow, isDoneForYouOrg(org) ? "crankleads" : brand);
}

/**
 * Companies with the briefing on: every active company of a CrankLeads org (unless switched off),
 * plus house-org companies that switched it on (ai_settings.office_manager.enabled = true).
 * House orgs are filtered out at the query, so A1-style tenants never enter the sweep unless
 * they opted in.
 */
export async function loadBriefingCompanies(admin: AdminClient): Promise<BriefingCompany[]> {
  const db = admin as Db;
  const orgs = await readAllPages<{ id: string }>((from, to) => db.from("organizations").select("id").in("platform_brand", [...PRODUCT_LINE_DB_VALUES.done_for_you]).order("id", { ascending: true }).range(from, to));
  const crankOrgs = new Set(orgs.map((o) => o.id));
  const rows = new Map<string, BriefingCompanyRow>();
  for (const ids of chunks([...crankOrgs])) {
    const page = await readAllPages<BriefingCompanyRow>((from, to) => db.from("companies").select(COMPANY_COLUMNS).in("organization_id", ids).order("id", { ascending: true }).range(from, to));
    for (const r of page) rows.set(r.id, r);
  }
  const optedIn = await readAllPages<BriefingCompanyRow>((from, to) =>
    db.from("companies").select(COMPANY_COLUMNS).eq(`ai_settings->${SETTINGS_KEY}->>enabled`, "true").order("id", { ascending: true }).range(from, to),
  );
  for (const r of optedIn) rows.set(r.id, r);
  return [...rows.values()]
    .map((r) => toBriefingCompany(r, crankOrgs.has(r.organization_id) ? "crankleads" : "empirevu"))
    .filter((c) => c.active && c.settings.enabled);
}

/** True when the morning briefing is on for this company (gates the owner tool and prompt notes). Never throws. */
export async function officeManagerActiveFor(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<boolean> {
  try {
    const company = await loadBriefingCompany(admin, scope.organizationId, scope.companyId);
    return Boolean(company && company.active && company.settings.enabled);
  } catch {
    return false;
  }
}

/**
 * The Bookkeeper's 08:00 money alert defers to the briefing: its items ride in the briefing
 * instead of a second text. True when today (local) is a briefing day for this company, the
 * briefing can reach the owner, and today's briefing hasn't ended WITHOUT the money items:
 *
 *   no row yet / claimed / failed with retries left / sent carrying the fold  → defer (true)
 *   sent without the fold (its read failed on the last try) / skipped (STOP)
 *     / failed with every try used                                          → the alert goes (false)
 *
 * The briefing marks items reported only after a send that carried them, and never folds again
 * once the day's row is final, so the two can't both report the same items. Cheap: the settings
 * are checked first (one company read; the org read only when `hint.crankleads` isn't given),
 * and today's row only on a briefing day. Never throws (false → the alert goes as usual).
 */
export async function briefingTakesMoneyAlert(
  admin: AdminClient,
  scope: { organizationId: string; companyId: string },
  nowMs: number,
  hint: { doneForYou?: boolean } = {},
): Promise<boolean> {
  try {
    const db = admin as Db;
    const { data, error } = await db.from("companies").select(COMPANY_COLUMNS).eq("organization_id", scope.organizationId).eq("id", scope.companyId).maybeSingle();
    if (error || !data) return false;
    const row = data as BriefingCompanyRow;
    let doneForYou = hint.doneForYou;
    if (doneForYou === undefined) {
      const explicit = record(record(row.ai_settings)[SETTINGS_KEY]).enabled;
      if (explicit === false) return false;
      const { data: org } = await db.from("organizations").select("platform_brand").eq("id", scope.organizationId).maybeSingle();
      doneForYou = isDoneForYouOrg(org);
    }
    const company = toBriefingCompany(row, doneForYou ? "crankleads" : "empirevu");
    if (!company.active || !company.ownerPhone || !briefingDay(company.settings, nowMs, company.timeZone)) return false;
    const today = localParts(nowMs, company.timeZone).date;
    const { data: brief, error: briefError } = await db
      .from("owner_briefings")
      .select("status, attempts, money_fold")
      .eq("organization_id", scope.organizationId)
      .eq("company_id", scope.companyId)
      .eq("local_date", today)
      .maybeSingle();
    if (briefError) return false;
    const b = brief as { status: string; attempts: number; money_fold: string | null } | null;
    if (!b) return true;
    if (b.status === "skipped") return false;
    if (b.status === "sent") return b.money_fold !== "failed";
    if (b.status === "failed") return (b.attempts ?? 0) < MAX_ATTEMPTS;
    return true; // claimed: the briefing is on it
  } catch {
    return false;
  }
}
