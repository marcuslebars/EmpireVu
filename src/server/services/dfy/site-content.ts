import { z } from "zod";

/**
 * Generated sites — the PURE half (docs/done-for-you.md → "Generated sites").
 *
 * Everything that decides what a company's hosted page says lives here, with no I/O:
 *   - the facts snapshot built from the company row, catalog and pack (`buildSiteFacts`);
 *   - mode selection (`chooseSiteMode`) and slug candidates (`siteSlugBase` / `slugCandidates`);
 *   - the deterministic template copy that is ALWAYS available (`templateSiteCopy`);
 *   - validation + fact-screening of model-written copy (`siteCopyModelSchema`, `screenSiteCopy`);
 *   - the versioned `company_sites.content` JSON (`SiteContent`) and its reader (`parseSiteContent`).
 *
 * Hard rule: nothing on the page is invented. Prices come only from catalog rows the owner
 * priced; ratings only from the Google facts we hold; AI copy only rephrases these facts and is
 * screened for claims (licences, insurance, years, guarantees, awards, prices, review quotes)
 * that don't appear in them — an offending field falls back to the template.
 */

export const SITE_CONTENT_VERSION = 1;

export const SITE_MODES = ["full", "price_page"] as const;
export type SiteMode = (typeof SITE_MODES)[number];

export const SITE_STATUSES = ["draft", "published", "unpublished"] as const;
export type SiteStatus = (typeof SITE_STATUSES)[number];

export interface SiteService {
  key: string;
  label: string;
  /** "$150", "$45 / visit", "From $300" — null means "Get a quote". Derived from catalog cents only. */
  priceText: string | null;
  /** "Minimum $150" when the catalog has a minimum above the rate. */
  priceNote: string | null;
  /** The owner's catalog description (may be empty). */
  description: string | null;
}

export interface OpeningHoursSpec {
  /** schema.org day names: Monday … Sunday. */
  days: string[];
  opens: string;
  closes: string;
}

export interface SiteFacts {
  name: string;
  phoneE164: string | null;
  phoneDisplay: string | null;
  serviceArea: string | null;
  hoursLines: string[];
  openingHours: OpeningHoursSpec[];
  rating: number | null;
  reviewCount: number | null;
  reviewUrl: string | null;
  mapsUrl: string | null;
  website: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  tradeId: string | null;
  tradeLabel: string | null;
  tagline: string | null;
  about: string | null;
  highlights: string[];
  photos: string[];
  services: SiteService[];
  bookingEnabled: boolean;
  brand: "crankleads" | "empirevu";
  address: string | null;
}

export interface SiteFaq {
  question: string;
  answer: string;
}

export interface SiteCopy {
  headline: string;
  subhead: string;
  about: string;
  faqs: SiteFaq[];
  /** service key → one-line blurb. */
  serviceBlurbs: Record<string, string>;
}

export interface SiteEdits {
  headline?: string | null;
  subhead?: string | null;
  about?: string | null;
}

export interface SiteSettings {
  showPrices: boolean;
}

export type CopySource = "ai" | "template" | "mixed";

export interface SiteContent {
  version: typeof SITE_CONTENT_VERSION;
  mode: SiteMode;
  facts: SiteFacts;
  /** Which facts were non-empty and handed to the copywriter (audit of "what did we say and why"). */
  factsUsed: string[];
  copy: SiteCopy;
  copySource: CopySource;
  /** Why some or all copy fell back to the template (empty when the model's copy passed). */
  copyNotes: string[];
  edits: SiteEdits;
  settings: SiteSettings;
  generatedAt: string;
}

// ── Small helpers ────────────────────────────────────────────────────────────

function clean(value: unknown, max = 2000): string | null {
  if (typeof value !== "string") return null;
  const v = value.replace(/\s+/g, " ").trim();
  return v ? v.slice(0, max) : null;
}

