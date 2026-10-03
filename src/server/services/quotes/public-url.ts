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
    return quotePublicBaseUrlFor(data);
  } catch (err) {
    console.error("[quotes] company quote origin unavailable; using the platform default:", err instanceof Error ? err.message : err);
    return getQuotesConfig().publicBaseUrl;
  }
}

/** `{origin}/q/{token}` for a company. */
export async function quoteLinkForCompanyId(companyId: string | null | undefined, token: string, db?: Db): Promise<string> {
  return `${await quotePublicBaseUrlForCompanyId(companyId, db)}/q/${token}`;
}
