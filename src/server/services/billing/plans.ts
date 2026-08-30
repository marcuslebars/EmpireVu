import type Stripe from "stripe";

import {
  PLAN_FEATURE_DEFAULTS,
  PURCHASABLE_PLANS,
  type BillingFeature,
  type PurchasablePlan,
} from "@/server/services/billing/config";
import { getStripePriceId, getStripeSetupFeePriceId } from "@/server/services/billing/env";
import { getStripeClient } from "@/server/services/billing/stripe";

export interface PlanPricing {
  amountCents: number | null;
  available: boolean;
  currency: string | null;
  features: Record<BillingFeature, boolean>;
  interval: string | null;
  plan: PurchasablePlan;
  priceId: string | null;
  setupFeeCents: number | null;
}

/**
 * Live plan pricing read straight from Stripe (prices are the source of truth —
 * no dollar amounts in code). Resilient: a plan whose price env is unset or whose
 * Stripe lookup fails comes back `available: false` with null amounts rather than
 * failing the whole request, so the billing page still renders its feature matrix.
 */
export async function listPlanPricing(): Promise<PlanPricing[]> {
  let stripe: Stripe | null = null;
  try {
    stripe = getStripeClient();
  } catch {
    stripe = null;
  }

  const results: PlanPricing[] = [];
  for (const plan of PURCHASABLE_PLANS) {
    const fallback: PlanPricing = {
      amountCents: null,
      available: false,
      currency: null,
      features: PLAN_FEATURE_DEFAULTS[plan],
      interval: null,
      plan,
      priceId: null,
      setupFeeCents: null,
    };

    if (!stripe) {
      results.push(fallback);
      continue;
    }

    try {
      const priceId = getStripePriceId(plan);
      const price = await stripe.prices.retrieve(priceId);
      const setupId = getStripeSetupFeePriceId(plan);
      const setup = setupId ? await stripe.prices.retrieve(setupId) : null;

      results.push({
        amountCents: price.unit_amount ?? null,
        available: (price.unit_amount ?? null) !== null,
        currency: price.currency ?? null,
        features: PLAN_FEATURE_DEFAULTS[plan],
        interval: price.recurring?.interval ?? null,
        plan,
        priceId,
        setupFeeCents: setup?.unit_amount ?? null,
      });
    } catch {
      results.push(fallback);
    }
  }

  return results;
}
