/**
 * Google Places API (New) — the business's recent reviews, for the Marketer's reply drafts.
 *
 *   GET https://places.googleapis.com/v1/places/{placeId}
 *       X-Goog-FieldMask: reviews,rating,userRatingCount,googleMapsUri
 *
 * Google returns at most 5 reviews (its "most relevant"), each with a resource `name`
 * (places/{placeId}/reviews/{id}), `rating`, `text`/`originalText`, `authorAttribution`,
 * `publishTime` and `googleMapsUri`. Env: GOOGLE_PLACES_API_KEY (same key as dfy/places.ts).
 * Unset → nothing is fetched. mapPlaceReviews is pure; fetchPlaceReviews does the I/O
 * (fetch injectable). Read-only — there is no Google Business Profile API access yet.
 */
import { isPlaceId, placesApiKey } from "@/server/services/dfy/places";

const PLACES_BASE = "https://places.googleapis.com/v1";
const TIMEOUT_MS = 8_000;
export const REVIEWS_FIELD_MASK = "reviews,rating,userRatingCount,googleMapsUri";

export interface FetchedReview {
  name: string;
  rating: number | null;
  text: string | null;
  author: string | null;
  publishedAt: string | null;
  googleMapsUri: string | null;
}

export interface FetchedPlaceReviews {
  rating: number | null;
  reviewCount: number | null;
  mapsUri: string | null;
  reviews: FetchedReview[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function localized(v: unknown): string | null {
  return v && typeof v === "object" ? str((v as Raw).text) : str(v);
}

/** PURE: the Places details body → our review shape (max 5, valid names only). */
export function mapPlaceReviews(raw: unknown): FetchedPlaceReviews {
  const body = raw && typeof raw === "object" ? (raw as Raw) : {};
  const reviews: FetchedReview[] = [];
  for (const r of Array.isArray(body.reviews) ? (body.reviews as Raw[]) : []) {
    const name = str(r?.name);
    if (!name || !/^places\/[A-Za-z0-9_-]+\/reviews\/[A-Za-z0-9_-]+$/.test(name)) continue;
    const rating = typeof r.rating === "number" && r.rating >= 1 && r.rating <= 5 ? Math.round(r.rating) : null;
    const published = str(r.publishTime);
    reviews.push({
      name,
      rating,
      text: localized(r.originalText) ?? localized(r.text),
      author: str(r.authorAttribution?.displayName),
      publishedAt: published && Number.isFinite(Date.parse(published)) ? new Date(published).toISOString() : null,
      googleMapsUri: str(r.googleMapsUri),
    });
  }
  return {
    rating: typeof body.rating === "number" ? body.rating : null,
    reviewCount: typeof body.userRatingCount === "number" ? body.userRatingCount : null,
    mapsUri: str(body.googleMapsUri),
    reviews: reviews.slice(0, 5),
  };
}

export interface ReviewFetchDeps {
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
}

/** Null when Places isn't configured or the id isn't a place id. Throws on an API failure. */
export async function fetchPlaceReviews(placeId: string, deps: ReviewFetchDeps = {}): Promise<FetchedPlaceReviews | null> {
  const apiKey = deps.apiKey === undefined ? placesApiKey() : deps.apiKey;
  if (!apiKey || !isPlaceId(placeId)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await (deps.fetchImpl ?? fetch)(`${PLACES_BASE}/places/${encodeURIComponent(placeId)}?languageCode=en&regionCode=CA`, {
      method: "GET",
      headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": REVIEWS_FIELD_MASK },
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const message = body && typeof body === "object" ? String((body as Raw).error?.message ?? "") : "";
      throw new Error(`Google Places ${response.status}${message ? `: ${message}` : ""}`);
    }
    return mapPlaceReviews(body);
  } finally {
    clearTimeout(timer);
  }
}

/** Where the owner replies to reviews (Google Business Profile). */
export const GBP_REVIEWS_URL = "https://business.google.com/reviews";
export const GBP_POSTS_URL = "https://business.google.com/posts";
