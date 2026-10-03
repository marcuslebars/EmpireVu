/**
 * SPA adapter for the platform brand (see platform-brand-core.ts / docs/branding.md).
 *
 * Reads `VITE_PLATFORM_*` build-time env, each variable by name. Values are fixed per build — rebranding the web app means setting
 * the vars on the web service and redeploying.
 */
import {
  PLATFORM_BRAND_ENV_KEYS,
  resolvePlatformBrand,
  type PlatformBrand,
} from "@/lib/platform-brand-core";

export type { PlatformBrand } from "@/lib/platform-brand-core";
export { PLATFORM_BRAND_DEFAULTS } from "@/lib/platform-brand-core";

/**
 * SECURITY: every key is read BY NAME. Never reference `import.meta.env` as a whole object
 * in client code — Vite then inlines EVERY `VITE_*` variable present at build time into the
 * public bundle (this leaked a mis-named server secret once; see docs/branding.md).
 * `src/test/client-env-leak.test.ts` fails CI if a whole-object reference comes back.
 */
const CLIENT_BRAND_ENV: Record<string, unknown> = {
  VITE_PLATFORM_BRAND_NAME: import.meta.env.VITE_PLATFORM_BRAND_NAME,
  VITE_PLATFORM_BRAND_SHORT_NAME: import.meta.env.VITE_PLATFORM_BRAND_SHORT_NAME,
  VITE_PLATFORM_BRAND_TAGLINE: import.meta.env.VITE_PLATFORM_BRAND_TAGLINE,
  VITE_PLATFORM_SUPPORT_EMAIL: import.meta.env.VITE_PLATFORM_SUPPORT_EMAIL,
  VITE_PLATFORM_WEBSITE_URL: import.meta.env.VITE_PLATFORM_WEBSITE_URL,
  VITE_PLATFORM_LEGAL_NAME: import.meta.env.VITE_PLATFORM_LEGAL_NAME,
  VITE_PLATFORM_BRAND_LOGO_URL: import.meta.env.VITE_PLATFORM_BRAND_LOGO_URL,
  VITE_PLATFORM_BRAND_FAVICON_URL: import.meta.env.VITE_PLATFORM_BRAND_FAVICON_URL,
  VITE_PLATFORM_BRAND_ACCENT_HSL: import.meta.env.VITE_PLATFORM_BRAND_ACCENT_HSL,
};

export function readClientPlatformBrand(env: Record<string, unknown> = CLIENT_BRAND_ENV): PlatformBrand {
  return resolvePlatformBrand((key) => {
    const value = env[`VITE_${key}`];
    return typeof value === "string" ? value : undefined;
  });
}

/** The brand for this build. Import this rather than re-reading env in components. */
export const platformBrand: PlatformBrand = readClientPlatformBrand();

/** Client env var names, for docs/diagnostics. */
export const CLIENT_PLATFORM_BRAND_ENV = Object.values(PLATFORM_BRAND_ENV_KEYS)
  .filter((key) => key !== PLATFORM_BRAND_ENV_KEYS.emailFromName)
  .map((key) => `VITE_${key}`);

/**
 * Push the brand accent into the `--brand-accent` CSS variable (index.css ships the
 * CrankLeads default, so this only matters when VITE_PLATFORM_BRAND_ACCENT_HSL is set).
 * The app's global --primary is intentionally untouched — see docs/branding.md.
 */
export function applyPlatformBrandToDocument(brand: PlatformBrand = platformBrand, doc: Document = document): void {
  doc.documentElement.style.setProperty("--brand-accent", brand.accentHsl);
  if (!doc.title.trim() || doc.title.includes("%VITE_")) doc.title = brand.name;
}
