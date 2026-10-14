/**
 * The platform name on the monthly scorecard (sender display name + footer). The CLIENT's
 * company name comes from `companies.name` and is shown in the email body.
 *
 * Per org (docs/everdoer-branding.md): every org's scorecard says "Everdoer". A done-for-you
 * org always gets the brand name; standard orgs get PLATFORM_BRAND_NAME, else "Everdoer".
 *
 * Env: PLATFORM_BRAND_NAME [monthly-scorecard] — optional override for standard orgs, defaults to "Everdoer".
 */
import { platformBrand, type PlatformBrand } from "@/lib/platform-brand";

export const DEFAULT_PLATFORM_BRAND_NAME = "Everdoer";

export function scorecardPlatformBrandName(brand: PlatformBrand = platformBrand(null)): string {
  // Product line, not brand: the env override has only ever applied to standard orgs.
  if (brand.productLine !== "standard") return brand.name;
  return process.env.PLATFORM_BRAND_NAME?.trim() || DEFAULT_PLATFORM_BRAND_NAME;
}
