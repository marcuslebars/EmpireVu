import type { RetellVoiceConfig } from "@/server/outbound/retell-voice";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";

// company_voice_profiles isn't in the generated database.types.ts (no gen-types step),
// same as the retell_/quotes tables — access it via the client cast to any.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tbl = (ctx: TenantServiceContext, name: string): any => (ctx.supabase as any).from(name);

export interface CompanyVoiceProfile {
  companyId: string;
  retellOutboundAgentId: string | null;
  fromNumber: string | null;
  brandLabel: string | null;
  dynamicVariables: Record<string, string>;
  active: boolean;
}

/**
 * Merge a company's voice profile over the global Retell config for one call (pure).
 * The profile's agent id + from-number win when set (so the call uses THAT brand's agent —
 * hence its KB + prompt — and caller ID); its brand_label + dynamic_variables feed the
 * greeting. customer_name / company_name are always injected last.
 */
export function effectiveVoiceForProfile(
  globalConfig: RetellVoiceConfig,
  profile: CompanyVoiceProfile | null,
  ctx: { customerName?: string | null; companyName?: string | null },
): { config: RetellVoiceConfig; dynamicVariables: Record<string, string> } {
  const config: RetellVoiceConfig = {
    apiKey: globalConfig.apiKey,
    fromNumber: profile?.fromNumber || globalConfig.fromNumber,
    agentId: profile?.retellOutboundAgentId || globalConfig.agentId,
  };

  const dynamicVariables: Record<string, string> = { ...(profile?.dynamicVariables ?? {}) };
  const companyName = profile?.brandLabel || ctx.companyName || null;
  if (ctx.customerName) dynamicVariables.customer_name = ctx.customerName;
  if (companyName) dynamicVariables.company_name = companyName;
  return { config, dynamicVariables };
}

function mapRow(row: Record<string, unknown>): CompanyVoiceProfile {
  const dyn = row.dynamic_variables;
  return {
    companyId: String(row.company_id),
    retellOutboundAgentId: (row.retell_outbound_agent_id as string | null) ?? null,
    fromNumber: (row.from_number as string | null) ?? null,
    brandLabel: (row.brand_label as string | null) ?? null,
    dynamicVariables:
      dyn && typeof dyn === "object" && !Array.isArray(dyn) ? (dyn as Record<string, string>) : {},
    active: row.active !== false,
  };
}

/** The active voice profile for a company, or null when none is configured. */
export async function resolveCompanyVoiceProfile(
  ctx: TenantServiceContext,
  companyId: string | null | undefined,
): Promise<CompanyVoiceProfile | null> {
  if (!companyId) return null;
  const { data } = await tbl(ctx, "company_voice_profiles")
    .select("company_id, retell_outbound_agent_id, from_number, brand_label, dynamic_variables, active")
    .eq("organization_id", ctx.organizationId)
    .eq("company_id", companyId)
    .eq("active", true)
    .maybeSingle();
  return data ? mapRow(data) : null;
}

export interface UpsertVoiceProfileInput {
  companyId: string;
  retellOutboundAgentId?: string | null;
  fromNumber?: string | null;
  brandLabel?: string | null;
  dynamicVariables?: Record<string, string>;
  active?: boolean;
}

/** Create or update the voice profile for a company (one per company). */
export async function upsertCompanyVoiceProfile(
  ctx: TenantServiceContext,
  input: UpsertVoiceProfileInput,
): Promise<CompanyVoiceProfile> {
  await assertCompanyInOrganization(ctx, input.companyId);

  const { data, error } = await tbl(ctx, "company_voice_profiles")
    .upsert(
      {
        organization_id: ctx.organizationId,
        company_id: input.companyId,
        retell_outbound_agent_id: input.retellOutboundAgentId ?? null,
        from_number: input.fromNumber ?? null,
        brand_label: input.brandLabel ?? null,
        dynamic_variables: input.dynamicVariables ?? {},
        active: input.active ?? true,
        created_by: ctx.actorProfileId,
      },
      { onConflict: "company_id" },
    )
    .select("*")
    .single();

  if (error) throw error;
  return mapRow(data);
}

export async function listCompanyVoiceProfiles(ctx: TenantServiceContext): Promise<CompanyVoiceProfile[]> {
  const { data, error } = await tbl(ctx, "company_voice_profiles")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(mapRow);
}
