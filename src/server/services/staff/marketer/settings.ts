/**
 * The Marketer's settings — the ONE reader of companies.ai_settings.marketing
 * (docs/ai-staff.md → "Marketer"). Missing keys = the defaults here:
 *
 *   win_back.enabled        ON for CrankLeads orgs, OFF for house orgs (A1) unless turned on
 *   win_back.months_min/max past customers whose last job / paid invoice was 9–24 months ago
 *                           (max is capped at 24: CASL implied consent from a purchase lasts 2 years)
 *   win_back.weekly_cap     at most this many campaign texts per company per rolling 7 days (150)
 *   win_back.per_hour       send throttle (30/hour)
 *   win_back.start_hour/end_hour  local send window, 10:00–19:00 (always inside 09:00–20:00)
 *   win_back.days           Mon–Sat
 *   review_replies.enabled  ON for CrankLeads, OFF for house orgs
 *   google_posts.enabled    ON for CrankLeads, OFF for house orgs
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db, SendWindow } from "@/server/services/staff/marketer/db-types";

export interface MarketingSettings {
  winBack: {
    enabled: boolean;
    monthsMin: number;
    monthsMax: number;
    weeklyCap: number;
    perHour: number;
    startHour: number;
    endHour: number;
    days: number[];
  };
  reviewReplies: { enabled: boolean };
  googlePosts: { enabled: boolean };
}

export const MARKETING_DEFAULTS = {
  monthsMin: 9,
  monthsMax: 24,
  weeklyCap: 150,
  perHour: 30,
  startHour: 10,
  endHour: 19,
  days: [1, 2, 3, 4, 5, 6],
} as const;

/** Proactive texts only go out 09:00–20:00 local, whatever the setting says. */
export const PROACTIVE_EARLIEST_HOUR = 9;
export const PROACTIVE_LATEST_HOUR = 20;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** PURE: companies.ai_settings (any shape) → the Marketer's settings with defaults. */
export function readMarketingSettings(aiSettings: unknown, org: { crankleads: boolean }): MarketingSettings {
  const section = asRecord(asRecord(aiSettings).marketing);
  const wb = asRecord(section.win_back);
  const monthsMin = int(wb.months_min, MARKETING_DEFAULTS.monthsMin, 1, 23);
  const monthsMax = Math.max(monthsMin + 1, int(wb.months_max, MARKETING_DEFAULTS.monthsMax, 2, 24));
  const startHour = int(wb.start_hour, MARKETING_DEFAULTS.startHour, PROACTIVE_EARLIEST_HOUR, PROACTIVE_LATEST_HOUR - 1);
  const endHour = Math.max(startHour + 1, int(wb.end_hour, MARKETING_DEFAULTS.endHour, PROACTIVE_EARLIEST_HOUR + 1, PROACTIVE_LATEST_HOUR));
  const days = Array.isArray(wb.days)
    ? [...new Set((wb.days as unknown[]).filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6))].sort()
    : [...MARKETING_DEFAULTS.days];
  return {
    winBack: {
      enabled: bool(wb.enabled, org.crankleads),
      monthsMin,
      monthsMax,
      weeklyCap: int(wb.weekly_cap, MARKETING_DEFAULTS.weeklyCap, 1, 2000),
      perHour: int(wb.per_hour, MARKETING_DEFAULTS.perHour, 1, 200),
      startHour,
      endHour,
      days: days.length ? days : [...MARKETING_DEFAULTS.days],
    },
    reviewReplies: { enabled: bool(asRecord(section.review_replies).enabled, org.crankleads) },
    googlePosts: { enabled: bool(asRecord(section.google_posts).enabled, org.crankleads) },
  };
}

export function sendWindowOf(settings: MarketingSettings): SendWindow {
  const w = settings.winBack;
  return { perHour: w.perHour, startHour: w.startHour, endHour: w.endHour, days: [...w.days], weeklyCap: w.weeklyCap };
}

export interface MarketingSettingsPatch {
  winBack?: Partial<Pick<MarketingSettings["winBack"], "enabled" | "monthsMin" | "monthsMax" | "weeklyCap">>;
  reviewReplies?: { enabled?: boolean };
  googlePosts?: { enabled?: boolean };
}