function httpsUrl(value: unknown): string | null {
  const v = clean(value, 2000);
  if (!v) return null;
  try {
    const url = new URL(v);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** A website as a usable http(s) URL ("example.com" → https://example.com/), else null. */
export function normalizeWebsite(value: unknown): string | null {
  const v = clean(value, 2000);
  if (!v) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function hexColor(value: unknown): string | null {
  const v = clean(value, 20);
  if (!v) return null;
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) {
    return `#${v
      .slice(1)
      .split("")
      .map((c) => c + c)
      .join("")}`.toLowerCase();
  }
  return null;
}

/** +17055550123 → (705) 555-0123; other numbers are shown as stored. */
export function formatPhoneDisplay(e164: string | null): string | null {
  if (!e164) return null;
  const digits = e164.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits.length === 10 ? digits : null;
  if (!national) return e164.trim() || null;
  return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
}

/** Cents → "$150", "$1,250", "$45.50". */
export function formatCents(cents: number): string {
  const dollars = cents / 100;
  const whole = Number.isInteger(dollars);
  return `$${dollars.toLocaleString("en-CA", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

// ── Catalog → priced services ────────────────────────────────────────────────

export interface CatalogItemFacts {
  service_key: string;
  label: string;
  description: string | null;
  pricing_type: string;
  rate_cents: number;
  minimum_cents: number;
  unit_label: string | null;
  sort_order?: number | null;
}

/**
 * The price line for one catalog row, from its cents only. Pricing shapes we can't state in one
 * honest line (tiered, banded, declining) show "From <minimum>" when there is a minimum, else
 * "Get a quote". A zero rate is "not priced yet" (packs install services without prices).
 */
export function servicePrice(item: CatalogItemFacts): { priceText: string | null; priceNote: string | null } {
  const rate = Number.isFinite(item.rate_cents) ? Math.max(0, Math.round(item.rate_cents)) : 0;
  const min = Number.isFinite(item.minimum_cents) ? Math.max(0, Math.round(item.minimum_cents)) : 0;
  const unit = clean(item.unit_label, 40);
  const minNote = min > rate && rate > 0 ? `Minimum ${formatCents(min)}` : null;
  switch (item.pricing_type) {
    case "flat":
      if (rate > 0) return { priceText: formatCents(rate), priceNote: minNote };
      return { priceText: min > 0 ? `From ${formatCents(min)}` : null, priceNote: null };
    case "per_unit":
    case "per_measure":
      if (rate > 0) return { priceText: `${formatCents(rate)} / ${unit ?? (item.pricing_type === "per_unit" ? "each" : "unit")}`, priceNote: minNote };
      return { priceText: min > 0 ? `From ${formatCents(min)}` : null, priceNote: null };
    default:
      return { priceText: min > 0 ? `From ${formatCents(min)}` : null, priceNote: null };
  }
}

// ── Hours ────────────────────────────────────────────────────────────────────

const DAY_ALIASES: Record<string, number> = {
  mon: 0, monday: 0,
  tue: 1, tues: 1, tuesday: 1,
  wed: 2, wednesday: 2,
  thu: 3, thur: 3, thurs: 3, thursday: 3,
  fri: 4, friday: 4,
  sat: 5, saturday: 5,
  sun: 6, sunday: 6,
};
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function hhmm(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? "0");
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 24 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function displayTime(value: string): string {
  const [hs, ms] = value.split(":");
  const h = Number(hs);
  const suffix = h >= 12 && h < 24 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return ms === "00" ? `${h12}${suffix}` : `${h12}:${ms}${suffix}`;
}

/**
 * companies.hours → display lines + structured specs (JSON-LD only gets structured hours).
 * Shapes seen: the wizard's `{ summary }` / `{ text }`, per-day `{ mon: { open, close } | "closed" }`
 * (optionally under `days`), and Google's `weekdayText` / `weekday_text` lines.
 */
export function parseHours(raw: unknown): { lines: string[]; specs: OpeningHoursSpec[] } {
  if (!raw) return { lines: [], specs: [] };
  if (Array.isArray(raw)) {
    return { lines: raw.map((v) => clean(v, 120)).filter((v): v is string => Boolean(v)).slice(0, 10), specs: [] };
  }
  if (typeof raw === "string") {
    const line = clean(raw, 300);
    return { lines: line ? [line] : [], specs: [] };
  }
  if (typeof raw !== "object") return { lines: [], specs: [] };
  const record = raw as Record<string, unknown>;
  for (const key of ["weekdayText", "weekday_text", "lines"]) {
    if (Array.isArray(record[key])) return parseHours(record[key]);
  }
  for (const key of ["summary", "text"]) {
    const line = clean(record[key], 300);
    if (line) return { lines: [line], specs: [] };
  }
  const days = record.days && typeof record.days === "object" && !Array.isArray(record.days) ? (record.days as Record<string, unknown>) : record;

  const perDay: Array<{ open: string; close: string } | "closed" | null> = Array(7).fill(null);
  for (const [key, value] of Object.entries(days)) {
    const idx = DAY_ALIASES[key.trim().toLowerCase()];
    if (idx === undefined) continue;
    if (value === null || value === false || (typeof value === "string" && /closed/i.test(value))) {
      perDay[idx] = "closed";
      continue;
    }
    if (value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      if (v.closed === true) {
        perDay[idx] = "closed";
        continue;
      }
      const open = hhmm(v.open ?? v.opens ?? v.start);
      const close = hhmm(v.close ?? v.closes ?? v.end);
      if (open && close) perDay[idx] = { open, close };
      continue;
    }
    if (typeof value === "string") {
      const m = value.match(/^\s*([\d:apm\s]+?)\s*[-–to]+\s*([\d:apm\s]+)\s*$/i);
      const open = m ? hhmm(m[1]) : null;
      const close = m ? hhmm(m[2]) : null;
      if (open && close) perDay[idx] = { open, close };
    }
  }
  if (perDay.every((d) => d === null)) return { lines: [], specs: [] };

  // Group consecutive days with identical hours: "Mon–Fri 8am–5pm", "Sat 9am–1pm", "Sun Closed".
  const lines: string[] = [];
  const specs: OpeningHoursSpec[] = [];
  let i = 0;
  while (i < 7) {
    const cur = perDay[i];
    let j = i;
    while (j + 1 < 7 && JSON.stringify(perDay[j + 1]) === JSON.stringify(cur)) j += 1;
    if (cur !== null) {
      const label = i === j ? DAY_SHORT[i] : `${DAY_SHORT[i]}–${DAY_SHORT[j]}`;
      if (cur === "closed") {
        lines.push(`${label}: Closed`);
      } else {
        lines.push(`${label}: ${displayTime(cur.open)}–${displayTime(cur.close)}`);
        specs.push({ days: DAY_NAMES.slice(i, j + 1), opens: cur.open, closes: cur.close });
      }
    }
    i = j + 1;
  }
  return { lines, specs };
}

// ── Trade ────────────────────────────────────────────────────────────────────

export interface TradeProfile {
  /** What the business does, as a noun phrase for headlines. */
  noun: string;
  /** schema.org type for JSON-LD. */
  schemaType: string;
  primary: string;
  accent: string;
  /** Layout variant: "bold" = full-colour hero band, "plain" = light hero with a colour rail. */
  variant: "bold" | "plain";
}

const TRADES: Record<string, TradeProfile> = {
  "property-maintenance-snow": { noun: "Snow removal and property maintenance", schemaType: "HomeAndConstructionBusiness", primary: "#0f3d63", accent: "#f28c28", variant: "bold" },
  roofing: { noun: "Roofing", schemaType: "RoofingContractor", primary: "#2b2f33", accent: "#b23a2b", variant: "plain" },
  landscaping: { noun: "Landscaping and lawn care", schemaType: "HomeAndConstructionBusiness", primary: "#1f4d36", accent: "#d9a520", variant: "plain" },
  "hvac-plumbing": { noun: "Heating, cooling and plumbing", schemaType: "HVACBusiness", primary: "#0b4f8a", accent: "#d7263d", variant: "bold" },
  marine: { noun: "Marine service", schemaType: "LocalBusiness", primary: "#0d3b66", accent: "#e9b949", variant: "bold" },
  "general-contractor": { noun: "Renovations and general contracting", schemaType: "GeneralContractor", primary: "#33363a", accent: "#e8a317", variant: "plain" },
};

const DEFAULT_TRADE: TradeProfile = { noun: "Local service", schemaType: "LocalBusiness", primary: "#23395b", accent: "#e07a1f", variant: "plain" };

export function tradeProfile(tradeId: string | null): TradeProfile {
  return (tradeId && TRADES[tradeId]) || DEFAULT_TRADE;
}

// ── Facts ────────────────────────────────────────────────────────────────────

export interface SiteFactsInput {
  company: {
    name: string;
    owner_phone_e164: string | null;
    service_area: string | null;
    hours: unknown;
    google_rating: number | null;
    google_review_count: number | null;
    google_place_id: string | null;
    brand_review_url: string | null;
    website: string | null;
    brand_logo_url: string | null;
    brand_primary_color: string | null;
    brand_accent_color: string | null;
    business_address: string | null;
    profile: unknown;
  };
  catalog: CatalogItemFacts[];
  trade: { id: string; name: string } | null;
  bookingEnabled: boolean;
  brand: "crankleads" | "empirevu";
}

const MAX_SERVICES = 24;

export function googleMapsUrl(placeId: string | null): string | null {
  const id = clean(placeId, 300);
  return id ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(id)}` : null;
}

export function buildSiteFacts(input: SiteFactsInput): SiteFacts {
  const c = input.company;
  const profile = c.profile && typeof c.profile === "object" && !Array.isArray(c.profile) ? (c.profile as Record<string, unknown>) : {};
  const hours = parseHours(c.hours);
  const rating = typeof c.google_rating === "number" && c.google_rating > 0 && c.google_rating <= 5 ? Math.round(c.google_rating * 10) / 10 : null;
  const reviewCount = typeof c.google_review_count === "number" && c.google_review_count > 0 ? Math.round(c.google_review_count) : null;
  const phoneE164 = clean(c.owner_phone_e164, 20);

  const seen = new Set<string>();
  const services: SiteService[] = [];
  for (const item of [...input.catalog].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))) {
    const label = clean(item.label, 120);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    services.push({ key: item.service_key, label, ...servicePrice(item), description: clean(item.description, 300) });
    if (services.length >= MAX_SERVICES) break;
  }

  return {
    name: clean(c.name, 120) ?? "Our business",
    phoneE164,
    phoneDisplay: formatPhoneDisplay(phoneE164),
    serviceArea: clean(c.service_area, 300),
    hoursLines: hours.lines,
    openingHours: hours.specs,
    rating: rating && reviewCount ? rating : null,
    reviewCount: rating && reviewCount ? reviewCount : null,
    reviewUrl: httpsUrl(c.brand_review_url),
    mapsUrl: googleMapsUrl(c.google_place_id),
    website: normalizeWebsite(c.website),
    logoUrl: httpsUrl(c.brand_logo_url),
    primaryColor: hexColor(c.brand_primary_color),
    accentColor: hexColor(c.brand_accent_color),
    tradeId: input.trade?.id ?? null,
    tradeLabel: input.trade?.name ?? null,
    tagline: clean(profile.tagline, 140),
    about: clean(profile.about, 1200),
    highlights: Array.isArray(profile.highlights)
      ? profile.highlights.map((h) => clean(h, 140)).filter((h): h is string => Boolean(h)).slice(0, 6)
      : [],
    photos: Array.isArray(profile.photos)
      ? profile.photos
          .map((p) => httpsUrl(typeof p === "string" ? p : p && typeof p === "object" ? (p as Record<string, unknown>).url : null))
          .filter((p): p is string => Boolean(p))
          .slice(0, 6)
      : [],
    services,
    bookingEnabled: input.bookingEnabled,
    brand: input.brand,
    address: clean(c.business_address, 300),
  };
}

/** Names of the facts we actually have (stored on the content as `factsUsed`). */
export function factsUsed(facts: SiteFacts): string[] {
  const used: string[] = ["name"];
  if (facts.phoneE164) used.push("phone");
  if (facts.serviceArea) used.push("serviceArea");
  if (facts.hoursLines.length) used.push("hours");
  if (facts.rating) used.push("googleRating");
  if (facts.reviewUrl) used.push("reviewUrl");
  if (facts.mapsUrl) used.push("googlePlace");
  if (facts.website) used.push("website");
  if (facts.logoUrl) used.push("logo");
  if (facts.tradeId) used.push("trade");
  if (facts.tagline) used.push("tagline");
  if (facts.about) used.push("about");
  if (facts.highlights.length) used.push("highlights");
  if (facts.photos.length) used.push("photos");
  if (facts.services.length) used.push("services");
  if (facts.services.some((s) => s.priceText)) used.push("prices");
  if (facts.bookingEnabled) used.push("onlineBooking");
  if (facts.address) used.push("address");
  return used;
}

/** The facts JSON handed to the copywriter. NO prices (it never needs them, so it can't misquote them). */
export function copywriterFacts(facts: SiteFacts, mode: SiteMode): Record<string, unknown> {
  return {
    mode,
    businessName: facts.name,
    trade: facts.tradeLabel,
    phone: facts.phoneDisplay,
    serviceArea: facts.serviceArea,
    hours: facts.hoursLines,
    tagline: facts.tagline,
    ownerAbout: facts.about,
    highlights: facts.highlights,
    services: facts.services.map((s) => ({ key: s.key, name: s.label, description: s.description, hasListedPrice: Boolean(s.priceText) })),
    onlineBooking: facts.bookingEnabled,
    hasGoogleReviews: Boolean(facts.rating),
    hasMainWebsite: Boolean(facts.website),
  };
}

// ── Mode + slug ──────────────────────────────────────────────────────────────

/** 'price_page' when they already have a website (we're their prices + booking page), else 'full'. */
export function chooseSiteMode(website: string | null | undefined): SiteMode {
  return normalizeWebsite(website) ? "price_page" : "full";
}

/** Paths that a slug can't take (they'd shadow a route on the pages host). */
export const RESERVED_SLUGS = new Set([
  "api", "s", "r", "f", "q", "i", "p", "v", "book", "setup", "embed", "admin", "www", "app", "index",
  "login", "signin", "settings", "static", "assets", "brand", "robots", "sitemap", "favicon", "internal",
]);

const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,60}[a-z0-9])?$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug);
}

