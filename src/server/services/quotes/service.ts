import { randomBytes } from "node:crypto";

import {
  assertCompanyInOrganization,
  assertContactInOrganization,
  type TenantServiceContext,
} from "@/server/services/shared";
import { getQuotesConfig } from "./config";
import { priceQuote, type QuotePricing, type QuotePricingInput } from "./pricing";

// quotes + quote_events aren't in the generated database.types.ts (no gen-types step),
// same as the jobber_/retell_ tables — access them via the client cast to any, shaping
// rows with the interfaces below. Regenerating database.types.ts restores typing
// (tracked in docs/stripe-quotes.md).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tbl = (ctx: TenantServiceContext, name: string): any => (ctx.supabase as any).from(name);

export interface CreateQuoteInput {
  contactId?: string | null;
  companyId?: string | null;
  services: QuotePricingInput["services"];
  hullType?: string;
  bundleId?: string;
  notes?: string;
  source?: string;
  /** Server policy overrides — not exposed to clients; default from config. */
  taxRateBps?: number;
  depositRateBps?: number;
}

export interface QuoteRow {
  id: string;
  organization_id: string;
  company_id: string | null;
  contact_id: string | null;
  public_token: string;
  quote_number: string | null;
  status: string;
  currency: string;
  line_items: unknown;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  deposit_cents: number;
  tax_rate_bps: number;
  deposit_rate_bps: number;
  bundle_id: string | null;
  input_snapshot: unknown;
  notes: string | null;
  source: string | null;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function genPublicToken(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Create a quote: price it from the shared engine, persist the priced snapshot, and
 * append the 'created' audit event. Runs under the caller's RLS client (org members
 * may write), so the scope guards below turn an out-of-org contact/company into a
 * clean 400 rather than an RLS insert failure.
 */
export async function createQuote(ctx: TenantServiceContext, input: CreateQuoteInput): Promise<QuoteRow> {
  await assertContactInOrganization(ctx, input.contactId ?? undefined);
  await assertCompanyInOrganization(ctx, input.companyId ?? undefined);

  const pricing: QuotePricing = priceQuote({
    services: input.services,
    hullType: input.hullType,
    bundleId: input.bundleId,
    taxRateBps: input.taxRateBps,
    depositRateBps: input.depositRateBps,
  });

  const cfg = getQuotesConfig();
  const expiresAt = new Date(Date.now() + cfg.expiryDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await tbl(ctx, "quotes")
    .insert({
      organization_id: ctx.organizationId,
      company_id: input.companyId ?? null,
      contact_id: input.contactId ?? null,
      public_token: genPublicToken(),
      status: "draft",
      currency: pricing.currency,
      line_items: pricing.lineItems,
      subtotal_cents: pricing.subtotalCents,
      tax_cents: pricing.taxCents,
      total_cents: pricing.totalCents,
      deposit_cents: pricing.depositCents,
      tax_rate_bps: pricing.taxRateBps,
      deposit_rate_bps: pricing.depositRateBps,
      bundle_id: pricing.bundleId,
      input_snapshot: {
        services: input.services,
        hullType: input.hullType ?? null,
        bundleId: input.bundleId ?? null,
      },
      notes: input.notes ?? null,
      source: input.source ?? null,
      expires_at: expiresAt,
      created_by: ctx.actorProfileId,
    })
    .select("*")
    .single();

  if (error) throw error;
  const quote = data as QuoteRow;

  // Append the 'created' audit event — best-effort; the quote is already durable.
  try {
    await tbl(ctx, "quote_events").insert({
      organization_id: ctx.organizationId,
      quote_id: quote.id,
      event_type: "created",
      actor_profile_id: ctx.actorProfileId,
      metadata: {
        subtotalCents: quote.subtotal_cents,
        totalCents: quote.total_cents,
        depositCents: quote.deposit_cents,
      },
    });
  } catch (err) {
    console.error("[quotes] failed to record 'created' event:", err);
  }

  return quote;
}

export async function listQuotes(
  ctx: TenantServiceContext,
  opts: { limit?: number } = {},
): Promise<QuoteRow[]> {
  const { data, error } = await tbl(ctx, "quotes")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(opts.limit ?? 50, 1), 100));
  if (error) throw error;
  return (data ?? []) as QuoteRow[];
}
