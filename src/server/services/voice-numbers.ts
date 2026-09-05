import type { Inserts, Tables } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";
import { toE164 } from "@/server/services/retell/payload";
import { assertCompanyInOrganization, insertRow, type TenantServiceContext } from "@/server/services/shared";

/**
 * Voice-number management for the Integrations settings tab (Task 7). Reads/writes go
 * through the caller's RLS client (members read, admins manage). The request-time
 * resolution that maps an inbound call to a tenant lives in the retell/telnyx tenant
 * resolvers (service role) — this module is the operator-facing CRUD only.
 *
 * Provisioning via the Retell API is Task 13; here a number is entered manually.
 */
export type VoiceProvider = "retell" | "telnyx";
const PROVIDERS: readonly VoiceProvider[] = ["retell", "telnyx"];

export interface VoiceNumberView {
  id: string;
  companyId: string;
  phoneE164: string;
  provider: string;
  providerAgentId: string | null;
  brandLabel: string | null;
  active: boolean;
  createdAt: string;
}

function toView(row: Tables<"voice_numbers">): VoiceNumberView {
  return {
    id: row.id,
    companyId: row.company_id,
    phoneE164: row.phone_e164,
    provider: row.provider,
    providerAgentId: row.provider_agent_id,
    brandLabel: row.brand_label,
    active: row.active,
    createdAt: row.created_at,
  };
}

export async function listVoiceNumbers(context: TenantServiceContext): Promise<VoiceNumberView[]> {
  const { data, error } = await context.supabase
    .from("voice_numbers")
    .select("*")
    .eq("organization_id", context.organizationId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as Tables<"voice_numbers">[]).map(toView);
}

export interface CreateVoiceNumberInput {
  companyId: string;
  phone: string;
  provider: VoiceProvider;
  providerAgentId?: string | null;
  brandLabel?: string | null;
}

export async function createVoiceNumber(
  context: TenantServiceContext,
  input: CreateVoiceNumberInput,
): Promise<VoiceNumberView> {
  if (!PROVIDERS.includes(input.provider)) {
    throw new ValidationError("provider must be 'retell' or 'telnyx'.");
  }
  const phoneE164 = toE164(input.phone);
  if (!phoneE164) {
    throw new ValidationError("Enter a valid phone number.");
  }
  // The number's company must belong to the caller's org (also enforced by the composite FK + RLS).
  await assertCompanyInOrganization(context, input.companyId);

  const row: Inserts<"voice_numbers"> = {
    organization_id: context.organizationId,
    company_id: input.companyId,
    phone_e164: phoneE164,
    provider: input.provider,
    provider_agent_id: input.providerAgentId?.trim() || null,
    brand_label: input.brandLabel?.trim() || null,
    active: true,
  };
  const inserted = await insertRow(context, "voice_numbers", row);
  return toView(inserted);
}

export async function deactivateVoiceNumber(context: TenantServiceContext, id: string): Promise<void> {
  const { error } = await context.supabase
    .from("voice_numbers")
    .update({ active: false })
    .eq("organization_id", context.organizationId)
    .eq("id", id);
  if (error) throw error;
}