/** "Côté Déneigement & Fils Inc." → "cote-deneigement-fils". URL-safe, ≤ 48 chars, never reserved. */
export function siteSlugBase(name: string): string {
  let base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(inc|ltd|llc|corp|co|limited|incorporated)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base.length > 48) {
    base = base.slice(0, 48);
    const cut = base.lastIndexOf("-");
    if (cut > 20) base = base.slice(0, cut);
    base = base.replace(/-+$/g, "");
  }
  base = base.replace(/-and$/, "");
  if (!base) base = "business";
  if (RESERVED_SLUGS.has(base)) base = `${base}-co`;
  return base;
}

/** base, base-2, base-3, … (all valid slugs). */
export function slugCandidates(base: string, count = 30): string[] {
  const out = [base];
  for (let n = 2; out.length < count; n += 1) out.push(`${base}-${n}`);
  return out.filter(isValidSlug);
}

// ── Template copy (always available; generation never blocks on the model) ──

function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

function listPhrase(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function templateFaqs(facts: SiteFacts): SiteFaq[] {
  const faqs: SiteFaq[] = [];
  const call = facts.phoneDisplay ? ` or call ${facts.phoneDisplay}` : "";
  const priced = facts.services.some((s) => s.priceText);
  faqs.push({
    question: "How do I get a quote?",
    answer: `Send a request with the form on this page${call}. Tell us what you need and where, and we'll get back to you with a price.`,
  });
  faqs.push({
    question: "How much does it cost?",
    answer: priced
      ? "Prices for our regular services are listed on this page. For anything else, send a request and we'll price the job for you."
      : `Every job is a bit different, so we price each one for you. Send a request${call} and we'll give you a price.`,
  });
  if (facts.serviceArea) {
    faqs.push({ question: "What areas do you serve?", answer: `We serve ${facts.serviceArea}. Not sure if you're in our area? Just ask.` });
  }
  if (facts.hoursLines.length) {
    faqs.push({ question: "What are your hours?", answer: `${facts.hoursLines.join(". ")}.`.replace(/\.\.$/, ".") });
  }
  if (facts.bookingEnabled) {
    faqs.push({ question: "Can I book online?", answer: "Yes. Tap \"Book online\" to pick a time that works for you." });
  }
  if (faqs.length < 5 && facts.services.length) {
    const names = facts.services.slice(0, 5).map((s) => lowerFirst(s.label));
    faqs.push({ question: "What services do you offer?", answer: `${listPhrase(names)[0].toUpperCase()}${listPhrase(names).slice(1)}${facts.services.length > 5 ? ", and more" : ""}.` });
  }
  if (faqs.length < 3) {
    faqs.push({
      question: "How do I reach you?",
      answer: facts.phoneDisplay ? `Call or text ${facts.phoneDisplay}, or use the form on this page.` : "Use the form on this page and we'll get back to you.",
    });
  }
  return faqs.slice(0, 5);
}

export function templateSiteCopy(facts: SiteFacts, mode: SiteMode): SiteCopy {
  const trade = tradeProfile(facts.tradeId);
  const noun = facts.tradeId ? trade.noun : null;
  const area = facts.serviceArea && facts.serviceArea.length <= 48 ? facts.serviceArea : null;

  let headline: string;
  if (mode === "price_page") {
    headline = facts.services.some((s) => s.priceText)
      ? "Our services and prices"
      : noun && area
        ? `${noun} in ${area}`
        : noun
          ? `${noun} services`
          : "Our services";
  } else if (facts.tagline && facts.tagline.length <= 80) {
    headline = facts.tagline;
  } else if (noun) {
    headline = area ? `${noun} in ${area}` : noun;
  } else {
    headline = area ? `Serving ${area}` : facts.name;
  }

  const parts: string[] = [];
  if (mode === "price_page") parts.push(`${facts.name}${area && !headline.includes(area) ? `, serving ${area}` : ""}.`);
  else if (area && !headline.includes(area)) parts.push(`Serving ${area}.`);
  parts.push(facts.phoneDisplay ? `Call ${facts.phoneDisplay} or ask for a quote online.` : "Ask for a quote online and we'll get back to you.");
  if (facts.bookingEnabled) parts.push("You can also book a time online.");
  const subhead = parts.join(" ");

  let about: string;
  if (facts.about) {
    about = facts.about.length > 600 ? `${facts.about.slice(0, 597).replace(/\s+\S*$/, "")}…` : facts.about;
  } else if (facts.services.length) {
    const names = facts.services.slice(0, 3).map((s) => lowerFirst(s.label));
    about = `${facts.name} handles ${listPhrase(names)}${facts.services.length > 3 ? " and more" : ""}${area ? ` in ${area}` : ""}. Tell us about the job and we'll give you a price.`;
  } else {
    about = area ? `${facts.name} serves ${area}. Tell us what you need and we'll give you a price.` : `Tell us what you need and ${facts.name} will give you a price.`;
  }

  const serviceBlurbs: Record<string, string> = {};
  for (const s of facts.services) if (s.description) serviceBlurbs[s.key] = s.description.length > 140 ? `${s.description.slice(0, 137).replace(/\s+\S*$/, "")}…` : s.description;

  return { headline, subhead, about, faqs: templateFaqs(facts), serviceBlurbs };
}

// ── Model copy: schema + fact screening ──────────────────────────────────────

export const siteCopyModelSchema = z.object({
  headline: z.string().trim().min(3).max(90),
  subhead: z.string().trim().min(3).max(220),
  about: z.string().trim().min(20).max(700),
  serviceBlurbs: z
    .array(z.object({ key: z.string().min(1).max(80), blurb: z.string().trim().min(3).max(160) }))
    .max(40)
    .default([]),
  faqs: z
    .array(z.object({ question: z.string().trim().min(5).max(140), answer: z.string().trim().min(5).max(450) }))
    .min(3)
    .max(5),
});

export type SiteCopyModelOutput = z.infer<typeof siteCopyModelSchema>;

/** JSON schema handed to the API's structured-output mode (mirrors siteCopyModelSchema). */
export const SITE_COPY_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "subhead", "about", "serviceBlurbs", "faqs"],
  properties: {
    headline: { type: "string", description: "Hero headline, at most 70 characters." },
    subhead: { type: "string", description: "One or two short sentences under the headline, at most 200 characters." },
    about: { type: "string", description: "Short about paragraph, 2-4 sentences, at most 600 characters." },
    serviceBlurbs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "blurb"],
        properties: { key: { type: "string" }, blurb: { type: "string", description: "One line, at most 120 characters." } },
      },
    },
    faqs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "answer"],
        properties: { question: { type: "string" }, answer: { type: "string" } },
      },
    },
  },
};

