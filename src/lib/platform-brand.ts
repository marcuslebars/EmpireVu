/**
 * SPA adapter for the platform brand (see platform-brand-core.ts / docs/branding.md).
 *
 * Reads `VITE_PLATFORM_*` build-time env. Vite inlines `import.meta.env` as an object at
 * build time, so the values are fixed per build — rebranding the web app means setting
 * the vars on the web service and redeploying.
 */
import {
  PLATFORM_BRAND_ENV_KEYS,
  resolvePlatformBrand,
  type PlatformBrand,
} from "@/lib/platform-brand-core";

export type { PlatformBrand } from "@/lib/platform-brand-core";
export { PLATFORM_BRAND_DEFAULTS } from "@/lib/platform-brand-core";

export function readClientPlatformBrand(env: Record<string, unknown> = import.meta.env): PlatformBrand {
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
