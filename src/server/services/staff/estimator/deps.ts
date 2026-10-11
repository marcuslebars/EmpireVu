/**
 * The estimator's side effects behind one injectable object, so tests can swap the model,
 * storage, quotes and texting without touching the registry (which calls the role with no
 * deps argument). `setEstimatorDeps` / `resetEstimatorDeps` are the test hooks.
 */
import Anthropic from "@anthropic-ai/sdk";

import { FRONT_DESK_DEFAULT_MODEL } from "@/server/ai/config";
import type { Tables } from "@/server/db/database.types";
import { SMS_AGENT_SENDER, type AdminClient, type InboundMedia } from "@/server/services/front-desk/contracts";
import { notifyOwnerOfApproval } from "@/server/services/owner-channel/notify";
import { sendOwnerSms } from "@/server/services/owner-channel/common";
import { priceQuoteForCompany, type QuoteCustomLineInput, type QuotePricing, type QuoteServiceInput } from "@/server/services/quotes/pricing";
import { quoteLinkForCompanyId } from "@/server/services/quotes/public-url";
import { createQuote, sendQuote } from "@/server/services/quotes/service";
import type { TenantServiceContext } from "@/server/services/shared";
import { loadBusinessFacts, type BusinessFacts } from "@/server/services/sms-agent/facts";
import { fetchMmsImages, type FetchedImage } from "@/server/services/sms-agent/media";
import { recordAiUsageSafe, type AiUsageInput } from "@/server/services/usage";
import { deliverMessage, type ConsentContact, type DeliverMessageResult } from "@/server/services/workflow-engine/messaging";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/** The quote source the estimator stamps on its quotes (quotes.source). */
export const ESTIMATOR_QUOTE_SOURCE = "estimator";

export interface EstimatorModelClient {
  createMessage(params: Anthropic.MessageCreateParamsNonStreaming, options: { signal: AbortSignal }): Promise<Anthropic.Message>;
}

export interface EstimatorContact extends ConsentContact {
  id: string;
  organization_id: string;
  company_id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
}

export interface CreatedQuote {
  quoteId: string;
  url: string;
  subtotalCents: number;
  totalCents: number;
}

export interface EstimatorDeps {
  now(): Date;
  /** AI_MODEL_ESTIMATOR, default claude-sonnet-5-5. */
  model(): string;
  modelClient(): EstimatorModelClient;
  /** Download MMS images (Twilio URLs, auth + SSRF guard — sms-agent/media.ts). */
  fetchImages(media: InboundMedia[]): Promise<FetchedImage[]>;
  /** Copy one photo into the private quote-photos bucket. */
  storePhoto(admin: AdminClient, path: string, image: FetchedImage): Promise<void>;
  /** Price list lines + custom lines exactly as the quote will (HST, deposit). */
  priceQuote(companyId: string, input: { services: QuoteServiceInput[]; customLines: QuoteCustomLineInput[] }): Promise<QuotePricing>;
  /** createQuote (source "estimator") + sendQuote → the customer link. */
  createAndSendQuote(
    admin: AdminClient,
    facts: Pick<BusinessFacts, "organizationId" | "companyId">,
    input: { contactId: string; services: QuoteServiceInput[]; customLines: QuoteCustomLineInput[]; title: string },
  ): Promise<CreatedQuote>;
  /** Company number, consent + STOP footer, message_log.sent_by = sms_agent. */
  textCustomer(admin: AdminClient, company: { organizationId: string; companyId: string }, contact: EstimatorContact, body: string): Promise<DeliverMessageResult>;
  /** The owner's verified cell, from the platform number. */
  textOwner(admin: AdminClient, company: { organizationId: string; companyId: string }, body: string): Promise<{ sent: boolean }>;
  /** Text the owner about a new approval (quiet hours etc. — owner-channel/notify.ts). */
  notify(admin: AdminClient, approvalId: string): Promise<{ notified: boolean }>;
  loadFacts(admin: AdminClient, companyId: string): Promise<BusinessFacts>;
  recordUsage(input: AiUsageInput): Promise<void>;
  recordQuoteEvent(admin: AdminClient, organizationId: string, quoteId: string, eventType: string, metadata: Record<string, unknown>): Promise<void>;
}

