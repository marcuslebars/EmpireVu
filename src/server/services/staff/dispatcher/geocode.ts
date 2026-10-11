/**
 * Where the business is, for the weather forecast. Geocoded ONCE per company:
 *   1. the Google listing (companies.google_place_id) via Places API (New) place details with
 *      the `location` field mask;
 *   2. else a Places text search on the business address, or the service area / town.
 * Jobs use the company's location (local service areas). Env GOOGLE_PLACES_API_KEY (the same
 * key as dfy/places.ts); unset → no geocoding (weather checks are skipped for that company).
 * The HTTP calls sit behind the injectable `Geocoder` seam (tests never touch Google).
 */
import { environmentCanadaTownGeocoder } from "./environment-canada";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { placesApiKey } from "@/server/services/dfy/places";
import type { DispatchCompany } from "./company";
import type { Db } from "./db-types";

const PLACES_BASE = "https://places.googleapis.com/v1";
const TIMEOUT_MS = 8_000;
/** A failed lookup is retried after this long. */
export const GEOCODE_RETRY_MS = 7 * 86_400_000;

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface Geocoder {
  /** Place details → location, or null. */
  placeLocation(placeId: string): Promise<LatLng | null>;
  /** Text search → the first result's location, or null. */
  searchLocation(query: string): Promise<LatLng | null>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** PURE: a Places API (New) `location` object → LatLng (or null when it isn't one). */
export function parsePlacesLocation(raw: unknown): LatLng | null {
  const loc = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const lat = typeof loc?.latitude === "number" ? loc.latitude : NaN;
  const lng = typeof loc?.longitude === "number" ? loc.longitude : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { latitude: lat, longitude: lng };
}

async function timed(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** The real Places API (New) geocoder. Null when GOOGLE_PLACES_API_KEY isn't set. */
export function placesGeocoder(fetchImpl: FetchLike = fetch, apiKey: string | null = placesApiKey()): Geocoder | null {
  if (!apiKey) return null;
  return {
    async placeLocation(placeId) {
      const res = await timed(fetchImpl, `${PLACES_BASE}/places/${encodeURIComponent(placeId)}`, {
        method: "GET",
        headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "location" },
      });
      if (!res.ok) return null;
      return parsePlacesLocation(((await res.json()) as Record<string, unknown>).location);
    },
    async searchLocation(query) {
      const res = await timed(fetchImpl, `${PLACES_BASE}/places:searchText`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "places.location" },
        body: JSON.stringify({ textQuery: query, regionCode: "CA", maxResultCount: 1 }),
      });
      if (!res.ok) return null;
      const places = ((await res.json()) as { places?: Array<{ location?: unknown }> }).places ?? [];
      return parsePlacesLocation(places[0]?.location);
    },
  };
}

/** PURE: what to search for when there's no Google listing (address, else town / service area). */
export function locationQueries(company: Pick<DispatchCompany, "businessAddress" | "serviceArea" | "businessName">): string[] {
  const out: string[] = [];
  if (company.businessAddress) out.push(company.businessAddress);
  if (company.serviceArea) {
    // "Midland, Penetanguishene and Tiny" → the first town is where they are.
    const first = company.serviceArea.split(/,|\band\b|&|\//i)[0]?.trim();
    if (first) out.push(/ontario|\bON\b|canada/i.test(first) ? first : `${first}, Ontario`);
  }
  return [...new Set(out)];
}

export interface GeocodeDeps {
  geocoder: Geocoder | null;
  nowMs: number;
}

/**
 * The company's location: stored, else geocoded now and stored (service role, scoped). A failed
 * attempt is stamped (location_checked_at) and retried after 7 days. Never throws.
 */
export async function ensureCompanyLocation(admin: AdminClient, company: DispatchCompany, deps: GeocodeDeps): Promise<LatLng | null> {
  if (company.latitude !== null && company.longitude !== null) return { latitude: company.latitude, longitude: company.longitude };
  if (!deps.geocoder) return null;
  if (company.locationCheckedAt && deps.nowMs - Date.parse(company.locationCheckedAt) < GEOCODE_RETRY_MS) return null;
  let found: LatLng | null = null;
  let source: string | null = null;
  try {
    if (company.googlePlaceId) {
      found = await deps.geocoder.placeLocation(company.googlePlaceId);
      if (found) source = "google_place";
    }
    for (const query of found ? [] : locationQueries(company)) {
      found = await deps.geocoder.searchLocation(query);
      if (found) {
        source = "text_search";
        break;
      }
    }
  } catch (err) {
    console.error("[dispatcher] geocoding failed", company.companyId, err instanceof Error ? err.message : err);
  }
  const patch: Record<string, unknown> = { location_checked_at: new Date(deps.nowMs).toISOString() };
  if (found) Object.assign(patch, { latitude: found.latitude, longitude: found.longitude, location_source: source });
  const { error } = await (admin as Db).from("companies").update(patch).eq("organization_id", company.organizationId).eq("id", company.companyId);
  if (error) console.error("[dispatcher] storing the location failed", company.companyId, error.message);
  if (found) {
    company.latitude = found.latitude;
    company.longitude = found.longitude;
  }
  company.locationCheckedAt = patch.location_checked_at as string;
  return found;
}

/**
 * The geocoder the sweeps use: Google Places when GOOGLE_PLACES_API_KEY is set (exact business
 * location, falls back to the town list for anything it can't find), else Environment Canada's
 * forecast-town list (the business's town — close enough for a local forecast).
 */
export function defaultGeocoder(): Geocoder {
  const towns = environmentCanadaTownGeocoder();
  const places = placesGeocoder();
  if (!places) return towns;
  return {
    placeLocation: (placeId) => places.placeLocation(placeId),
    async searchLocation(query) {
      return (await places.searchLocation(query).catch(() => null)) ?? (await towns.searchLocation(query).catch(() => null));
    },
  };
}

