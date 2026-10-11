/**
 * Weather for the Dispatcher: a provider interface, a per-company hourly cache, and the PURE
 * risk rule for a job window. Providers:
 *
 *   default                → Environment Canada (environment-canada.ts): free for commercial
 *                            use under the ECCC open-data licence, Canada-wide.
 *   OPEN_METEO_API_KEY set → Open-Meteo's commercial API (customer-api.open-meteo.com).
 *   (The free Open-Meteo API is non-commercial, so it's never used in production.)
 *
 * Times are requested as unix seconds in UTC (timeformat=unixtime, timezone=GMT), so a job's
 * window is matched by instant — no local-time parsing, DST-proof.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { DispatchCompany } from "./company";
import type { Db } from "./db-types";
import type { LatLng } from "./geocode";
import type { WeatherThresholds } from "./settings";
import { environmentCanadaProvider } from "./environment-canada";

export interface HourlyForecast {
  /** Start of the hour (UTC ms). Precipitation is Open-Meteo's "sum of the preceding hour". */
  timeMs: number;
  precipProbability: number | null;
  precipMm: number | null;
  windKmh: number | null;
  tempC: number | null;
}

export interface Forecast {
  latitude: number;
  longitude: number;
  fetchedAtMs: number;
  hours: HourlyForecast[];
}

