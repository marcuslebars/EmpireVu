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
  // boatnames.ca is a standalone A1 brand: it sends the brand id "boatnames"
  // (NOT "a1boatnames" like the hyphen-stripped siblings), routed to company
  // slug "a1-boatnames". Seed that company: supabase/seeds/a1-boatnames.sql.
  boatnames: "a1-boatnames",
};

export function companySlugForSourceSite(sourceSite: string): string | null {
  return SOURCE_SITE_TO_COMPANY_SLUG[sourceSite.trim().toLowerCase()] ?? null;
}

const COMPANY_SLUG_TO_SOURCE_SITE: Record<string, string> = Object.fromEntries(
  Object.entries(SOURCE_SITE_TO_COMPANY_SLUG).map(([site, slug]) => [slug, site]),
);

/**
 * Reverse of companySlugForSourceSite: the brand key for a known A1 company slug, or null.
 * Used by the voice resolvers to keep the `sourceSite` tag correct for A1 brands after a
 * call is pinned to its company via voice_numbers (Task 7).
 */
export function sourceSiteForCompanySlug(slug: string | null | undefined): string | null {
  return slug ? COMPANY_SLUG_TO_SOURCE_SITE[slug] ?? null : null;
}
