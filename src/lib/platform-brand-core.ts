/**
 * Platform brand — the ONE place the product name an owner sees is defined.
 *
 * The codebase, repo, tables, env names and integration protocol are "EmpireVu" (the
 * engine). The product sold to client businesses is whatever this module resolves to —
 * CrankLeads by default. Everything owner-facing (app shell, auth pages, owner emails,
 * owner alerts) reads the name from here so the platform can be rebranded with env
 * vars, not a find-and-replace. See docs/branding.md.
 *
 * This file is PURE and environment-agnostic: it never touches `process.env` or
 * `import.meta.env` itself. Thin adapters supply the env reader:
 *   - SPA:      src/lib/platform-brand.ts     (VITE_PLATFORM_* via import.meta.env)
 *   - server:   src/server/platform-brand.ts  (PLATFORM_* via process.env)
 *   - build:    vite.config.ts                (fills %VITE_PLATFORM_*% in index.html)
 *
 * Customer-facing surfaces (public quote/booking pages, quote emails, Stripe statement
 * descriptors) are deliberately NOT platform-branded at all — they carry the client
 * company's brand. Do not add "Powered by" to them without an explicit product decision.
 */

export interface PlatformBrand {
  /** Product name owners see, e.g. "CrankLeads". */
  name: string;
  /** Compact name for tight spots (tab titles, push channels). Defaults to `name`. */
  shortName: string;
  /** One-line product description (meta description, sign-up subtitle). */
  tagline: string;
  /** Where owners write for help / account deletion / privacy requests. */
  supportEmail: string;
  /** Public marketing site. */
  websiteUrl: string;
  /** Legal entity named in the privacy policy. Defaults to `name` — set it explicitly. */
  legalName: string;
  /** Display name on the From line of platform (not company) email. Defaults to `name`. */
  emailFromName: string;
  /** "Powered by <name>" — available for surfaces that opt in; none do by default. */
  poweredBy: string;
  /** Optional image wordmark. Null = render the text wordmark (components/brand/Wordmark). */
  logoUrl: string | null;
  /** Favicon / square mark image. */
  faviconUrl: string;
  /** Brand accent as space-separated HSL channels ("82 85% 55%"), for `hsl(var(--brand-accent))`. */
  accentHsl: string;
  /** The name split for the two-tone wordmark: `accent` is coloured, `rest` is foreground. */
  wordmark: { accent: string; rest: string };
}

/**
 * Env keys, WITHOUT the client `VITE_` prefix. The server reads these names directly;
 * the SPA reads `VITE_` + key. Keep this list small — every key is documented in
 * docs/branding.md and .env.example.
 */
export const PLATFORM_BRAND_ENV_KEYS = {
  name: "PLATFORM_BRAND_NAME",
  shortName: "PLATFORM_BRAND_SHORT_NAME",
  tagline: "PLATFORM_BRAND_TAGLINE",
  supportEmail: "PLATFORM_SUPPORT_EMAIL",
  websiteUrl: "PLATFORM_WEBSITE_URL",
  legalName: "PLATFORM_LEGAL_NAME",
  emailFromName: "PLATFORM_EMAIL_FROM_NAME",
  logoUrl: "PLATFORM_BRAND_LOGO_URL",
  faviconUrl: "PLATFORM_BRAND_FAVICON_URL",
  accentHsl: "PLATFORM_BRAND_ACCENT_HSL",
} as const;

export type PlatformBrandEnvKey = (typeof PLATFORM_BRAND_ENV_KEYS)[keyof typeof PLATFORM_BRAND_ENV_KEYS];

/** CrankLeads defaults — what every surface shows when no env override is set. */
export const PLATFORM_BRAND_DEFAULTS = {
  name: "CrankLeads",
  tagline: "Done-for-you lead system for trades",
  // TODO(owner): confirm this mailbox exists, or set PLATFORM_SUPPORT_EMAIL / VITE_PLATFORM_SUPPORT_EMAIL.
  supportEmail: "hello@crankleads.com",
  websiteUrl: "https://crankleads.com",
  faviconUrl: "/crankleads-favicon.svg",
  /** crankleads.com primary: hsl(82 85% 55%) — a lime that reads on the app's dark surfaces. */
  accentHsl: "82 85% 55%",
} as const;

