/**
 * Platform brand — the ONE source of truth for which product name, logo, favicon and
 * accent a tenant's OWN people (owner + staff) see. Shared by the SPA and the server.
 *
 * Everdoer rebrand PR 2: there is ONE platform brand, Everdoer, for every org, every host and
 * every signed-out page (REBRAND_PLAN.md §1.1, D3). What used to be "the brand" also carried the
 * PRODUCT LINE (standard vs done-for-you; src/lib/product-line.ts), and some behaviour still
 * follows that (receptionistCopy, plan copy, the done-for-you app origin). So PLATFORM_BRANDS
 * keeps both keys: each entry has the same Everdoer display config, plus `key` (the old stored
 * platform_brand value, still the wire value in session context until PR 7) and `productLine`.
 * Behaviour must branch on `productLine` (isDoneForYouBrand), never on `key` or `name`.
 *
 * Customer-facing pages (quotes, invoices, forms, booking) are branded from the COMPANY, not
 * from this — a tenant's customers see no platform name.
 *
 * Browser-safe: no `process.env` here, and no hard-coded app hosts. Server-side origins (app
 * base URL, from env) live in src/server/services/platform-brand.ts.
 */

import { productLineForOrg, type ProductLine } from "./product-line";

/** Old platform_brand values (the product line under its pre-Phase 3 names). Not display names. */
export const PLATFORM_BRAND_KEYS = ["empirevu", "crankleads"] as const;
export type PlatformBrandKey = (typeof PLATFORM_BRAND_KEYS)[number];

export const DEFAULT_PLATFORM_BRAND: PlatformBrandKey = "empirevu";

export interface PlatformBrandTheme {
  /** Hex accent used in emails / Stripe Checkout (the SPA uses the index.css tokens). */
  accentHex: string;
  /** Hex text colour that reads on the accent. */
  onAccentHex: string;
  backgroundHex: string;
}

export interface PlatformBrand {
  /**
   * The org's stored platform_brand value ('empirevu' standard / 'crankleads' done-for-you).
   * Kept for wire compatibility (session context, intake links). Do NOT branch behaviour on it:
   * use `productLine`.
   */
  key: PlatformBrandKey;
  /** The org's product line: what behaviour (AI receptionist copy, plan copy, links) follows. */
  productLine: ProductLine;
  /** Product name shown to the tenant's own people. */
  name: string;
  /** Full wordmark (sits on the app's dark surfaces). */
  logoSrc: string;
  /** Intrinsic size of the wordmark file (for aspect-correct <img>). */
  logoWidth: number;
  logoHeight: number;
  /** Square mark (collapsed sidebar). */
  markSrc: string;
  /** Browser-tab icon. */
  faviconHref: string;
  faviconType: string;
  /** PNG tab icon (browsers without SVG favicons). */
  faviconPngHref: string;
  /** PNG icon for apple-touch / browsers without SVG favicons. */
  appleTouchIconHref: string;
  /** Where owners write in for help (shown in copy; replies come from a person). */
  supportEmail: string;
  theme: PlatformBrandTheme;
}

/** Everdoer brand colours (brand kit, public/brand/everdoer/README.txt). */
export const EVERDOER_COLORS = {
  lime: "#A6EE2B",
  nearBlack: "#0C0E12",
  offWhite: "#F4F4F1",
  /** Lime for text/marks on WHITE surfaces (plain lime fails contrast there). */
  deepLime: "#4F8A00",
} as const;

/** The one platform brand's display config (everything but key / productLine). */
export const EVERDOER_BRAND: Omit<PlatformBrand, "key" | "productLine"> = {
  name: "Everdoer",
  logoSrc: "/brand/everdoer/everdoer-logo-on-dark.svg",
  // Intrinsic size from the SVG: viewBox="0 0 892.3 265.0" width="892" height="265".
  logoWidth: 892,
  logoHeight: 265,
  markSrc: "/brand/everdoer/everdoer-icon.svg",
  faviconHref: "/favicon.svg",
  faviconType: "image/svg+xml",
  faviconPngHref: "/brand/everdoer/favicon-32.png",
  appleTouchIconHref: "/apple-touch-icon.png",
  supportEmail: "hello@everdoer.com",
  theme: {
    accentHex: EVERDOER_COLORS.lime,
    onAccentHex: EVERDOER_COLORS.nearBlack,
    backgroundHex: EVERDOER_COLORS.nearBlack,
  },
};

export const PLATFORM_BRANDS: Record<PlatformBrandKey, PlatformBrand> = {
  empirevu: { ...EVERDOER_BRAND, key: "empirevu", productLine: "standard" },
  crankleads: { ...EVERDOER_BRAND, key: "crankleads", productLine: "done_for_you" },
};

