// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION #4: the Retell voice-receptionist routes use the Supabase
// service-role (RLS-bypassing) client — Retell has no user session, so there is no RLS
// identity to act under. Service-role access is confined to this directory, and the
// TENANT IS ALWAYS RESOLVED SERVER-SIDE: an inbound call is pinned by the NUMBER it came
// in on (voice_numbers), then by the Retell AGENT id, and only then by the legacy
// RETELL_SOURCE_SITE env (deprecation-warned). Nothing in the webhook payload can choose
// an organization or company. No other route may import createSupabaseAdminClient.
// ─────────────────────────────────────────────────────────────────────────────
import {
  companySlugForSourceSite,
  LEAD_INTAKE_ORG_SLUG,
  sourceSiteForCompanySlug,
} from "@/server/services/lead-intake/routing";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { toE164 } from "./payload";

export type RetellAdminClient = ReturnType<typeof createSupabaseAdminClient>;

export function createRetellAdminClient(): RetellAdminClient {
  return createSupabaseAdminClient();
}

export interface RetellTenant {
  organizationId: string | null;
  companyId: string | null;
  /** The brand key the lead-intake routing consumes (a free-text tag once pinned). */
  sourceSite: string;
}

export interface ResolveRetellTenantInput {
  /** The number the call came in on (E.164-ish). */
  toNumber: string | null;
  /** The Retell agent that handled the call. */
  agentId: string | null;
  /** Legacy env fallback (RETELL_SOURCE_SITE) — used only when nothing maps. */
  legacySourceSite: string;
}

interface VoiceNumberTenant {
  organization_id: string;
  company_id: string;
}

/** Build a tenant from a resolved company, deriving the sourceSite tag from its slug so
 *  A1 brands keep their exact tag after being pinned by number. */
async function tenantFromCompany(
  admin: RetellAdminClient,
  organizationId: string,
  companyId: string,
): Promise<RetellTenant> {
  const { data } = await admin
    .from("companies")
    .select("slug")
    .eq("organization_id", organizationId)
    .eq("id", companyId)
    .maybeSingle();
  const slug = (data as { slug: string } | null)?.slug ?? null;
  return { organizationId, companyId, sourceSite: sourceSiteForCompanySlug(slug) ?? "" };
}

/**
 * Resolve the org + company for an INBOUND Retell call: by dialled number, then by agent
 * id, then the legacy env. An unmapped call yields null ids — it's still stored durably
 * (service-role only) and flagged, never dropped. Outbound calls resolve from the metadata
 * we set when dialling (handled in lead-adapter), not here.
 */
export async function resolveRetellTenant(
  admin: RetellAdminClient,
  input: ResolveRetellTenantInput,
): Promise<RetellTenant> {
  // (1) by the number the call came in on.
  const e164 = toE164(input.toNumber);
  if (e164) {
    const { data } = await admin
      .from("voice_numbers")
      .select("organization_id, company_id")
      .eq("phone_e164", e164)
      .eq("provider", "retell")
      .eq("active", true)
      .maybeSingle();
    const row = data as VoiceNumberTenant | null;
    if (row) return tenantFromCompany(admin, row.organization_id, row.company_id);
  }

  // (2) by the Retell agent id.
  if (input.agentId) {
    const { data } = await admin
      .from("voice_numbers")
      .select("organization_id, company_id")
      .eq("provider_agent_id", input.agentId)
      .eq("provider", "retell")
      .eq("active", true)
      .limit(1)
      .maybeSingle();
    const row = data as VoiceNumberTenant | null;
    if (row) return tenantFromCompany(admin, row.organization_id, row.company_id);
  }

  // (3) legacy env fallback — the A1 spokes until they're cut over to voice_numbers.
  console.warn(
    "[retell] resolving tenant via legacy RETELL_SOURCE_SITE — add a voice_numbers row " +
      "for this number/agent to remove this fallback (docs/tenant-provisioning.md).",
  );
  return resolveLegacyBrand(admin, input.legacySourceSite);
}

async function resolveLegacyBrand(admin: RetellAdminClient, sourceSite: string): Promise<RetellTenant> {
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
