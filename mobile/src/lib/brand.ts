/**
 * Mobile app brand — the product name owners see in the app (CrankLeads by default).
 *
 * Mirrors the web app's platform brand (src/lib/platform-brand-core.ts, docs/branding.md)
 * but is self-contained so the mobile bundle and its CI stay independent of the web tree.
 * Values are compiled in at build time from VITE_PLATFORM_* (see mobile/.env.example).
 *
 * NOT covered here (store-bound, change only with a store listing update): the bundle id
 * com.empirevu.app, the deep-link scheme, and the native display names in
 * android/app/src/main/res/values/strings.xml and ios/App/App/Info.plist.
 */

function clean(value: string | undefined): string | null {
  const v = typeof value === "string" ? value.replace(/[<>"\\]/g, "").trim() : "";
  return v.length > 0 ? v : null;
}

const DEFAULT_NAME = "CrankLeads";
// TODO(owner): confirm this mailbox exists, or set VITE_PLATFORM_SUPPORT_EMAIL.
const DEFAULT_SUPPORT_EMAIL = "hello@crankleads.com";
const DEFAULT_ACCENT_HSL = "82 85% 55%";

export function resolveMobileBrand(env: Record<string, string | undefined>) {
  const name = clean(env.VITE_PLATFORM_BRAND_NAME) ?? DEFAULT_NAME;
  const email = clean(env.VITE_PLATFORM_SUPPORT_EMAIL);
  const accent = clean(env.VITE_PLATFORM_BRAND_ACCENT_HSL);
  const split = name.match(/^([A-Z][a-z0-9]+)([A-Z].*)$/);
  return {
    name,
    supportEmail: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : DEFAULT_SUPPORT_EMAIL,
    accentHsl: accent && /^\d{1,3}(\.\d+)? \d{1,3}(\.\d+)?% \d{1,3}(\.\d+)?%$/.test(accent) ? accent : DEFAULT_ACCENT_HSL,
    wordmark: split ? { accent: split[1], rest: split[2] } : { accent: name, rest: "" },
  };
}

export type MobileBrand = ReturnType<typeof resolveMobileBrand>;

export const brand: MobileBrand = resolveMobileBrand({
  VITE_PLATFORM_BRAND_NAME: import.meta.env.VITE_PLATFORM_BRAND_NAME,
  VITE_PLATFORM_SUPPORT_EMAIL: import.meta.env.VITE_PLATFORM_SUPPORT_EMAIL,
  VITE_PLATFORM_BRAND_ACCENT_HSL: import.meta.env.VITE_PLATFORM_BRAND_ACCENT_HSL,
});
