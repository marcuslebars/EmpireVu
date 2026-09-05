// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION #3: the Telnyx voice-agent routes are the third request
// path allowed to use the Supabase service-role (RLS-bypassing) client, after
// lead intake (#1) and public booking (#2). Telnyx has no user session, so there
// is no RLS identity to act under.
//
// Same discipline as the other two: service-role access is confined to this
// directory, and the TENANT IS ALWAYS RESOLVED SERVER-SIDE FROM THE NUMBER THAT
// WAS DIALLED. Nothing in a request payload can choose an organization or
// company. No other route may import createSupabaseAdminClient.
// ─────────────────────────────────────────────────────────────────────────────
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { sourceSiteForCompanySlug } from "@/server/services/lead-intake/routing";
import { toE164 } from "./payload";

export type TelnyxAdminClient = ReturnType<typeof createSupabaseAdminClient>;

export function createTelnyxAdminClient(): TelnyxAdminClient {
  return createSupabaseAdminClient();
}

export interface TelnyxTenant {
  brandLabel: string | null;
  companyId: string | null;
  organizationId: string | null;
  /** The brand key the existing lead-intake routing consumes. */
  sourceSite: string | null;
}

export const EMPTY_TENANT: TelnyxTenant = {
  brandLabel: null,
  companyId: null,
  organizationId: null,
  sourceSite: null,
};

/**
 * The dialled number decides the brand. Reads voice_numbers (provider 'telnyx') — the
 * unified table Task 7 introduced — and derives the sourceSite tag from the company slug
 * (A1 brands keep their exact tag). Falls back to TELNYX_DEFAULT_TENANT_ID (a company id)
 * when the number isn't mapped, so an unmapped number still routes somewhere rather than
 * dropping the call's lead.
 */
export async function resolveTenantByCalledNumber(
  admin: TelnyxAdminClient,
  calledNumber: string | null,
): Promise<TelnyxTenant> {
  const e164 = toE164(calledNumber);

  if (e164) {
    const { data } = await admin
      .from("voice_numbers")
      .select("organization_id, company_id, brand_label")
      .eq("phone_e164", e164)
      .eq("provider", "telnyx")
      .eq("active", true)
      .maybeSingle();

    if (data) {
      const row = data as { organization_id: string; company_id: string; brand_label: string | null };
      const { data: company } = await admin
        .from("companies")
        .select("slug")
        .eq("organization_id", row.organization_id)
        .eq("id", row.company_id)
        .maybeSingle();
      const slug = (company as { slug: string } | null)?.slug ?? null;
      return {
        brandLabel: row.brand_label,
        companyId: row.company_id,
        organizationId: row.organization_id,
        sourceSite: sourceSiteForCompanySlug(slug),
      };
    }
  }

  return resolveDefaultTenant(admin);
}

export async function resolveDefaultTenant(admin: TelnyxAdminClient): Promise<TelnyxTenant> {
  const defaultCompanyId = process.env.TELNYX_DEFAULT_TENANT_ID?.trim();
  if (!defaultCompanyId) {
    return EMPTY_TENANT;
  }

  const { data } = await admin
    .from("companies")
    .select("id, name, slug, organization_id")
    .eq("id", defaultCompanyId)
    .maybeSingle();

  if (!data) {
    return EMPTY_TENANT;
  }

  return {
    brandLabel: data.name,
    companyId: data.id,
    organizationId: data.organization_id,
    sourceSite: sourceSiteForCompanySlug(data.slug),
  };
}
