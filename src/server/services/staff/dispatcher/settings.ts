/**
 * The Dispatcher's settings: companies.ai_settings.dispatch, read with defaults (docs/ai-staff.md
 * → "Dispatcher"). One typed reader; the route merges owner changes into this key only.
 *
 *   dispatch = {
 *     weather:        { enabled, sensitive: "all" | "none" | [service keys], rain_probability,
 *                       rain_mm, wind_kmh, min_temp_c, max_temp_c, check_at: "HH:MM" },
 *     on_our_way:     { enabled, from: "HH:MM", until: "HH:MM" },
 *     crew_texts:     { enabled, time: "HH:MM" },
 *     fill_gap:       { enabled },
 *     customer_hours: { from: "HH:MM", until: "HH:MM" }   // proactive customer texts
 *   }
 *
 * Every switch defaults ON for CrankLeads orgs and OFF for house orgs (A1 etc.) unless the
 * owner turns it on. Weather sensitivity defaults by trade: outdoor trades → all jobs, indoor
 * trades and snow removal → none.
 */
import { isDoneForYou } from "@/lib/product-line";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { parseAppliedIndustryPack } from "@/server/services/packs/types";

export type WeatherSensitivity = "all" | "none" | string[];

export interface WeatherThresholds {
  /** Rain: max hourly probability in the job window ≥ this (%) … */
  rainProbability: number;
  /** … AND total precipitation in the window ≥ this (mm). */
  rainMm: number;
  /** Sustained wind ≥ this (km/h) in the window. */
  windKmh: number;
  /** Temperature ≤ this (°C) … */
  minTempC: number;
  /** … or ≥ this (°C). */
  maxTempC: number;
}

export interface DispatchSettings {
  weather: {
    enabled: boolean;
    sensitive: WeatherSensitivity;
    /** True when `sensitive` is the trade default (not an owner choice). */
    sensitiveIsDefault: boolean;
    thresholds: WeatherThresholds;
    /** Local time the daily check runs (default 15:00). */
    checkAt: string;
  };
  onOurWay: { enabled: boolean; from: string; until: string };
  crewTexts: { enabled: boolean; time: string };
  fillGap: { enabled: boolean };
  customerHours: { from: string; until: string };
  /** The org's default for every switch (CrankLeads → on). */
  defaultEnabled: boolean;
}

export const DEFAULT_THRESHOLDS: WeatherThresholds = { rainProbability: 60, rainMm: 2, windKmh: 50, minTempC: -25, maxTempC: 35 };
export const DEFAULT_CHECK_AT = "15:00";
export const DEFAULT_CREW_TIME = "18:00";
export const DEFAULT_CUSTOMER_HOURS = { from: "09:00", until: "20:00" };
/** Crews head out early: "on our way" texts may go from 07:00 (it's the customer's own visit). */
export const DEFAULT_ON_OUR_WAY_HOURS = { from: "07:00", until: "20:00" };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isHhmm(value: unknown): value is string {
  return typeof value === "string" && HHMM_RE.test(value);
}

/** Crew texts go out 06:00–21:00, so the send time must be 06:00–20:59. */
export function isCrewTime(value: unknown): value is string {
  return isHhmm(value) && value >= "06:00" && value <= "20:59";
}