/** PURE: merge a patch into ai_settings.marketing only (every other section untouched). */
export function mergeMarketingSettings(aiSettings: unknown, patch: MarketingSettingsPatch): Record<string, unknown> {
  const all = { ...asRecord(aiSettings) };
  const section = { ...asRecord(all.marketing) };
  if (patch.winBack) {
    const wb = { ...asRecord(section.win_back) };
    if (typeof patch.winBack.enabled === "boolean") wb.enabled = patch.winBack.enabled;
    if (typeof patch.winBack.monthsMin === "number") wb.months_min = patch.winBack.monthsMin;
    if (typeof patch.winBack.monthsMax === "number") wb.months_max = patch.winBack.monthsMax;
    if (typeof patch.winBack.weeklyCap === "number") wb.weekly_cap = patch.winBack.weeklyCap;
    section.win_back = wb;
  }
  if (patch.reviewReplies && typeof patch.reviewReplies.enabled === "boolean") {
    section.review_replies = { ...asRecord(section.review_replies), enabled: patch.reviewReplies.enabled };
  }
  if (patch.googlePosts && typeof patch.googlePosts.enabled === "boolean") {
    section.google_posts = { ...asRecord(section.google_posts), enabled: patch.googlePosts.enabled };
  }
  all.marketing = section;
  return all;
}

export interface MarketingCompany {
  organizationId: string;
  companyId: string;
  name: string;
  /** brand_from_name, else name — what customers see. */
  businessName: string;
  timeZone: string;
  crankleads: boolean;
  stage: string | null;
  googlePlaceId: string | null;
  googleRating: number | null;
  googleReviewCount: number | null;
  settings: MarketingSettings;
  raw: Record<string, unknown>;
}

export const COMPANY_COLUMNS =
  "id, organization_id, name, brand_from_name, timezone, stage, ai_settings, google_place_id, google_rating, google_review_count, industry_pack, service_area, brand_website_url, website, quote_public_base_url, online_booking_settings";

export function toMarketingCompany(row: Record<string, unknown>, crankleads: boolean): MarketingCompany {
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    organizationId: String(row.organization_id),
    companyId: String(row.id),
    name: String(row.name ?? ""),
    businessName: text(row.brand_from_name) ?? String(row.name ?? "").trim(),
    timeZone: text(row.timezone) ?? "America/Toronto",
    crankleads,
    stage: text(row.stage),
    googlePlaceId: text(row.google_place_id),
    googleRating: typeof row.google_rating === "number" ? row.google_rating : null,
    googleReviewCount: typeof row.google_review_count === "number" ? row.google_review_count : null,
    settings: readMarketingSettings(row.ai_settings, { crankleads }),
    raw: row,
  };
}

/** One company (scoped by org + company). Null → not found. */
export async function loadMarketingCompany(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<MarketingCompany | null> {
  const db = admin as Db;
  const { data, error } = await db
    .from("companies")
    .select(COMPANY_COLUMNS)
    .eq("organization_id", scope.organizationId)
    .eq("id", scope.companyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: org } = await db.from("organizations").select("platform_brand").eq("id", scope.organizationId).maybeSingle();
  return toMarketingCompany(data as Record<string, unknown>, (org as { platform_brand?: string | null } | null)?.platform_brand === "crankleads");
}

/**
 * Every active company the Marketer may work for (any feature on), across orgs — for the
 * sweeps. House orgs only appear when they turned a feature on explicitly.
 */
export async function listMarketingCompanies(admin: AdminClient, limit = 5000): Promise<MarketingCompany[]> {
  const db = admin as Db;
  const { data, error } = await db.from("companies").select(COMPANY_COLUMNS).limit(limit);
  if (error) throw error;
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const orgIds = [...new Set(rows.map((r) => String(r.organization_id)))];
  const brands = new Map<string, string | null>();
  for (let i = 0; i < orgIds.length; i += 200) {
    const { data: orgs } = await db.from("organizations").select("id, platform_brand").in("id", orgIds.slice(i, i + 200));
    for (const o of (orgs ?? []) as Array<{ id: string; platform_brand: string | null }>) brands.set(o.id, o.platform_brand);
  }
  return rows
    .map((row) => toMarketingCompany(row, brands.get(String(row.organization_id)) === "crankleads"))
    .filter((c) => c.stage !== "paused" && c.stage !== "archived")
    .filter((c) => c.settings.winBack.enabled || c.settings.reviewReplies.enabled || c.settings.googlePosts.enabled);
}
