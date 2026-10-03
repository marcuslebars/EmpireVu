/**
 * The platform name on the monthly scorecard (sender display name + footer). The CLIENT's
 * company name comes from `companies.name` and is shown in the email body.
 *
 * Env: PLATFORM_BRAND_NAME [monthly-scorecard] — optional override, defaults to "EmpireVu".
 */
export const DEFAULT_PLATFORM_BRAND_NAME = "EmpireVu";

export function scorecardPlatformBrandName(): string {
  return process.env.PLATFORM_BRAND_NAME?.trim() || DEFAULT_PLATFORM_BRAND_NAME;
}
