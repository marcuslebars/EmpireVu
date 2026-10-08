/**
 * Google Places API (New) — the buyer's Google Business listing, for the quick-setup page's
 * "Find your business" search and for enrichment (docs/done-for-you.md, "Intake & enrichment").
 *
 *   POST https://places.googleapis.com/v1/places:searchText   (search box, via our proxy)
 *   GET  https://places.googleapis.com/v1/places/{id}          (details, field-masked)
 *
 * Env: GOOGLE_PLACES_API_KEY [web, workers]. Unset → Places is skipped (logged once) and the
 * page falls back to "paste your website" / "no website".
 *
 * Google's terms: we keep the place id, the facts below, the rating + review COUNT and a
 * link to write a review. We never store or re-display review text or photos.
 *
 * mapPlaceSearch / mapPlaceDetails / hoursFromPlaces / serviceAreaFromPlace are pure and
 * fixture-tested; searchPlaces / getPlaceDetails do the I/O (fetch injectable).
 */

const PLACES_BASE = "https://places.googleapis.com/v1";
const TIMEOUT_MS = 8_000;

export const PLACE_DETAILS_FIELD_MASK = [
  "id",
  "displayName",
  "formattedAddress",
  "addressComponents",
  "nationalPhoneNumber",
  "websiteUri",
  "regularOpeningHours",
  "rating",
  "userRatingCount",
  "googleMapsUri",
  "primaryTypeDisplayName",
].join(",");

const SEARCH_FIELD_MASK = "places.id,places.displayName,places.formattedAddress";

export interface PlaceSearchResult {
  placeId: string;
  name: string;
  address: string | null;
}

export interface PlaceHoursPeriod {
  /** 0 = Sunday … 6 = Saturday (Google's numbering). */
  day: number;
  open: string; // "08:00"
  close: string | null; // null = open 24h / no close given
}

export interface PlaceHours {
  summary: string;
  periods: PlaceHoursPeriod[];
}

export interface PlaceDetails {
  placeId: string;
  name: string | null;
  address: string | null;
  locality: string | null;
  province: string | null;
  phoneNational: string | null;
  website: string | null;
  hours: PlaceHours | null;
  rating: number | null;
  reviewCount: number | null;
  mapsUrl: string | null;
  primaryType: string | null;
  reviewUrl: string;
}

let warnedUnconfigured = false;

export function placesApiKey(): string | null {
  const key = process.env.GOOGLE_PLACES_API_KEY?.trim();
  if (!key) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn("[dfy/places] GOOGLE_PLACES_API_KEY is not set — Google listing lookup is off (website / no-website still work).");
    }
    return null;
  }
  return key;
}

export function isPlacesConfigured(): boolean {
  return Boolean(process.env.GOOGLE_PLACES_API_KEY?.trim());
}

/** Google's place ids are URL-safe tokens; anything else never reaches their API. */
export function isPlaceId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{10,300}$/.test(value);
}

export function reviewUrlFor(placeId: string): string {
  return `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`;
}

// ── Pure mapping ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function localizedText(value: unknown): string | null {
  if (value && typeof value === "object" && "text" in value) return str((value as { text: unknown }).text);
  return str(value);
}

export function mapPlaceSearch(raw: unknown): PlaceSearchResult[] {
  const places = raw && typeof raw === "object" && Array.isArray((raw as Raw).places) ? ((raw as Raw).places as Raw[]) : [];
  const out: PlaceSearchResult[] = [];
  for (const place of places) {
    const placeId = str(place?.id);
    const name = localizedText(place?.displayName);
    if (!placeId || !isPlaceId(placeId) || !name) continue;
    out.push({ placeId, name, address: str(place.formattedAddress) });
  }
  return out.slice(0, 8);
}

function pad(n: unknown): string {
  const value = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return String(value).padStart(2, "0");
}

/** Google day 0..6 (Sunday first) → "Sun".."Sat". */
const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * regularOpeningHours → companies.hours ({ summary, periods }). The summary is the
 * human string the AI receptionist and onboarding already read (hours.summary). Pure.
 */