/**
 * Claims the copy may only make when the same words are in the facts. Each pattern is matched
 * case-insensitively; a hit whose matched text isn't in the facts text rejects that field.
 */
const CLAIM_PATTERNS: RegExp[] = [
  /\blicen[cs]ed?\b/gi,
  /\b(fully\s+)?insured\b|\binsurance\b/gi,
  /\bbonded\b/gi,
  /\bguarantee[ds]?\b/gi,
  /\bwarrant(y|ies)\b/gi,
  /\bcertifi(ed|cation|cations)\b/gi,
  /\baccredited\b/gi,
  /\baward[- ]?winning\b|\bawards?\b/gi,
  /\b(family|locally)[- ]owned\b/gi,
  /\b\d+\+?\s*(years?|yrs)\b/gi,
  /\bdecades?\b/gi,
  /\bsince\s+\d{4}\b/gi,
  /\b(19|20)\d{2}\b/gi,
  /\$\s?\d[\d,]*(\.\d+)?/g,
  /\b\d+(\.\d)?[- ]?stars?\b/gi,
  /\bfive[- ]star\b/gi,
  /#\s?1\b|\bnumber one\b|\bbest in\b|\btop[- ]rated\b|\bhighest[- ]rated\b/gi,
  /\b24\/7\b|\b24 hours\b|\baround the clock\b/gi,
  /\bfree (quotes?|estimates?)\b/gi,
  /\bsame[- ]day\b/gi,
  /\bemergency\b/gi,
  /\bcheapest\b|\blowest prices?\b/gi,
  /\b(customers|clients|reviews?) (say|love|rave)\b/gi,
  /“|”|"[^"]{12,}"/g,
];

