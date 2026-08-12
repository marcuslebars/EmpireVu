/**
 * Quote pricing — the money contract for Stripe-native quotes.
 *
 * The subtotal + line items come STRAIGHT from the shared @a1/pricing-engine
 * (calculateQuote, storage line), so a quote and a phone/calculator quote can never
 * diverge. This module adds only what the engine deliberately leaves out (see its
 * QuoteResult: "HST is added at booking, not computed here"):
 *   • HST on the subtotal (quote-time estimate; Stripe Tax is authoritative at charge),
 *   • the tax-inclusive total, and
 *   • the booking deposit = depositRate × total, round-half-up, never above the total.
 *
 * Pure + deterministic (calculateQuote is pure) so it can be locked with golden fixtures.
 * Money is integer cents throughout; callers round only at display.
 */
import { calculateQuote, type QuoteItemInput, type QuoteResult } from "@a1/pricing-engine";

import { getQuotesConfig } from "./config";

export type EngineType = "outboard" | "sterndrive" | "inboard";

/** A service the customer wants on the quote (storage line). */
export interface QuoteServiceInput {
  serviceId: string;
  lengthFt?: number;
  engineType?: EngineType;
  engineCount?: number;
}

export interface QuotePricingInput {
  services: QuoteServiceInput[];
  /** "pontoon" | "tritoon" | undefined — drives the per-foot hull surcharge. */
  hullType?: string;
  /** "winter_ready" | "winter_ready_plus" | "full_care" — applies the bundle discount. */
  bundleId?: string;
  /** Overrides; default from config (HST 13%, deposit 25%). */
  taxRateBps?: number;
  depositRateBps?: number;
}

export interface QuotePricedLineItem {
  serviceId: string;
  label: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  bundleEligible: boolean;
}

export interface QuotePricing {
  currency: "CAD";
  lineItems: QuotePricedLineItem[];
  bundleId: string | null;
  bundleSavingsCents: number;
  /** Pre-tax, after any bundle discount (the engine subtotal). */
  subtotalCents: number;
  taxRateBps: number;
  taxCents: number;
  /** subtotal + tax. */
  totalCents: number;
  depositRateBps: number;
  /** round-half-up(total × depositRate), clamped to never exceed the total. */
  depositCents: number;
}

/**
 * Exact integer round-half-up of numerator/denominator for non-negative inputs — no
 * floating-point drift on the .5 boundary (add half the divisor, then floor).
 */
export function roundHalfUpDiv(numerator: number, denominator: number): number {
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

/** Price a quote: engine subtotal + HST + tax-inclusive total + deposit. */
export function priceQuote(input: QuotePricingInput): QuotePricing {
  const cfg = getQuotesConfig();
  const taxRateBps = input.taxRateBps ?? cfg.taxRateBps;
  const depositRateBps = input.depositRateBps ?? cfg.depositRateBps;

  const items: QuoteItemInput[] = input.services.map((s) => ({
    serviceId: s.serviceId,
    lengthFt: s.lengthFt,
    engineType: s.engineType,
    engineCount: s.engineCount,
  }));

  // calculateQuote throws on invalid input (unknown service, missing length, bad bundle);
  // the caller validates + surfaces that as a 400 rather than swallowing it here.
  const engine: QuoteResult = calculateQuote({
    serviceLine: "storage",
    items,
    hullType: input.hullType,
    bundleId: input.bundleId,
  });

  const subtotalCents = engine.subtotalCents;
  const taxCents = roundHalfUpDiv(subtotalCents * taxRateBps, 10_000);
  const totalCents = subtotalCents + taxCents;
  const depositCents = Math.min(totalCents, roundHalfUpDiv(totalCents * depositRateBps, 10_000));

  return {
    currency: "CAD",
    lineItems: engine.lineItems.map((l) => ({
      serviceId: l.serviceId,
      label: l.label,
      description: l.description,
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
      amountCents: l.amountCents,
      bundleEligible: l.bundleEligible,
    })),
    bundleId: engine.bundle?.id ?? null,
    bundleSavingsCents: engine.bundleSavingsCents,
    subtotalCents,
    taxRateBps,
    taxCents,
    totalCents,
    depositRateBps,
    depositCents,
  };
}
