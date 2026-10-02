/**
 * The monthly scorecard's platform brand (sender display name + footer). Delegates to the
 * central platform-brand module (docs/branding.md) so one env var rebrands everything.
 * The CLIENT's company name comes from `companies.name` and is shown in the email body.
 */
import { getPlatformBrand } from "@/server/platform-brand";

export const DEFAULT_PLATFORM_BRAND_NAME = "CrankLeads";

export function scorecardPlatformBrandName(): string {
  return getPlatformBrand().name || DEFAULT_PLATFORM_BRAND_NAME;
}