export function hoursFromPlaces(raw: unknown): PlaceHours | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Raw;
  const periods: PlaceHoursPeriod[] = [];
  if (Array.isArray(value.periods)) {
    for (const p of value.periods as Raw[]) {
      const day = p?.open?.day;
      if (typeof day !== "number" || day < 0 || day > 6) continue;
      const open = `${pad(p.open.hour)}:${pad(p.open.minute)}`;
      const close = p.close && typeof p.close.hour === "number" ? `${pad(p.close.hour)}:${pad(p.close.minute)}` : null;
      periods.push({ day, open, close });
    }
  }
  const descriptions = Array.isArray(value.weekdayDescriptions)
    ? (value.weekdayDescriptions as unknown[]).map(str).filter((d): d is string => Boolean(d))
    : [];
  let summary = descriptions.join("; ");
  if (!summary && periods.length > 0) {
    summary = periods.map((p) => `${DAY_ABBR[p.day]} ${p.open}${p.close ? `–${p.close}` : ""}`).join("; ");
  }
  if (!summary) return null;
  // Google puts narrow no-break / thin spaces in its hours strings; keep plain spaces.
  summary = summary.replace(/[\u202f\u2009\u00a0]/g, " ");
  return { summary, periods };
}

function component(components: Raw[], type: string, short = false): string | null {
  const hit = components.find((c) => Array.isArray(c?.types) && (c.types as unknown[]).includes(type));
  return hit ? str(short ? hit.shortText : hit.longText) ?? str(hit.longText) : null;
}

export function mapPlaceDetails(raw: unknown): PlaceDetails | null {
  if (!raw || typeof raw !== "object") return null;
  const place = raw as Raw;
  const placeId = str(place.id);
  if (!placeId || !isPlaceId(placeId)) return null;
  const components: Raw[] = Array.isArray(place.addressComponents) ? place.addressComponents : [];
  const locality =
    component(components, "locality") ?? component(components, "postal_town") ?? component(components, "sublocality") ??
    component(components, "administrative_area_level_3");
  const rating = typeof place.rating === "number" && place.rating >= 0 && place.rating <= 5 ? Math.round(place.rating * 10) / 10 : null;
  const reviewCount =
    typeof place.userRatingCount === "number" && Number.isFinite(place.userRatingCount) && place.userRatingCount >= 0
      ? Math.floor(place.userRatingCount)
      : null;
  return {
    placeId,
    name: localizedText(place.displayName),
    address: str(place.formattedAddress),
    locality,
    province: component(components, "administrative_area_level_1", true),
    phoneNational: str(place.nationalPhoneNumber),
    website: str(place.websiteUri),
    hours: hoursFromPlaces(place.regularOpeningHours),
    rating,
    reviewCount,
    mapsUrl: str(place.googleMapsUri),
    primaryType: localizedText(place.primaryTypeDisplayName),
    reviewUrl: reviewUrlFor(placeId),
  };
}

/** "Barrie" → "Barrie and surrounding area". */
export function serviceAreaFromPlace(details: Pick<PlaceDetails, "locality"> | null): string | null {
  const town = details?.locality?.trim();
  return town ? `${town} and surrounding area` : null;
}

// ── I/O ──────────────────────────────────────────────────────────────────────

export class PlacesUnavailableError extends Error {}

async function placesFetch(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const message = body && typeof body === "object" ? String((body as Raw).error?.message ?? "") : "";
      throw new PlacesUnavailableError(`Google Places ${response.status}${message ? `: ${message}` : ""}`);
    }
    return body;
  } catch (err) {
    if (err instanceof PlacesUnavailableError) throw err;
    throw new PlacesUnavailableError(`Google Places unreachable: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

export interface PlacesDeps {
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
}

/** Text search, biased to Canada. Returns [] when Places isn't configured. */
export async function searchPlaces(query: string, deps: PlacesDeps = {}): Promise<PlaceSearchResult[]> {
  const apiKey = deps.apiKey === undefined ? placesApiKey() : deps.apiKey;
  const q = query.trim().slice(0, 120);
  if (!apiKey || q.length < 2) return [];
  const body = await placesFetch(deps.fetchImpl ?? fetch, `${PLACES_BASE}/places:searchText`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": SEARCH_FIELD_MASK },
    body: JSON.stringify({ textQuery: q, regionCode: "CA", languageCode: "en", pageSize: 6 }),
  });
  return mapPlaceSearch(body);
}

/** Place details with our field mask. Null when Places isn't configured. */
export async function getPlaceDetails(placeId: string, deps: PlacesDeps = {}): Promise<PlaceDetails | null> {
  const apiKey = deps.apiKey === undefined ? placesApiKey() : deps.apiKey;
  if (!apiKey || !isPlaceId(placeId)) return null;
  const body = await placesFetch(deps.fetchImpl ?? fetch, `${PLACES_BASE}/places/${encodeURIComponent(placeId)}?languageCode=en&regionCode=CA`, {
    method: "GET",
    headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": PLACE_DETAILS_FIELD_MASK },
  });
  return mapPlaceDetails(body);
}
