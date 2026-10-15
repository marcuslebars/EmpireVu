/**
 * The platform name on the monthly scorecard (sender display name + footer). The CLIENT's
 * company name comes from `companies.name` and is shown in the email body.
 *
 * Per org (docs/everdoer-branding.md): every org's scorecard says "Everdoer". A done-for-you
 * org always gets the brand name; standard orgs get EVERDOER_BRAND_NAME, else "Everdoer".
 *
 * Env: EVERDOER_BRAND_NAME [monthly-scorecard] — optional override for standard orgs, defaults to
 * "Everdoer". The old name PLATFORM_BRAND_NAME is still read as a fallback for one release.
 */
import { platformBrand, type PlatformBrand } from "@/lib/platform-brand";
import { envWithFallback } from "@/server/services/rebrand/legacy-usage";

export const DEFAULT_PLATFORM_BRAND_NAME = "Everdoer";

export function scorecardPlatformBrandName(brand: PlatformBrand = platformBrand(null)): string {
  // Product line, not brand: the env override has only ever applied to standard orgs.
  if (brand.productLine !== "standard") return brand.name;
  // Rebrand shim (remove in PR 8 once legacy_usage shows no env/PLATFORM_BRAND_NAME for 30 days)
  return envWithFallback("EVERDOER_BRAND_NAME", ["PLATFORM_BRAND_NAME"]) || DEFAULT_PLATFORM_BRAND_NAME;
}