export interface WeatherProvider {
  name: string;
  forecast(location: LatLng, options?: { days?: number }): Promise<Forecast>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const HOURLY = "precipitation_probability,precipitation,wind_speed_10m,temperature_2m";
const TIMEOUT_MS = 10_000;

function numAt(list: unknown, i: number): number | null {
  if (!Array.isArray(list)) return null;
  const v = list[i];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** PURE: an Open-Meteo forecast response (timeformat=unixtime) → Forecast. */
export function parseOpenMeteo(json: unknown, location: LatLng, fetchedAtMs: number): Forecast {
  const hourly = json && typeof json === "object" ? ((json as Record<string, unknown>).hourly as Record<string, unknown> | undefined) : undefined;
  const times = Array.isArray(hourly?.time) ? (hourly?.time as unknown[]) : [];
  const hours: HourlyForecast[] = [];
  times.forEach((t, i) => {
    const seconds = typeof t === "number" ? t : typeof t === "string" ? Date.parse(t.endsWith("Z") ? t : `${t}Z`) / 1000 : NaN;
    if (!Number.isFinite(seconds)) return;
    hours.push({
      timeMs: seconds * 1000,
      precipProbability: numAt(hourly?.precipitation_probability, i),
      precipMm: numAt(hourly?.precipitation, i),
      windKmh: numAt(hourly?.wind_speed_10m, i),
      tempC: numAt(hourly?.temperature_2m, i),
    });
  });
  return { latitude: location.latitude, longitude: location.longitude, fetchedAtMs, hours };
}

/** PURE: the request URL (commercial endpoint + key when one is set). */
export function openMeteoUrl(location: LatLng, days: number, apiKey: string | null): string {
  const base = apiKey ? "https://customer-api.open-meteo.com/v1/forecast" : "https://api.open-meteo.com/v1/forecast";
  const params = new URLSearchParams({
    latitude: location.latitude.toFixed(4),
    longitude: location.longitude.toFixed(4),
    hourly: HOURLY,
    timezone: "GMT",
    timeformat: "unixtime",
    wind_speed_unit: "kmh",
    forecast_days: String(Math.max(1, Math.min(16, days))),
  });
  if (apiKey) params.set("apikey", apiKey);
  return `${base}?${params.toString()}`;
}

let warnedFreeTier = false;

/**
 * Weather checks can run: Environment Canada needs no key, so always (kept as a seam — e.g. a
 * future switch to turn weather off platform-wide). WEATHER_PROVIDER=off disables them.
 */
export function weatherConfigured(env: Record<string, string | undefined> = process.env): boolean {
  if ((env.WEATHER_PROVIDER ?? "").trim().toLowerCase() === "off") {
    if (!warnedFreeTier) {
      warnedFreeTier = true;
      console.warn("[dispatcher] WEATHER_PROVIDER=off - weather checks are disabled.");
    }
    return false;
  }
  return true;
}

/** The provider the sweeps use: Open-Meteo's commercial API when a key is set, else Environment Canada. */
export function defaultWeatherProvider(env: Record<string, string | undefined> = process.env): WeatherProvider {
  const key = env.OPEN_METEO_API_KEY?.trim();
  return key ? openMeteoProvider(fetch, key) : environmentCanadaProvider();
}

export function openMeteoProvider(fetchImpl: FetchLike = fetch, apiKey: string | null = process.env.OPEN_METEO_API_KEY?.trim() || null): WeatherProvider {
  return {
    name: apiKey ? "open-meteo-commercial" : "open-meteo",
    async forecast(location, options = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetchImpl(openMeteoUrl(location, options.days ?? 7, apiKey), { signal: controller.signal });
        if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
        return parseOpenMeteo(await res.json(), location, Date.now());
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ── Risk ─────────────────────────────────────────────────────────────────────

export type RiskKind = "rain" | "wind" | "cold" | "heat";

export interface WeatherRisk {
  atRisk: boolean;
  kinds: RiskKind[];
  /** "rain 80%, 6 mm" / "wind 55 km/h" / "-28C" — for the owner. */
  reason: string | null;
  /** The forecast has hours for this window (false → beyond the forecast, unknown). */
  covered: boolean;
  maxProbability: number | null;
  totalMm: number | null;
  maxWindKmh: number | null;
  minTempC: number | null;
  maxTempC: number | null;
}

const HOUR = 3_600_000;

/** The forecast hours touching [startMs, endMs) (the hour the job starts in through the hour it ends in). */
function hoursIn(forecast: Forecast, startMs: number, endMs: number): HourlyForecast[] {
  const from = Math.floor(startMs / HOUR) * HOUR;
  const to = Math.max(from + HOUR, endMs);
  return forecast.hours.filter((h) => h.timeMs >= from && h.timeMs < to);
}

function maxOf(values: Array<number | null>): number | null {
  const v = values.filter((x): x is number => x !== null);
  return v.length ? Math.max(...v) : null;
}

function minOf(values: Array<number | null>): number | null {
  const v = values.filter((x): x is number => x !== null);
  return v.length ? Math.min(...v) : null;
}

/**
 * PURE. Is a job window at risk? Rain: max probability ≥ threshold AND total precipitation ≥
 * threshold mm — when the source gives no amounts for the window (Environment Canada's hourly
 * forecast is probability-only), probability alone decides; wind: max wind (gusts where the
 * source has them) ≥ threshold; temperature: min ≤ low or max ≥ high.
 */
export function assessWindow(forecast: Forecast, startMs: number, endMs: number, t: WeatherThresholds): WeatherRisk {
  const hours = hoursIn(forecast, startMs, endMs);
  if (hours.length === 0) {
    return { atRisk: false, kinds: [], reason: null, covered: false, maxProbability: null, totalMm: null, maxWindKmh: null, minTempC: null, maxTempC: null };
  }
  const maxProbability = maxOf(hours.map((h) => h.precipProbability));
  const mmValues = hours.map((h) => h.precipMm).filter((x): x is number => x !== null);
  const totalMm = mmValues.length ? Math.round(mmValues.reduce((a, b) => a + b, 0) * 10) / 10 : null;
  const maxWindKmh = maxOf(hours.map((h) => h.windKmh));
  const minTempC = minOf(hours.map((h) => h.tempC));
  const maxTempC = maxOf(hours.map((h) => h.tempC));
  const kinds: RiskKind[] = [];
  const reasons: string[] = [];
  // Amounts can only clear a rainy window when every likely-rain hour has one (Environment
  // Canada's hourly forecast has none; its day/night periods do).
  const wetHours = hours.filter((h) => h.precipProbability !== null && h.precipProbability >= t.rainProbability);
  const amountsKnown = wetHours.length > 0 && wetHours.every((h) => h.precipMm !== null);
  if (maxProbability !== null && maxProbability >= t.rainProbability && (!amountsKnown || (totalMm !== null && totalMm >= t.rainMm))) {
    kinds.push("rain");
    reasons.push(amountsKnown && totalMm !== null ? `rain ${Math.round(maxProbability)}%, ${totalMm} mm` : `rain ${Math.round(maxProbability)}%`);
  }
  if (maxWindKmh !== null && maxWindKmh >= t.windKmh) {
    kinds.push("wind");
    reasons.push(`wind ${Math.round(maxWindKmh)} km/h`);
  }
  if (minTempC !== null && minTempC <= t.minTempC) {
    kinds.push("cold");
    reasons.push(`${Math.round(minTempC)}C`);
  }
  if (maxTempC !== null && maxTempC >= t.maxTempC) {
    kinds.push("heat");
    reasons.push(`${Math.round(maxTempC)}C`);
  }
  return { atRisk: kinds.length > 0, kinds, reason: reasons.length ? reasons.join(", ") : null, covered: true, maxProbability, totalMm, maxWindKmh, minTempC, maxTempC };
}

/** "Rain is in the forecast" — the customer-facing reason (no numbers). PURE. */
export function customerReason(kinds: RiskKind[]): string {
  if (kinds.includes("rain")) return "Rain is in the forecast";
  if (kinds.includes("wind")) return "High winds are forecast";
  if (kinds.includes("cold")) return "Extreme cold is forecast";
  if (kinds.includes("heat")) return "Extreme heat is forecast";
  return "The weather doesn't look good";
}

// ── Cache: one forecast per company per hour (memory, then the DB row) ─────────

const memory = new Map<string, { hourKey: string; forecast: Forecast }>();

export function hourKeyOf(nowMs: number): string {
  return new Date(Math.floor(nowMs / HOUR) * HOUR).toISOString().slice(0, 13);
}

/** Test hook. */
export function clearWeatherMemoryCache(): void {
  memory.clear();
}

function sameSpot(f: { latitude: number; longitude: number }, loc: LatLng): boolean {
  return Math.abs(f.latitude - loc.latitude) < 1e-4 && Math.abs(f.longitude - loc.longitude) < 1e-4;
}

/**
 * The company's forecast, fetched at most once per hour per company (shared across workers
 * through dispatch_weather_cache). Null when the provider fails and nothing is cached.
 */
export async function getCompanyForecast(
  admin: AdminClient,
  company: Pick<DispatchCompany, "organizationId" | "companyId">,
  location: LatLng,
  deps: { provider: WeatherProvider; nowMs: number },
): Promise<Forecast | null> {
  const hourKey = hourKeyOf(deps.nowMs);
  const hit = memory.get(company.companyId);
  if (hit && hit.hourKey === hourKey && sameSpot(hit.forecast, location)) return hit.forecast;
  const db = admin as Db;
  try {
    const { data } = await db.from("dispatch_weather_cache").select("*").eq("company_id", company.companyId).maybeSingle();
    const row = data as { hour_key: string; latitude: number; longitude: number; forecast: Forecast } | null;
    if (row && row.hour_key === hourKey && sameSpot(row, location) && row.forecast && Array.isArray(row.forecast.hours)) {
      memory.set(company.companyId, { hourKey, forecast: row.forecast });
      return row.forecast;
    }
  } catch {
    // cache read is best-effort
  }
  let forecast: Forecast;
  try {
    forecast = await deps.provider.forecast(location, { days: 7 });
  } catch (err) {
    console.error("[dispatcher] forecast failed", company.companyId, err instanceof Error ? err.message : err);
    return hit && sameSpot(hit.forecast, location) ? hit.forecast : null;
  }
  memory.set(company.companyId, { hourKey, forecast });
  const { error } = await db.from("dispatch_weather_cache").upsert(
    {
      company_id: company.companyId,
      organization_id: company.organizationId,
      hour_key: hourKey,
      latitude: location.latitude,
      longitude: location.longitude,
      forecast,
      fetched_at: new Date(deps.nowMs).toISOString(),
    },
    { onConflict: "company_id" },
  );
  if (error) console.error("[dispatcher] forecast cache write failed", company.companyId, error.message);
  return forecast;
}
