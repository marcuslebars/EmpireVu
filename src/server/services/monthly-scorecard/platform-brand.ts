/**
 * THE ONE PLACE the monthly scorecard reads the platform's own brand (the done-for-you
 * service the client bought — "CrankLeads" today), as opposed to the CLIENT's company name,
 * which comes from `companies.name` and is shown prominently in the email body.
 *
 * Used for: the sender display name on the From line, and the footer ("Sent by CrankLeads").
 * Nothing else in the scorecard hardcodes a platform name.
 *
 * Another PR is centralizing platform branding; when it lands, replace the body of
 * `scorecardPlatformBrandName()` with a call into that module and delete this file's env read.
 *
 * Env: PLATFORM_BRAND_NAME [monthly-scorecard] — defaults to "CrankLeads".
 */
export const DEFAULT_PLATFORM_BRAND_NAME = "CrankLeads";

export function scorecardPlatformBrandName(): string {
  return process.env.PLATFORM_BRAND_NAME?.trim() || DEFAULT_PLATFORM_BRAND_NAME;
}