export function factsText(facts: SiteFacts): string {
  return [
    facts.name,
    facts.phoneDisplay,
    facts.phoneE164,
    facts.serviceArea,
    ...facts.hoursLines,
    facts.tagline,
    facts.about,
    ...facts.highlights,
    facts.tradeLabel,
    facts.address,
    ...facts.services.flatMap((s) => [s.label, s.description]),
  ]
    .filter(Boolean)
    .join(" \n ")
    .toLowerCase();
}

/** The unsupported claims in `text` (empty = clean). */
export function unsupportedClaims(text: string, facts: SiteFacts, known: string = factsText(facts)): string[] {
  const hits: string[] = [];
  for (const pattern of CLAIM_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const found = match[0].toLowerCase().trim();
      // A quote mark can't be "in the facts"; everything else is allowed when the facts say it.
      if (found === "“" || found === "”" || found.startsWith('"') || !known.includes(found)) hits.push(match[0]);
    }
  }
  return hits;
}

const US_TO_CA: Array<[RegExp, string]> = [
  [/\bcolor/g, "colour"], [/\bColor/g, "Colour"],
  [/\bneighbor/g, "neighbour"], [/\bNeighbor/g, "Neighbour"],
  [/\bfavorite/g, "favourite"], [/\bFavorite/g, "Favourite"],
  [/\bcenter\b/g, "centre"], [/\bCenter\b/g, "Centre"],
  [/\bcenters\b/g, "centres"],
  [/\blabor\b/g, "labour"], [/\bLabor\b/g, "Labour"],
  [/\bhonor/g, "honour"], [/\bbehavior/g, "behaviour"],
  [/\bmeter\b/g, "metre"], [/\bmeters\b/g, "metres"], [/\bcanceled\b/g, "cancelled"], [/\bcanceling\b/g, "cancelling"],
  [/\bgray\b/g, "grey"], [/\bGray\b/g, "Grey"],
];

