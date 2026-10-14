/**
 * Environment Canada forecasts for the Dispatcher (the default weather source).
 *
 * Source: the MSC Datamart "citypage weather" XML — the same forecast weather.gc.ca shows for
 * ~800 Canadian towns. Free for commercial use under the ECCC Data Server End-use Licence;
 * attribution: "Data Source: Environment and Climate Change Canada".
 *   https://eccc-msc.github.io/open-data/msc-data/citypage-weather/readme_citypageweather-datamart_en/
 *
 * How a forecast is built for a company's lat/lng:
 *   1. The site list (CSV, cached a day) → the nearest forecast town (and its province).
 *   2. The province's directory for the current UTC hour (then the 2 before) → the newest
 *      `…_MSC_CitypageWeather_<site>_en.xml`.
 *   3. The XML → hourly points: the next 24 h from <hourlyForecastGroup> (probability of
 *      precipitation, wind, temperature — no amounts), then the day/night periods of
 *      <forecastGroup> (PoP, rain accumulation, wind incl. gusts, high/low), spread over their
 *      hours (day 06–18, night 18–06 local) for days 2–6.
 * Anything unparseable yields fewer hours, never invented ones: a job window with no hours is
 * "not covered" and is never moved.
 */
import { XMLParser } from "fast-xml-parser";

import type { LatLng } from "./geocode";
import type { Forecast, HourlyForecast, WeatherProvider } from "./weather";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const EC_SITE_LIST_URL = "https://dd.weather.gc.ca/today/citypage_weather/docs/site_list_towns_en.csv";
export const EC_CITYPAGE_BASE = "https://dd.weather.gc.ca/today/citypage_weather";
export const EC_ATTRIBUTION = "Data Source: Environment and Climate Change Canada";

const HOUR = 3_600_000;
const TIMEOUT_MS = 10_000;
const SITE_LIST_TTL_MS = 24 * HOUR;
const USER_AGENT = "Everdoer-Dispatcher/1.0 (weather checks for scheduled jobs)";

// ── Site list ─────────────────────────────────────────────────────────────────

export interface EcSite {
  code: string; // s0000458
  name: string;
  province: string; // ON
  latitude: number;
  longitude: number;
}

/** "43.74N" → 43.74, "79.37W" → -79.37. PURE. */
function coordinate(raw: string | undefined): number | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*([NSEW])?\s*$/i.exec(raw ?? "");
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const hemi = (m[2] ?? "").toUpperCase();
  return hemi === "S" || hemi === "W" ? -Math.abs(value) : value;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * PURE: the site list CSV → sites. The file starts with a title line, then a header row
 * (Codes, English Names, Province Codes, Latitude, Longitude); the header is found by name, so
 * an extra or missing title line doesn't matter. High-elevation (HEF) sites are skipped.
 */
export function parseSiteList(csv: string): EcSite[] {
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/);
  const headerAt = lines.findIndex((l) => /(^|,)\s*"?Codes"?\s*,/i.test(l));
  if (headerAt < 0) return [];
  const header = splitCsvLine(lines[headerAt]).map((h) => h.toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iCode = col("codes");
  const iName = col("english names");
  const iProv = col("province codes");
  const iLat = col("latitude");
  const iLng = col("longitude");
  if ([iCode, iProv, iLat, iLng].some((i) => i < 0)) return [];
  const sites: EcSite[] = [];
  for (const line of lines.slice(headerAt + 1)) {
    if (!line.trim()) continue;
    const cells = splitCsvLine(line);
    const code = cells[iCode];
    const province = (cells[iProv] ?? "").toUpperCase();
    const latitude = coordinate(cells[iLat]);
    let longitude = coordinate(cells[iLng]);
    if (!code || !/^s\d{7}$/.test(code) || !/^[A-Z]{2}$/.test(province) || latitude === null || longitude === null) continue;
    // Canada is entirely west of Greenwich: a bare positive longitude is a missing "W".
    if (longitude > 0) longitude = -longitude;
    sites.push({ code, name: cells[iName] ?? code, province, latitude, longitude });
  }
  return sites;
}

function distanceKm(a: LatLng, b: { latitude: number; longitude: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLng = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** PURE: the nearest site within maxKm (a business 300 km from any forecast town gets none). */
export function nearestSite(sites: EcSite[], location: LatLng, maxKm = 150): EcSite | null {
  let best: EcSite | null = null;
  let bestKm = Infinity;
  for (const s of sites) {
    const km = distanceKm(location, s);
    if (km < bestKm) {
      best = s;
      bestKm = km;
    }
  }
  return best && bestKm <= maxKm ? best : null;
}

// ── Directory listing ─────────────────────────────────────────────────────────

/** PURE: the newest English file for a site in a Datamart directory listing (HTML). */
export function latestFileForSite(listingHtml: string, siteCode: string): string | null {
  const re = new RegExp(`href="([^"]*_MSC_CitypageWeather_${siteCode}_en\\.xml)"`, "g");
  const files: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(listingHtml))) files.push(m[1]);
  if (files.length === 0) return null;
  // Names start with the issue time (YYYYMMDDTHHmmss…Z), so the newest sorts last.
  return files.map((f) => f.split("/").pop() as string).sort().at(-1) ?? null;
}

