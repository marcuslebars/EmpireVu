/**
 * The platform name on the monthly scorecard (sender display name + footer). The CLIENT's
 * company name comes from `companies.name` and is shown in the email body.
 *
 * Per org (docs/crankleads-branding.md): a CrankLeads org's scorecard says "CrankLeads" and
 * links to the CrankLeads app. Everyone else gets PLATFORM_BRAND_NAME, else "EmpireVu".
 *
 * Env: PLATFORM_BRAND_NAME [monthly-scorecard] — optional override for EmpireVu orgs, defaults to "EmpireVu".
 */
import { platformBrand, type PlatformBrand } from "@/lib/platform-brand";

export const DEFAULT_PLATFORM_BRAND_NAME = "EmpireVu";

export function scorecardPlatformBrandName(brand: PlatformBrand = platformBrand(null)): string {
  if (brand.key !== "empirevu") return brand.name;
  return process.env.PLATFORM_BRAND_NAME?.trim() || DEFAULT_PLATFORM_BRAND_NAME;
}