export function canadianSpelling(text: string): string {
  let out = text;
  for (const [re, to] of US_TO_CA) out = out.replace(re, to);
  return out;
}

export interface ScreenedCopy {
  copy: SiteCopy;
  source: CopySource;
  notes: string[];
}

/**
 * Merge model copy over the template field by field: a field that fails screening (or is
 * missing) keeps the template's version, and the reason is recorded. Service blurbs for keys
 * we don't have are dropped; FAQs that fail are dropped and the template's fill the gap.
 */
export function screenSiteCopy(model: SiteCopyModelOutput, facts: SiteFacts, mode: SiteMode): ScreenedCopy {
  const template = templateSiteCopy(facts, mode);
  const known = factsText(facts);
  const notes: string[] = [];
  let used = 0;
  let replaced = 0;

  const pick = (field: "headline" | "subhead" | "about"): string => {
    const value = canadianSpelling(model[field].replace(/\s+/g, " ").trim());
    const claims = unsupportedClaims(value, facts, known);
    if (claims.length) {
      notes.push(`${field}: unsupported ${claims.slice(0, 3).join(", ")}`);
      replaced += 1;
      return template[field];
    }
    used += 1;
    return value;
  };

  const headline = pick("headline");
  const subhead = pick("subhead");
  const about = pick("about");

  const keys = new Set(facts.services.map((s) => s.key));
  const serviceBlurbs: Record<string, string> = { ...template.serviceBlurbs };
  for (const { key, blurb } of model.serviceBlurbs) {
    if (!keys.has(key)) continue;
    const value = canadianSpelling(blurb.replace(/\s+/g, " ").trim());
    const claims = unsupportedClaims(value, facts, known);
    if (claims.length) {
      notes.push(`service ${key}: unsupported ${claims.slice(0, 3).join(", ")}`);
      replaced += 1;
      continue;
    }
    serviceBlurbs[key] = value;
    used += 1;
  }

  const faqs: SiteFaq[] = [];
  for (const faq of model.faqs) {
    const q = canadianSpelling(faq.question.trim());
    const a = canadianSpelling(faq.answer.trim());
    const claims = unsupportedClaims(`${q} ${a}`, facts, known);
    if (claims.length) {
      notes.push(`faq "${q.slice(0, 40)}": unsupported ${claims.slice(0, 3).join(", ")}`);
      replaced += 1;
      continue;
    }
    faqs.push({ question: q, answer: a });
    used += 1;
  }
  for (const faq of template.faqs) {
    if (faqs.length >= 3) break;
    if (!faqs.some((f) => f.question.toLowerCase() === faq.question.toLowerCase())) faqs.push(faq);
  }

  const source: CopySource = replaced === 0 ? "ai" : used === 0 ? "template" : "mixed";
  return { copy: { headline, subhead, about, faqs: faqs.slice(0, 5), serviceBlurbs }, source, notes };
}

