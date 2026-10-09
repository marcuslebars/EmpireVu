// SERVER-ONLY. Resolves a company's customer-facing quote origin by id.
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { getQuotesConfig, quotePublicBaseUrlFor } from "@/server/services/quotes/config";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/**
 * `quotePublicBaseUrlFor` for a company id. Reads `select("*")` so it works before and
 * after the `quote_public_base_url` column exists; any read failure falls back to the
 * platform origin rather than failing a customer-facing send. Uses the service-role
 * client when none is passed (public quote routes have no tenant session).
 */
export async function quotePublicBaseUrlForCompanyId(companyId: string | null | undefined, db?: Db): Promise<string> {
  if (!companyId) return getQuotesConfig().publicBaseUrl;
  try {
    const client = db ?? (createSupabaseAdminClient() as Db);
    const { data } = await client.from("companies").select("*").eq("id", companyId).maybeSingle();
    return quotePublicBaseUrlFor(await withPlatformBrand(client, data));
  } catch (err) {
    console.error("[quotes] company quote origin unavailable; using the platform default:", err instanceof Error ? err.message : err);
    return getQuotesConfig().publicBaseUrl;
  }
}

/** `{origin}/q/{token}` for a company. */
export async function quoteLinkForCompanyId(companyId: string | null | undefined, token: string, db?: Db): Promise<string> {
  return `${await quotePublicBaseUrlForCompanyId(companyId, db)}/q/${token}`;
}

/**
 * The company row + its organization's platform brand ('crankleads' for a CrankLeads org, also
 * when only crankleads_tier is set), so quotePublicBaseUrlFor can pick the CrankLeads host.
 * Best-effort: a failed org read just means the default host.
 */
export async function withPlatformBrand<T extends { organization_id?: unknown } | null>(db: Db, company: T): Promise<(T & { platform_brand?: string | null }) | T> {
  if (!company || typeof company.organization_id !== "string") return company;
  try {
    const { data: org } = await db.from("organizations").select("platform_brand, crankleads_tier").eq("id", company.organization_id).maybeSingle();
    const o = org as { platform_brand?: string | null; crankleads_tier?: string | null } | null;
    const brand = o?.platform_brand === "crankleads" || o?.crankleads_tier ? "crankleads" : o?.platform_brand ?? null;
    return { ...company, platform_brand: brand };
  } catch {
    return company;
  }
}
