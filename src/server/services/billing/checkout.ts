import type Stripe from "stripe";

import type { Tables } from "@/server/db/database.types";
import type { PurchasablePlan } from "@/server/services/billing/config";
import {
  getAppBaseUrl,
  getStripePriceId,
  getStripeSetupFeePriceId,
} from "@/server/services/billing/env";
import { getStripeClient } from "@/server/services/billing/stripe";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";

type AdminSupabaseClient = ReturnType<typeof createSupabaseAdminClient>;

async function loadOrganization(
  supabase: AdminSupabaseClient,
  organizationId: string,
): Promise<Tables<"organizations">> {
  const { data, error } = await supabase
    .from("organizations")
    .select("*")
    .eq("id", organizationId)
    .single();

  if (error || !data) {
    throw new Error(`Organization ${organizationId} not found: ${error?.message ?? "no row"}`);
  }
  return data as Tables<"organizations">;
}

/**
 * Return the org's Stripe customer id, creating (and persisting) it first if
 * absent. The id is written to the org row BEFORE any Checkout/Portal redirect,
 * so a crash mid-flow never loses the org↔customer mapping. A Stripe idempotency
 * key (keyed by org id) prevents duplicate customers on retries.
 */
async function ensureStripeCustomer(
  supabase: AdminSupabaseClient,
  org: Tables<"organizations">,
): Promise<string> {
  if (org.stripe_customer_id) {
    return org.stripe_customer_id;
  }

  const stripe = getStripeClient();
  const customer = await stripe.customers.create(
    {
      email: org.billing_email ?? undefined,
      metadata: { organizationId: org.id },
      name: org.name,
    },
    { idempotencyKey: `org-customer-${org.id}` },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase.from("organizations") as any)
    .update({ stripe_customer_id: customer.id })
    .eq("id", org.id);

  if (error) {
    throw new Error(
      `Created Stripe customer ${customer.id} but failed to persist it to org ${org.id}: ${error.message}`,
    );
  }
  return customer.id;
}

export interface CreateCheckoutSessionParams {
  organizationId: string;
  plan: PurchasablePlan;
  successUrl?: string;
  cancelUrl?: string;
}

/**
 * Create a Stripe Checkout session (subscription mode) for an org + target plan.
 * Creates + stores the Stripe customer first if needed. Prices come from Stripe
 * via env (no amounts in code); an optional one-time setup-fee price is added to
 * the first invoice as an extra line item.
 */
export async function createCheckoutSession(
  supabase: AdminSupabaseClient,
  params: CreateCheckoutSessionParams,
): Promise<{ url: string; sessionId: string }> {
  const org = await loadOrganization(supabase, params.organizationId);
  const customerId = await ensureStripeCustomer(supabase, org);
  const stripe = getStripeClient();

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    { price: getStripePriceId(params.plan), quantity: 1 },
  ];
  const setupFeePrice = getStripeSetupFeePriceId(params.plan);
  if (setupFeePrice) {
    lineItems.push({ price: setupFeePrice, quantity: 1 });
  }

  const base = getAppBaseUrl();
  const session = await stripe.checkout.sessions.create({
    cancel_url: params.cancelUrl ?? `${base}/settings/billing?checkout=cancelled`,
    customer: customerId,
    line_items: lineItems,
    metadata: { organizationId: org.id, plan: params.plan },
    mode: "subscription",
    subscription_data: { metadata: { organizationId: org.id, plan: params.plan } },
    success_url: params.successUrl ?? `${base}/settings/billing?checkout=success`,
  });

  if (!session.url) {
    throw new Error("Stripe did not return a Checkout URL.");
  }
  return { sessionId: session.id, url: session.url };
}

/**
 * Create a Stripe Billing Portal session for an org (self-serve upgrade/downgrade
 * /cancel/payment-method). Requires an existing Stripe customer.
 */
export async function createBillingPortalSession(
  supabase: AdminSupabaseClient,
  params: { organizationId: string; returnUrl?: string },
): Promise<{ url: string }> {
  const org = await loadOrganization(supabase, params.organizationId);

  if (!org.stripe_customer_id) {
    throw new Error(
      `Organization ${params.organizationId} has no Stripe customer; run checkout first.`,
    );
  }

  const stripe = getStripeClient();
  const session = await stripe.billingPortal.sessions.create({
    customer: org.stripe_customer_id,
    return_url: params.returnUrl ?? `${getAppBaseUrl()}/settings/billing`,
  });

  return { url: session.url };
}