// ── Content JSON ─────────────────────────────────────────────────────────────

export const siteEditsSchema = z.object({
  headline: z.string().trim().max(90).nullable().optional(),
  subhead: z.string().trim().max(220).nullable().optional(),
  about: z.string().trim().max(1200).nullable().optional(),
});

/** Read company_sites.content defensively. Null when it isn't a v1 document we can render. */
export function parseSiteContent(raw: unknown): SiteContent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Partial<SiteContent>;
  if (c.version !== SITE_CONTENT_VERSION || !c.facts || !c.copy) return null;
  return {
    version: SITE_CONTENT_VERSION,
    mode: c.mode === "price_page" ? "price_page" : "full",
    facts: c.facts,
    factsUsed: Array.isArray(c.factsUsed) ? c.factsUsed : [],
    copy: { ...c.copy, faqs: Array.isArray(c.copy.faqs) ? c.copy.faqs : [], serviceBlurbs: c.copy.serviceBlurbs ?? {} },
    copySource: c.copySource ?? "template",
    copyNotes: Array.isArray(c.copyNotes) ? c.copyNotes : [],
    edits: c.edits && typeof c.edits === "object" ? c.edits : {},
    settings: { showPrices: c.settings?.showPrices !== false },
    generatedAt: typeof c.generatedAt === "string" ? c.generatedAt : "",
  };
}

/** Copy with the owner's edits applied (an empty edit means "use the generated text"). */
export function effectiveCopy(content: SiteContent): SiteCopy {
  const e = content.edits ?? {};
  const pickEdit = (v: string | null | undefined, fallback: string) => (typeof v === "string" && v.trim() ? v.trim() : fallback);
  return {
    ...content.copy,
    headline: pickEdit(e.headline, content.copy.headline),
    subhead: pickEdit(e.subhead, content.copy.subhead),
    about: pickEdit(e.about, content.copy.about),
  };
}
