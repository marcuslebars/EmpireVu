/**
 * Platform brand — the ONE source of truth for which product name, logo, favicon and
 * accent a tenant's OWN people (owner + staff) see. Shared by the SPA and the server.
 *
 * The codebase, API contracts (x-empirevu-* headers, storage keys, bundle ids, DB names)
 * and house tenants stay EmpireVu. An org that bought CrankLeads (organizations.platform_brand
 * = 'crankleads', set by provisioning) sees CrankLeads everywhere instead — never "EmpireVu".
 * See docs/crankleads-branding.md.
 *
 * Customer-facing pages (quotes, invoices, forms, booking) are branded from the COMPANY, not
 * from this — a tenant's customers see neither platform name.
 *
 * Browser-safe: no `process.env` here, and no hard-coded app hosts. Server-side origins (app
 * base URL per brand, from env) live in src/server/services/platform-brand.ts.
 */

export const PLATFORM_BRAND_KEYS = ["empirevu", "crankleads"] as const;
export type PlatformBrandKey = (typeof PLATFORM_BRAND_KEYS)[number];

export const DEFAULT_PLATFORM_BRAND: PlatformBrandKey = "empirevu";

export interface PlatformBrandTheme {
  /** Hex accent used in emails / Stripe Checkout (the SPA uses data-brand CSS tokens). */
  accentHex: string;
  /** Hex text colour that reads on the accent. */
  onAccentHex: string;
  backgroundHex: string;
}

export interface PlatformBrand {
  key: PlatformBrandKey;
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

export const PLATFORM_BRANDS: Record<PlatformBrandKey, PlatformBrand> = {
  empirevu: {
    key: "empirevu",
    name: "EmpireVu",
    logoSrc: "/empirevu-logo.png",
    logoWidth: 700,
    logoHeight: 200,
    markSrc: "/empirevu-favicon.svg",
    faviconHref: "/empirevu-favicon.svg",
    faviconType: "image/svg+xml",
    faviconPngHref: "/empirevu-favicon.png",
    appleTouchIconHref: "/empirevu-favicon.png",
    supportEmail: "hello@empirevu.com",
    theme: { accentHex: "#1a75ff", onAccentHex: "#ffffff", backgroundHex: "#0c0f14" },
  },
  crankleads: {
    key: "crankleads",
    name: "CrankLeads",
    logoSrc: "/brand/crankleads-logo.svg",
    logoWidth: 673,
    logoHeight: 128,
    markSrc: "/brand/crankleads-favicon.svg",
    faviconHref: "/brand/crankleads-favicon.svg",
    faviconType: "image/svg+xml",
    faviconPngHref: "/brand/crankleads-favicon-32.png",
    appleTouchIconHref: "/brand/crankleads-apple-touch-icon.png",
    supportEmail: "hello@crankleads.com",
    theme: { accentHex: "#a6ee2b", onAccentHex: "#0c0e12", backgroundHex: "#0c0f13" },
  },
};

export function isPlatformBrandKey(value: unknown): value is PlatformBrandKey {
  return typeof value === "string" && (PLATFORM_BRAND_KEYS as readonly string[]).includes(value);
}

/** Unknown / missing values fall back to EmpireVu (the house default). */
export function platformBrand(key: unknown): PlatformBrand {
  return PLATFORM_BRANDS[isPlatformBrandKey(key) ? key : DEFAULT_PLATFORM_BRAND];
}

/**
 * The brand an organization's people see. `platform_brand` is authoritative; an org with a
 * CrankLeads tier but no platform_brand (a row read before the migration, or a partial
 * select) is still CrankLeads, so a buyer never sees "EmpireVu".
 */
export function brandForOrg(
  org: { platform_brand?: string | null; crankleads_tier?: string | null } | null | undefined,
): PlatformBrand {
  if (!org) return PLATFORM_BRANDS[DEFAULT_PLATFORM_BRAND];
  if (isPlatformBrandKey(org.platform_brand) && org.platform_brand !== DEFAULT_PLATFORM_BRAND) {
    return PLATFORM_BRANDS[org.platform_brand];
  }
  if (org.crankleads_tier) return PLATFORM_BRANDS.crankleads;
  return platformBrand(org.platform_brand);
}

/**
 * The brand for a hostname BEFORE anyone signs in (sign-in, sign-up, password reset):
 * app.crankleads.com, any *.crankleads.com and crankleads.localhost (local dev) → CrankLeads;
 * everything else → EmpireVu.
 */
export function brandForHost(hostname: string | null | undefined): PlatformBrand {
  const host = (hostname ?? "").trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
  if (
    host === "crankleads.com" ||
    host.endsWith(".crankleads.com") ||
    host === "crankleads.localhost" ||
    host.endsWith(".crankleads.localhost")
  ) {
    return PLATFORM_BRANDS.crankleads;
  }
  return PLATFORM_BRANDS[DEFAULT_PLATFORM_BRAND];
}

/** Replace `{{product}}` in shared copy (help articles, onboarding text) with the brand name. */
export function withProductName(text: string, brand: Pick<PlatformBrand, "name">): string {
  return text.replace(/\{\{product\}\}/g, brand.name);
}