export type PlatformBrandEnvReader = (key: PlatformBrandEnvKey) => string | undefined;

/** Trimmed non-blank value, else null. A blank var in a dashboard must fall back, not win. */
function clean(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Text that ends up in HTML attributes (index.html), email From headers and JSX. Angle
 * brackets and quotes are dropped so a stray character in an env var can't break markup
 * or a From header.
 */
function cleanText(value: string | undefined): string | null {
  const v = clean(value);
  if (!v) return null;
  const safe = v.replace(/[<>"\\]/g, "").trim();
  return safe.length > 0 ? safe : null;
}

function cleanEmail(value: string | undefined): string | null {
  const v = clean(value);
  return v && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(v) ? v : null;
}

function cleanHttpUrl(value: string | undefined): string | null {
  const v = clean(value);
  return v && /^https?:\/\/[^\s<>"]+$/i.test(v) ? v.replace(/\/$/, "") : null;
}

/** An absolute http(s) URL or a root-relative path ("/brand/logo.svg"). */
function cleanAssetUrl(value: string | undefined): string | null {
  const v = clean(value);
  if (!v) return null;
  if (/^https?:\/\/[^\s<>"]+$/i.test(v)) return v;
  if (/^\/[^\s<>"]*$/.test(v) && !v.startsWith("//")) return v;
  return null;
}

/** "82 85% 55%" (commas tolerated). Anything else falls back to the default. */
function cleanHsl(value: string | undefined): string | null {
  const v = clean(value);
  if (!v) return null;
  const m = v.match(/^(\d{1,3}(?:\.\d+)?)[\s,]+(\d{1,3}(?:\.\d+)?)%[\s,]+(\d{1,3}(?:\.\d+)?)%$/);
  if (!m) return null;
  const [h, s, l] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (h > 360 || s > 100 || l > 100) return null;
  return `${m[1]} ${m[2]}% ${m[3]}%`;
}

/**
 * Split a name for the two-tone wordmark at its first internal capital:
 * "CrankLeads" → Crank + Leads. A name without one is all accent.
 */
export function splitWordmark(name: string): { accent: string; rest: string } {
  const m = name.match(/^([A-Z][a-z0-9]+)([A-Z].*)$/);
  return m ? { accent: m[1], rest: m[2] } : { accent: name, rest: "" };
}

export function resolvePlatformBrand(read: PlatformBrandEnvReader): PlatformBrand {
  const K = PLATFORM_BRAND_ENV_KEYS;
  const name = cleanText(read(K.name)) ?? PLATFORM_BRAND_DEFAULTS.name;
  return {
    name,
    shortName: cleanText(read(K.shortName)) ?? name,
    tagline: cleanText(read(K.tagline)) ?? PLATFORM_BRAND_DEFAULTS.tagline,
    supportEmail: cleanEmail(read(K.supportEmail)) ?? PLATFORM_BRAND_DEFAULTS.supportEmail,
    websiteUrl: cleanHttpUrl(read(K.websiteUrl)) ?? PLATFORM_BRAND_DEFAULTS.websiteUrl,
    legalName: cleanText(read(K.legalName)) ?? name,
    emailFromName: cleanText(read(K.emailFromName)) ?? name,
    poweredBy: `Powered by ${name}`,
    logoUrl: cleanAssetUrl(read(K.logoUrl)),
    faviconUrl: cleanAssetUrl(read(K.faviconUrl)) ?? PLATFORM_BRAND_DEFAULTS.faviconUrl,
    accentHsl: cleanHsl(read(K.accentHsl)) ?? PLATFORM_BRAND_DEFAULTS.accentHsl,
    wordmark: splitWordmark(name),
  };
}

/**
 * The `%VITE_…%` placeholders index.html uses, resolved (env value if valid, else the
 * default). vite.config.ts writes these into process.env before Vite loads env so the
 * built HTML never ships a literal `%VITE_PLATFORM_BRAND_NAME%`.
 */
export function platformBrandHtmlEnv(brand: PlatformBrand): Record<string, string> {
  return {
    VITE_PLATFORM_BRAND_NAME: brand.name,
    VITE_PLATFORM_BRAND_TAGLINE: brand.tagline,
    VITE_PLATFORM_BRAND_FAVICON_URL: brand.faviconUrl,
  };
}