export const QUOTE_PHOTOS_BUCKET = "quote-photos";

export function getEstimatorModel(): string {
  return process.env.AI_MODEL_ESTIMATOR?.trim() || FRONT_DESK_DEFAULT_MODEL;
}

function ctxFor(admin: AdminClient, organizationId: string): TenantServiceContext {
  return { organizationId, actorProfileId: null, supabase: admin as unknown as TenantServiceContext["supabase"] };
}

export const defaultEstimatorDeps: EstimatorDeps = {
  now: () => new Date(),
  model: getEstimatorModel,
  modelClient() {
    const client = new Anthropic({ maxRetries: 1 });
    return { createMessage: (params, options) => client.messages.create(params, { signal: options.signal }) as Promise<Anthropic.Message> };
  },
  fetchImages: (media) => fetchMmsImages(media, { maxImages: 4 }),
  async storePhoto(admin, path, image) {
    const { error } = await (admin as Db).storage
      .from(QUOTE_PHOTOS_BUCKET)
      .upload(path, Buffer.from(image.base64, "base64"), { contentType: image.mediaType, upsert: true });
    if (error) throw error;
  },
  priceQuote: (companyId, input) => priceQuoteForCompany(companyId, input),
  async createAndSendQuote(admin, facts, input) {
    const ctx = ctxFor(admin, facts.organizationId);
    const quote = await createQuote(ctx, {
      companyId: facts.companyId,
      contactId: input.contactId,
      services: input.services,
      customLines: input.customLines,
      title: input.title,
      source: ESTIMATOR_QUOTE_SOURCE,
    });
    const sent = await sendQuote(ctx, quote.id);
    const url = await quoteLinkForCompanyId(facts.companyId, sent.quote.public_token, admin as Db);
    return { quoteId: sent.quote.id, url, subtotalCents: sent.quote.subtotal_cents, totalCents: sent.quote.total_cents };
  },
  textCustomer(admin, company, contact, body) {
    return deliverMessage({
      context: ctxFor(admin, company.organizationId),
      channel: "sms",
      to: contact.phone,
      body,
      companyId: company.companyId,
      contactId: contact.id,
      consentContact: contact,
      smsFrom: "company",
      sentBy: SMS_AGENT_SENDER,
    });
  },
  async textOwner(admin, company, body) {
    const { data } = await (admin as Db)
      .from("companies")
      .select("owner_phone_e164, owner_phone_verified_at")
      .eq("organization_id", company.organizationId)
      .eq("id", company.companyId)
      .maybeSingle();
    const row = data as Pick<Tables<"companies">, "owner_phone_e164" | "owner_phone_verified_at"> | null;
    if (!row?.owner_phone_e164 || !row.owner_phone_verified_at) return { sent: false };
    const { data: org } = await (admin as Db).from("organizations").select("platform_brand").eq("id", company.organizationId).maybeSingle();
    const sent = await sendOwnerSms(admin, {
      to: row.owner_phone_e164,
      body,
      organizationId: company.organizationId,
      companyId: company.companyId,
      platformBrand: (org as { platform_brand: string | null } | null)?.platform_brand ?? null,
    });
    return { sent: sent.status === "sent" };
  },
  notify: (admin, approvalId) => notifyOwnerOfApproval(admin, approvalId),
  loadFacts: loadBusinessFacts,
  recordUsage: (input) => recordAiUsageSafe(input),
  async recordQuoteEvent(admin, organizationId, quoteId, eventType, metadata) {
    try {
      await (admin as Db).from("quote_events").insert({ organization_id: organizationId, quote_id: quoteId, event_type: eventType, actor_profile_id: null, metadata });
    } catch (err) {
      console.error(`[estimator] failed to record '${eventType}':`, err instanceof Error ? err.message : err);
    }
  },
};

let current: EstimatorDeps = defaultEstimatorDeps;

export function estimatorDeps(): EstimatorDeps {
  return current;
}

/** Test hook: override some deps (the rest stay the defaults). */
export function setEstimatorDeps(over: Partial<EstimatorDeps>): void {
  current = { ...defaultEstimatorDeps, ...over };
}

export function resetEstimatorDeps(): void {
  current = defaultEstimatorDeps;
}