// ── XML → hours ──────────────────────────────────────────────────────────────

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false, trimValues: true });

type Node = Record<string, unknown>;

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** A node's text: a bare string, or the "#text" of an element with attributes. */
function text(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object" && "#text" in (v as Node)) return text((v as Node)["#text"]);
  return null;
}

function num(v: unknown): number | null {
  const t = text(v);
  if (t === null) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function attr(v: unknown, name: string): string | null {
  if (v && typeof v === "object") {
    const a = (v as Node)[`@_${name}`];
    return typeof a === "string" ? a : null;
  }
  return null;
}

/** "202610111600" / "20261011160000" (UTC) → ms. PURE. */
export function parseEcUtcStamp(stamp: string | null): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/.exec(stamp ?? "");
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? "0"));
}

function maxOrNull(values: Array<number | null>): number | null {
  const v = values.filter((x): x is number => x !== null);
  return v.length ? Math.max(...v) : null;
}

/** Wind for one <wind> element: the gust when there is one (what stops a roofer), else speed. */
function windOf(wind: unknown): number | null {
  return maxOrNull([num((wind as Node | undefined)?.speed), num((wind as Node | undefined)?.gust)]);
}

/** The forecast issue time in UTC ms and the local UTC offset (hours) from <forecastGroup>. */
function issueInfo(group: Node): { issuedMs: number | null; offsetHours: number | null } {
  let issuedMs: number | null = null;
  let offsetHours: number | null = null;
  for (const dt of asArray(group.dateTime as Node | Node[])) {
    const zone = attr(dt, "zone");
    const offset = Number(attr(dt, "UTCOffset"));
    if (zone === "UTC") issuedMs = parseEcUtcStamp(text(dt.timeStamp));
    else if (Number.isFinite(offset)) offsetHours = offset;
  }
  return { issuedMs, offsetHours };
}

/** Rain accumulation in mm for a period (snow in cm is not rain; ignored). */
function rainMmOf(forecast: Node): number | null {
  const precip = forecast.precipitation as Node | undefined;
  let total: number | null = null;
  for (const acc of asArray(precip?.accumulation as Node | Node[])) {
    const amount = acc.amount;
    const units = (attr(amount, "units") ?? "").toLowerCase();
    const name = (text(acc.name) ?? "").toLowerCase();
    const value = num(amount);
    if (value === null || units !== "mm" || name.includes("snow")) continue;
    total = (total ?? 0) + value;
  }
  return total;
}

/**
 * PURE: a citypage XML document → hourly points (UTC hours, ascending, no duplicates).
 * Hourly group first; periods fill the hours after it. A period's rain total is spread evenly
 * over its 12 hours so window sums stay honest.
 */
export function parseCitypageXml(xml: string): HourlyForecast[] {
  let doc: Node;
  try {
    doc = parser.parse(xml) as Node;
  } catch {
    return [];
  }
  const site = (doc.siteData ?? {}) as Node;
  const byHour = new Map<number, HourlyForecast>();

  for (const h of asArray((site.hourlyForecastGroup as Node | undefined)?.hourlyForecast as Node | Node[])) {
    const t = parseEcUtcStamp(attr(h, "dateTimeUTC"));
    if (t === null) continue;
    byHour.set(t, { timeMs: t, precipProbability: num(h.lop), precipMm: null, windKmh: windOf(h.wind), tempC: num(h.temperature) });
  }
  const lastHourly = byHour.size ? Math.max(...byHour.keys()) : -Infinity;

  const group = (site.forecastGroup ?? {}) as Node;
  const { issuedMs, offsetHours } = issueInfo(group);
  if (issuedMs !== null && offsetHours !== null) {
    // Local wall clock as if it were UTC, to walk days without a tz library.
    const localIssued = new Date(issuedMs + offsetHours * HOUR);
    let dayStartLocalMs = Date.UTC(localIssued.getUTCFullYear(), localIssued.getUTCMonth(), localIssued.getUTCDate());
    let first = true;
    for (const f of asArray(group.forecast as Node | Node[])) {
      const name = (attr(f.period, "textForecastName") ?? text(f.period) ?? "").toLowerCase();
      const isNight = /night/.test(name);
      if (!first && !isNight) dayStartLocalMs += 24 * HOUR; // a new day after the previous night
      first = false;
      const startLocal = dayStartLocalMs + (isNight ? 18 : 6) * HOUR;
      const startUtc = startLocal - offsetHours * HOUR;
      const pop = num((f.abbreviatedForecast as Node | undefined)?.pop);
      const rain = rainMmOf(f);
      const wind = maxOrNull(asArray((f.winds as Node | undefined)?.wind as Node | Node[]).map(windOf));
      const temp = num((f.temperatures as Node | undefined)?.temperature);
      for (let i = 0; i < 12; i++) {
        const t = startUtc + i * HOUR;
        if (t <= lastHourly || byHour.has(t)) continue;
        byHour.set(t, {
          timeMs: t,
          // An empty <pop/> means EC gives no meaningful chance of precipitation.
          precipProbability: pop ?? 0,
          precipMm: rain === null ? null : Math.round((rain / 12) * 100) / 100,
          windKmh: wind,
          tempC: temp,
        });
      }
    }
  }
  return [...byHour.values()].sort((a, b) => a.timeMs - b.timeMs);
}