/** The brand entry for a product line (same Everdoer display config either way). */
export function brandForProductLine(line: ProductLine): PlatformBrand {
  return line === "done_for_you" ? PLATFORM_BRANDS.crankleads : PLATFORM_BRANDS.empirevu;
}

/** Behaviour switch: is this the done-for-you product line? */
export function isDoneForYouBrand(brand: Pick<PlatformBrand, "productLine">): boolean {
  return brand.productLine === "done_for_you";
}

/**
 * The AI receptionist's name in the app. A PRODUCT-LINE difference, not a brand one: standard
 * tenants (A1 etc.) know her as "Marina"; done-for-you owners never see that name — it's "the AI
 * receptionist" for them.
 */
export function receptionistName(brand: Pick<PlatformBrand, "productLine">): string {
  return isDoneForYouBrand(brand) ? "AI receptionist" : "Marina";
}

/**
 * Rewrite a "Marina" UI string for the product line: unchanged for standard tenants; for
 * done-for-you, "Call with Marina" → "Call with the AI receptionist", "Voice (Marina)" → "Voice (AI
 * receptionist)", "Marina call" → "AI receptionist call", a sentence-initial "Marina" → "The AI
 * receptionist". Only pass strings that name the agent (not business names like "Bayview
 * Marina"). PURE.
 */
export function receptionistCopy(text: string, brand: Pick<PlatformBrand, "productLine">): string {
  if (!isDoneForYouBrand(brand)) return text;
  return text
    .replace(/\(Marina\)/g, "(AI receptionist)")
    .replace(/\bMarina reception\b/g, "AI receptionist")
    .replace(/\bMarina (call|calls|minutes|number|voice reception)\b/g, "AI receptionist $1")
    .replace(/(^|[.!?]\s+)Marina's\b/g, "$1The AI receptionist's")
    .replace(/(^|[.!?]\s+)Marina\b/g, "$1The AI receptionist")
    .replace(/\bMarina's\b/g, "the AI receptionist's")
    .replace(/\bMarina\b/g, "the AI receptionist")
    .replace(/\bthe the AI\b/g, "the AI");
}

export function isPlatformBrandKey(value: unknown): value is PlatformBrandKey {
  return typeof value === "string" && (PLATFORM_BRAND_KEYS as readonly string[]).includes(value);
}

/**
 * The brand entry for a stored platform_brand value, old ('empirevu' / 'crankleads') or Phase 3
 * ('standard' / 'done_for_you'). Unknown / missing values fall back to the standard line.
 */
export function platformBrand(key: unknown): PlatformBrand {
  if (isPlatformBrandKey(key)) return PLATFORM_BRANDS[key];
  return brandForProductLine(productLineForOrg(typeof key === "string" ? { platform_brand: key } : null));
}

/**
 * The brand entry for an organization: always Everdoer; its `productLine` follows
 * productLineForOrg (platform_brand is authoritative; a done-for-you tier with no platform_brand,
 * e.g. a partial select, is still done-for-you).
 */
export function brandForOrg(
  org: Parameters<typeof productLineForOrg>[0],
): PlatformBrand {
  // Product-line shim (src/lib/product-line.ts): the stored value may be old ('crankleads' /
  // 'empirevu') or the Phase 3 value ('done_for_you' / 'standard').
  return brandForProductLine(productLineForOrg(org));
}

/**
 * The brand for a hostname BEFORE anyone signs in (sign-in, sign-up, password reset). Every host
 * DISPLAYS Everdoer. Only the product line differs, and it is kept exactly as in PR 1 so nothing
 * signed-out changes behaviour: app.crankleads.com, *.crankleads.com, crankleads.localhost,
 * everdoer.com, *.everdoer.com and everdoer.localhost → the done-for-you entry; everything else →
 * the standard entry.
 */
export function brandForHost(hostname: string | null | undefined): PlatformBrand {
  const host = (hostname ?? "").trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
  if (
    host === "crankleads.com" ||
    host.endsWith(".crankleads.com") ||
    host === "crankleads.localhost" ||
    host.endsWith(".crankleads.localhost") ||
    host === "everdoer.com" ||
    host.endsWith(".everdoer.com") ||
    host === "everdoer.localhost" ||
    host.endsWith(".everdoer.localhost")
  ) {
    return PLATFORM_BRANDS.crankleads;
  }
  return PLATFORM_BRANDS[DEFAULT_PLATFORM_BRAND];
}

/** Replace `{{product}}` in shared copy (help articles, onboarding text) with the brand name. */
export function withProductName(text: string, brand: Pick<PlatformBrand, "name">): string {
  return text.replace(/\{\{product\}\}/g, brand.name);
}
