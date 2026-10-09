import { appBaseUrlFor, type PlatformBrandKey } from "@/server/services/platform-brand";

/**
 * Public URL of a generated site (docs/done-for-you.md → "Generated sites").
 *   PAGES_BASE_URL set   → https://pages.crankleads.com/<slug>   (served by host routing in middleware)
 *   PAGES_BASE_URL unset → <appBaseUrlFor(brand)>/s/<slug>
 *
 * Env: PAGES_BASE_URL [web, workers] — origin of the pages host, no trailing slash.
 */
export function pagesBaseUrl(): string | null {
  const raw = process.env.PAGES_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

export function siteUrl(slug: string, brand: PlatformBrandKey | null | undefined = "crankleads"): string {
  const pages = pagesBaseUrl();
  return pages ? `${pages}/${slug}` : `${appBaseUrlFor(brand ?? "empirevu")}/s/${slug}`;
}