function hhmm(value: unknown, fallback: string): string {
  return isHhmm(value) ? value : fallback;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

// ── Trade → weather sensitivity ──────────────────────────────────────────────

/** Industry packs whose work is outdoors (weather matters) / indoors or weather-proof. */
const OUTDOOR_PACKS = new Set(["roofing", "landscaping"]);
const INDOOR_PACKS = new Set(["hvac-plumbing", "property-maintenance-snow", "marine"]);
/** Words in the business name / business type that mean outdoor work. */
const OUTDOOR_WORDS =
  /\b(roof\w*|landscap\w*|lawn\w*|garden\w*|paint\w*|pav(?:e|ing|er)\w*|asphalt|sealcoat\w*|interlock\w*|deck\w*|fenc\w*|exterior|pressure[\s-]?wash\w*|power[\s-]?wash\w*|soft[\s-]?wash\w*|window[\s-]?clean\w*|gutter\w*|eavestrough\w*|siding|masonry|concrete|stucco|tree)\b/i;
const INDOOR_WORDS = /\b(snow|plumb\w*|hvac|heating|furnace|electric\w*|interior|cleaning services?|maid|drywall)\b/i;

/**
 * Default weather sensitivity for a company: outdoor trades (roofing, landscaping, painting,
 * paving, decks, fencing, exterior cleaning, pressure washing) → "all"; indoor trades and snow
 * removal → "none". The industry pack decides when there is one; otherwise words in the
 * business name / CrankLeads business type. Unknown → "none" (never move jobs on a guess). PURE.
 */
export function defaultWeatherSensitivity(input: { industryPack?: unknown; hints?: Array<string | null | undefined> }): "all" | "none" {
  const applied = parseAppliedIndustryPack(input.industryPack ?? null);
  if (applied && OUTDOOR_PACKS.has(applied.id)) return "all";
  if (applied && INDOOR_PACKS.has(applied.id)) return "none";
  const text = (input.hints ?? []).filter(Boolean).join(" ");
  if (INDOOR_WORDS.test(text) && !/\b(exterior|outdoor)\b/i.test(text)) return "none";
  return OUTDOOR_WORDS.test(text) ? "all" : "none";
}

function readSensitivity(raw: unknown): WeatherSensitivity | null {
  if (raw === "all" || raw === "none") return raw;
  if (Array.isArray(raw)) {
    const keys = raw.filter((k): k is string => typeof k === "string" && k.trim().length > 0).map((k) => k.trim().slice(0, 80));
    return [...new Set(keys)].slice(0, 100);
  }
  return null;
}

export interface DispatchSettingsContext {
  doneForYou: boolean;
  industryPack?: unknown;
  /** Business name, CrankLeads business type … (for the trade default). */
  hints?: Array<string | null | undefined>;
}

/** PURE: companies.ai_settings (any shape) → the Dispatcher's settings with defaults applied. */
export function readDispatchSettings(aiSettings: unknown, ctx: DispatchSettingsContext): DispatchSettings {
  const section = asRecord(asRecord(aiSettings).dispatch);
  const weather = asRecord(section.weather);
  const onOurWay = asRecord(section.on_our_way);
  const crew = asRecord(section.crew_texts);
  const gap = asRecord(section.fill_gap);
  const hours = asRecord(section.customer_hours);
  const on = ctx.doneForYou;
  const sensitive = readSensitivity(weather.sensitive);
  return {
    weather: {
      enabled: bool(weather.enabled) ?? on,
      sensitive: sensitive ?? defaultWeatherSensitivity({ industryPack: ctx.industryPack, hints: ctx.hints }),
      sensitiveIsDefault: sensitive === null,
      thresholds: {
        rainProbability: num(weather.rain_probability, DEFAULT_THRESHOLDS.rainProbability, 1, 100),
        rainMm: num(weather.rain_mm, DEFAULT_THRESHOLDS.rainMm, 0.1, 200),
        windKmh: num(weather.wind_kmh, DEFAULT_THRESHOLDS.windKmh, 5, 250),
        minTempC: num(weather.min_temp_c, DEFAULT_THRESHOLDS.minTempC, -60, 20),
        maxTempC: num(weather.max_temp_c, DEFAULT_THRESHOLDS.maxTempC, 15, 60),
      },
      checkAt: hhmm(weather.check_at, DEFAULT_CHECK_AT),
    },
    onOurWay: {
      enabled: bool(onOurWay.enabled) ?? on,
      from: hhmm(onOurWay.from, DEFAULT_ON_OUR_WAY_HOURS.from),
      until: hhmm(onOurWay.until, DEFAULT_ON_OUR_WAY_HOURS.until),
    },
    crewTexts: { enabled: bool(crew.enabled) ?? on, time: isCrewTime(crew.time) ? crew.time : DEFAULT_CREW_TIME },
    fillGap: { enabled: bool(gap.enabled) ?? on },
    customerHours: { from: hhmm(hours.from, DEFAULT_CUSTOMER_HOURS.from), until: hhmm(hours.until, DEFAULT_CUSTOMER_HOURS.until) },
    defaultEnabled: on,
  };
}

/** What the owner may change (route body, already validated). */
export interface DispatchSettingsPatch {
  weather?: {
    enabled?: boolean;
    sensitive?: WeatherSensitivity | null;
    rainProbability?: number;
    rainMm?: number;
    windKmh?: number;
    minTempC?: number;
    maxTempC?: number;
  };
  onOurWay?: { enabled?: boolean };
  crewTexts?: { enabled?: boolean; time?: string };
  fillGap?: { enabled?: boolean };
}

/**
 * Merge a patch into ai_settings.dispatch only (other sections untouched). `sensitive: null`
 * goes back to the trade default. PURE.
 */
export function mergeDispatchSettings(aiSettings: unknown, patch: DispatchSettingsPatch): Record<string, unknown> {
  const all = { ...asRecord(aiSettings) };
  const section = { ...asRecord(all.dispatch) };
  if (patch.weather) {
    const w = { ...asRecord(section.weather) };
    const p = patch.weather;
    if (typeof p.enabled === "boolean") w.enabled = p.enabled;
    if (p.sensitive === null) delete w.sensitive;
    else if (p.sensitive !== undefined) {
      const s = readSensitivity(p.sensitive);
      if (s !== null) w.sensitive = s;
    }
    if (typeof p.rainProbability === "number") w.rain_probability = p.rainProbability;
    if (typeof p.rainMm === "number") w.rain_mm = p.rainMm;
    if (typeof p.windKmh === "number") w.wind_kmh = p.windKmh;
    if (typeof p.minTempC === "number") w.min_temp_c = p.minTempC;
    if (typeof p.maxTempC === "number") w.max_temp_c = p.maxTempC;
    section.weather = w;
  }
  if (patch.onOurWay && typeof patch.onOurWay.enabled === "boolean") section.on_our_way = { ...asRecord(section.on_our_way), enabled: patch.onOurWay.enabled };
  if (patch.crewTexts) {
    const c = { ...asRecord(section.crew_texts) };
    if (typeof patch.crewTexts.enabled === "boolean") c.enabled = patch.crewTexts.enabled;
    if (isCrewTime(patch.crewTexts.time)) c.time = patch.crewTexts.time;
    section.crew_texts = c;
  }
  if (patch.fillGap && typeof patch.fillGap.enabled === "boolean") section.fill_gap = { ...asRecord(section.fill_gap), enabled: patch.fillGap.enabled };
  // Marker for the sweeps' server-side filter (house orgs that switched something on).
  section.any_on = ["weather", "on_our_way", "crew_texts", "fill_gap"].some((k) => asRecord(section[k]).enabled === true);
  all.dispatch = section;
  return all;
}

/** Is this job weather-sensitive under the setting? (service key of the booked item, or a listed service's label in the title). PURE. */
export function isWeatherSensitiveJob(
  sensitive: WeatherSensitivity,
  job: { serviceKey: string | null; title: string | null },
  labels: Map<string, string> = new Map(),
): boolean {
  if (sensitive === "all") return true;
  if (sensitive === "none" || sensitive.length === 0) return false;
  if (job.serviceKey && sensitive.includes(job.serviceKey)) return true;
  const title = (job.title ?? "").toLowerCase();
  return sensitive.some((key) => {
    const label = labels.get(key)?.toLowerCase().trim();
    return Boolean(label && label.length >= 3 && title.includes(label));
  });
}

/** PURE: any feature on (weather counts only when some jobs are weather-sensitive). */
export function dispatcherAnyOn(s: DispatchSettings): boolean {
  return (s.weather.enabled && s.weather.sensitive !== "none") || s.onOurWay.enabled || s.crewTexts.enabled || s.fillGap.enabled;
}

/** Is any Dispatcher feature on for this company? (Show the role's prompt notes only where relevant.) Never throws. */
export async function dispatcherActiveFor(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = admin as any;
    const { data: company } = await db
      .from("companies")
      .select("id, name, ai_settings, industry_pack")
      .eq("organization_id", scope.organizationId)
      .eq("id", scope.companyId)
      .maybeSingle();
    if (!company) return false;
    const { data: org } = await db.from("organizations").select("platform_brand").eq("id", scope.organizationId).maybeSingle();
    const doneForYou = isDoneForYou((org as { platform_brand: string | null } | null)?.platform_brand);
    const c = company as { name: string; ai_settings: unknown; industry_pack: unknown };
    return dispatcherAnyOn(readDispatchSettings(c.ai_settings, { doneForYou, industryPack: c.industry_pack, hints: [c.name] }));
  } catch {
    return false;
  }
}