// ── Provider ─────────────────────────────────────────────────────────────────

let siteCache: { at: number; sites: EcSite[] } | null = null;

/** Test hook. */
export function clearEcSiteCache(): void {
  siteCache = null;
}

async function get(fetchImpl: FetchLike, url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`Environment Canada ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function sitesFor(fetchImpl: FetchLike, nowMs: number): Promise<EcSite[]> {
  if (siteCache && nowMs - siteCache.at < SITE_LIST_TTL_MS && siteCache.sites.length) return siteCache.sites;
  const sites = parseSiteList(await get(fetchImpl, EC_SITE_LIST_URL));
  if (sites.length === 0) throw new Error("Environment Canada site list was empty or unreadable");
  siteCache = { at: nowMs, sites };
  return sites;
}

/** The newest citypage file URL for a site: this UTC hour's directory, then the 2 before. */
async function latestCitypageUrl(fetchImpl: FetchLike, site: EcSite, nowMs: number): Promise<string> {
  for (let back = 0; back < 3; back++) {
    const hh = String(new Date(nowMs - back * HOUR).getUTCHours()).padStart(2, "0");
    const dir = `${EC_CITYPAGE_BASE}/${site.province}/${hh}/`;
    let listing: string;
    try {
      listing = await get(fetchImpl, dir);
    } catch {
      continue;
    }
    const file = latestFileForSite(listing, site.code);
    if (file) return `${dir}${file}`;
  }
  throw new Error(`No recent Environment Canada forecast for ${site.code} (${site.name})`);
}

export function environmentCanadaProvider(fetchImpl: FetchLike = fetch, now: () => number = Date.now): WeatherProvider {
  return {
    name: "environment-canada",
    async forecast(location) {
      const nowMs = now();
      const site = nearestSite(await sitesFor(fetchImpl, nowMs), location);
      if (!site) throw new Error("No Environment Canada forecast town near this location");
      const xml = await get(fetchImpl, await latestCitypageUrl(fetchImpl, site, nowMs));
      const hours = parseCitypageXml(xml);
      if (hours.length === 0) throw new Error(`Environment Canada forecast for ${site.code} had no usable hours`);
      const forecast: Forecast = { latitude: location.latitude, longitude: location.longitude, fetchedAtMs: nowMs, hours };
      return forecast;
    },
  };
}

// ── Town geocoder (no Google key needed) ─────────────────────────────────────

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * PURE: the forecast town named in an address / service-area string ("12 King St, Midland, ON"
 * → Midland's coordinates). Each comma-separated part is tried as a town name, Ontario first.
 */
export function townLocation(sites: EcSite[], query: string, preferProvince = "ON"): LatLng | null {
  const parts = query.split(",").map((p) => norm(p.replace(/\b(ontario|on|canada)\b/gi, ""))).filter(Boolean);
  for (const part of parts) {
    const matches = sites.filter((s) => norm(s.name) === part);
    const pick = matches.find((s) => s.province === preferProvince) ?? matches[0];
    if (pick) return { latitude: pick.latitude, longitude: pick.longitude };
  }
  return null;
}

/** A Geocoder from the Environment Canada town list: text search only (no Google listing lookups). */
export function environmentCanadaTownGeocoder(fetchImpl: FetchLike = fetch, now: () => number = Date.now) {
  return {
    async placeLocation(): Promise<LatLng | null> {
      return null;
    },
    async searchLocation(query: string): Promise<LatLng | null> {
      return townLocation(await sitesFor(fetchImpl, now()), query);
    },
  };
}
