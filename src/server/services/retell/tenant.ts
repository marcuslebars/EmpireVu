// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION #4: the Retell voice-receptionist routes are the fourth
// request path allowed to use the Supabase service-role (RLS-bypassing) client,
// after lead intake (#1), public booking (#2), and Telnyx voice (#3). Retell has
// no user session, so there is no RLS identity to act under.
//
// Same discipline as the others: service-role access is confined to this directory,
// and the TENANT IS ALWAYS RESOLVED SERVER-SIDE. For tenant zero (A1 Marine Storage)
// the brand is pinned by RETELL_SOURCE_SITE; nothing in the webhook payload can
// choose an organization or company. No other route may import
// createSupabaseAdminClient.
// ─────────────────────────────────────────────────────────────────────────────
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { companySlugForSourceSite, LEAD_INTAKE_ORG_SLUG } from "@/server/services/lead-intake/routing";

export type RetellAdminClient = ReturnType<typeof createSupabaseAdminClient>;

export function createRetellAdminClient(): RetellAdminClient {
  return createSupabaseAdminClient();
}

export interface RetellTenant {
  organizationId: string | null;
  companyId: string | null;
  /** The brand key the lead-intake routing consumes. */
  sourceSite: string;
}

/**
 * Resolve the org + company for a server-pinned brand key. Mirrors lead-intake's
 * resolveTarget so the retell_calls row scopes to the exact tenant the lead lands in.
 * An unmapped brand yields null ids — the call is still stored durably (service-role
 * only) rather than dropped.
 */
export async function resolveRetellTenant(
  admin: RetellAdminClient,
  sourceSite: string,
): Promise<RetellTenant> {
  const { data: org } = await admin
    .from("organizations")
    .select("id")
    .eq("slug", LEAD_INTAKE_ORG_SLUG)
    .maybeSingle();
  const organizationId = org?.id ?? null;

  const slug = companySlugForSourceSite(sourceSite);
  if (!organizationId || !slug) return { organizationId, companyId: null, sourceSite };

  const { data: company } = await admin
    .from("companies")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("slug", slug)
    .maybeSingle();
  return { organizationId, companyId: company?.id ?? null, sourceSite };
}
