/**
 * Server-pinned brand routing.
 *
 * The request payload's `sourceSite` only SELECTS among these known brands; nothing
 * in the payload can name an arbitrary organization or company. An unknown brand
 * routes to no company (the lead is still stored raw + flagged). The target org is
 * pinned by env, never by the payload.
 */
export const LEAD_INTAKE_ORG_SLUG = process.env.LEAD_INTAKE_ORG_SLUG ?? "a1-group";

export const SOURCE_SITE_TO_COMPANY_SLUG: Record<string, string> = {
  a1marinecare: "a1-marine-care",
  a1marinestorage: "a1-marine-storage",
  a1coatings: "a1-coatings",
};

export function companySlugForSourceSite(sourceSite: string): string | null {
  return SOURCE_SITE_TO_COMPANY_SLUG[sourceSite.trim().toLowerCase()] ?? null;
}
