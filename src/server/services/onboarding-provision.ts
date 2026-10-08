import { UserFacingError } from "@/server/errors";
import type { Tables } from "@/server/db/database.types";
import { listCatalogItems } from "@/server/services/quotes/catalog-items";
import { bookableService, DEFAULT_ONLINE_BOOKING_SETTINGS } from "@/server/services/scheduling/rules";
import { bookingPageUrl } from "@/server/services/scheduling/urls";
import type { TenantServiceContext } from "@/server/services/shared";
import { upsertCompanyVoiceProfile } from "@/server/services/company-voice-profiles";
import { getPack, packReceptionistNotes } from "@/server/services/packs";
import { parseAppliedIndustryPack } from "@/server/services/packs/types";
import {
  buildReceptionistPrompt,
  createRetellClient,
  getRetellApiKey,
  provisionRetellAgent,
  type ProvisionResult,
  type RetellClient,
} from "@/server/services/retell/provision";

/**
 * Phone step orchestration (Task 13): build Marina's prompt from the company + catalog,
 * provision the Retell LLM/agent/number (idempotent via the ids we stored last time), then
 * persist voice_numbers (inbound routing reads provider_agent_id here) + the voice profile.
 * The Retell client is injectable for tests; secrets stay server-side.
 */

export interface ProvisionPhoneInput {
  companyId: string;
  areaCode?: number | null;
  attachNumber?: string | null;
  transferNumber?: string | null;
  /** Ids from a previous run (onboarding_progress data) → update instead of create. */
  existing?: { llmId?: string | null; agentId?: string | null; phoneNumber?: string | null };
}

async function loadCompany(context: TenantServiceContext, companyId: string): Promise<Tables<"companies">> {
  const { data, error } = await context.supabase
    .from("companies")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("id", companyId)
    .single();
  if (error) throw error;
  return data as Tables<"companies">;
}

function hoursToText(hours: Tables<"companies">["hours"]): string | null {
  if (!hours || typeof hours !== "object") return null;
  const record = hours as Record<string, unknown>;
  // The wizard stores a freeform summary; honor it directly.
  if (typeof record.summary === "string" && record.summary.trim()) return record.summary.trim();
  if (typeof record.text === "string" && record.text.trim()) return record.text.trim();
  // Google Places style (written by the done-for-you enrichment): ["Monday: 8:00 AM – 5:00 PM", …].
  const weekdayText = record.weekdayText ?? record.weekday_text ?? record.weekdayDescriptions;
  if (Array.isArray(weekdayText)) {
    const lines = weekdayText.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
    return lines.length ? lines.join("; ") : null;
  }
  if (Array.isArray(record.periods)) return null;
  const entries = Object.entries(record);
  if (entries.length === 0) return null;
  return entries
    .map(([day, v]) => {
      if (v && typeof v === "object" && "open" in v && "close" in v) {
        const o = (v as { open?: unknown }).open;
        const c = (v as { close?: unknown }).close;
        return `${day} ${String(o ?? "?")}–${String(c ?? "?")}`;
      }
      return `${day} ${String(v)}`;
    })
    .join(", ");
}

async function upsertRetellVoiceNumber(
  context: TenantServiceContext,
  companyId: string,
  phoneE164: string,
  agentId: string,
  brandLabel: string,
): Promise<void> {
  const { data: existing } = await context.supabase
    .from("voice_numbers")
    .select("id")
    .eq("organization_id", context.organizationId)
    .eq("company_id", companyId)
    .eq("provider", "retell")
    .limit(1)
    .maybeSingle();

  if (existing && (existing as { id: string }).id) {
    const { error } = await context.supabase
      .from("voice_numbers")
      .update({ phone_e164: phoneE164, provider_agent_id: agentId, active: true, brand_label: brandLabel })
      .eq("id", (existing as { id: string }).id);
    if (error) throw error;
    return;
  }
  const { error } = await context.supabase.from("voice_numbers").insert({
    organization_id: context.organizationId,
    company_id: companyId,
    phone_e164: phoneE164,
    provider: "retell",
    provider_agent_id: agentId,
    brand_label: brandLabel,
    active: true,
  });
  if (error) throw error;
}

export async function provisionPhoneForCompany(
  context: TenantServiceContext,
  input: ProvisionPhoneInput,
  client?: RetellClient,
): Promise<ProvisionResult> {
  const apiKey = getRetellApiKey();
  const retell = client ?? (apiKey ? createRetellClient(apiKey) : null);
  if (!retell) {
    console.error("[onboarding] RETELL_API_KEY is not set — can't provision a number.");
    throw new UserFacingError("Phone setup isn't available right now. Please contact support.", { status: 503, code: "voice_not_configured" });
  }

  const company = await loadCompany(context, input.companyId);
  const items = await listCatalogItems(context, input.companyId);
  // Each service with its price when the owner (or their own website) gave one — the prompt
  // tells Marina never to invent a price that isn't listed here.
  const services = items.map((i) => {
    const price = bookableService(i, DEFAULT_ONLINE_BOOKING_SETTINGS, false).priceLabel;
    return price ? `${i.label} — ${price}` : i.label;
  });
  const baseUrl = (process.env.APP_BASE_URL ?? "").replace(/\/$/, "");
  const webhookUrl = `${baseUrl}/api/retell/webhook`;
  const bookingUrl = bookingPageUrl(company);

  // The company's industry pack (if one was applied) adds trade FAQs / urgency keywords.
  const appliedPack = parseAppliedIndustryPack(company.industry_pack);
  const pack = appliedPack ? getPack(appliedPack.id) : null;

  const prompt = buildReceptionistPrompt(
    {
      companyName: company.name,
      services,
      hoursText: hoursToText(company.hours),
      bookingUrl,
      serviceArea: company.service_area,
      transferNumber: input.transferNumber ?? company.owner_phone_e164,
    },
    pack ? packReceptionistNotes(pack) : null,
  );

  const result = await provisionRetellAgent(retell, {
    companyName: company.name,
    prompt,
    voiceId: undefined,
    webhookUrl: webhookUrl || null,
    inboundWebhookUrl: baseUrl ? `${baseUrl}/api/retell/inbound` : null,
    areaCode: input.areaCode ?? null,
    attachNumber: input.attachNumber ?? null,
    existing: input.existing,
  });

  await upsertRetellVoiceNumber(context, input.companyId, result.phoneNumber, result.agentId, company.name);

  // Record the profile (prompt + from number). The inbound agent id lives on voice_numbers.
  await upsertCompanyVoiceProfile(context, {
    companyId: input.companyId,
    systemPrompt: prompt,
    brandLabel: company.name,
    fromNumber: result.phoneNumber,
    active: true,
  });

  return result;
}
