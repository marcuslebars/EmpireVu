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
 * Two things the engine cannot express, added here:
 *   • OPTIONAL lines. The customer ticks them on the hosted page and the totals move
 *     live. A deselected optional line is excluded from the engine call entirely —
 *     not subtracted afterwards — so bundle eligibility and the bundle discount are
 *     computed against the cart the customer actually chose. Deselected lines are
 *     still returned, priced à la carte, so the page can show what each would add.
 *   • CUSTOM lines. Care work (restoration, detailing) is quoted by hand and is
 *     never engine-computed; a custom line carries its own amount and never
 *     participates in a bundle.
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
  /** Unit count for per_unit services (batteries, PWCs, transport trips, vessel-months). */
  quantity?: number;
  /** Distance for per_km services (transport beyond the extended band). */
  distanceKm?: number;
  /** Customer may toggle this line on the hosted quote page. */
  optional?: boolean;
  /** Current selection. Required lines are always on; optional lines default OFF. */
  selected?: boolean;
}

/** A hand-priced line (Care work). Never engine-computed, never bundle-eligible. */
export interface QuoteCustomLineInput {
  label: string;
  description?: string;
  amountCents: number;
  optional?: boolean;
  selected?: boolean;
}

export interface QuotePricingInput {
  services: QuoteServiceInput[];
  /** Hand-priced Care lines. */
  customLines?: QuoteCustomLineInput[];
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
  /** Customer-toggleable on the hosted page. */
  optional: boolean;
  /** Whether this line is currently counted in the totals. */
  selected: boolean;
  /** Hand-priced (Care) rather than engine-computed. */
  custom: boolean;
}

export interface QuotePricing {
  currency: "CAD";
  /** Every line — selected and not. Only selected lines are in the totals. */
  lineItems: QuotePricedLineItem[];
  bundleId: string | null;
  bundleSavingsCents: number;
  /** Pre-tax, after any bundle discount (engine subtotal + selected custom lines). */
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

/** Required lines are always on; optional lines are off unless explicitly selected. */
function isSelected(line: { optional?: boolean; selected?: boolean }): boolean {
  if (!line.optional) return true;
  return line.selected === true;
}

function toEngineItem(s: QuoteServiceInput): QuoteItemInput {
  return {
    serviceId: s.serviceId,
    lengthFt: s.lengthFt,
    engineType: s.engineType,
    engineCount: s.engineCount,
    quantity: s.quantity,
    distanceKm: s.distanceKm,
  };
}

/** Price a quote: engine subtotal + HST + tax-inclusive total + deposit. */
export function priceQuote(input: QuotePricingInput): QuotePricing {
  const cfg = getQuotesConfig();
  const taxRateBps = input.taxRateBps ?? cfg.taxRateBps;
  const depositRateBps = input.depositRateBps ?? cfg.depositRateBps;

  const selectedServices = input.services.filter(isSelected);
  const unselectedServices = input.services.filter((s) => !isSelected(s));

  // calculateQuote throws on invalid input (unknown service, missing length, bad bundle);
  // the caller validates + surfaces that as a 400 rather than swallowing it here. It also
  // rejects an empty cart, so a quote whose every line is a deselected optional (or is
  // entirely custom) skips the engine rather than throwing.
  const engine: QuoteResult | null =
    selectedServices.length > 0
      ? calculateQuote({
          serviceLine: "storage",
          items: selectedServices.map(toEngineItem),
          hullType: input.hullType,
          bundleId: input.bundleId,
        })
      : null;

  // Deselected optional lines still need a price to show next to their checkbox.
  // Each is priced à la carte — on its own, with no bundle — which is exactly what
  // it would add if the customer ticked it.
  const unselectedPriced = unselectedServices.map((s) => {
    const solo = calculateQuote({
      serviceLine: "storage",
      items: [toEngineItem(s)],
      hullType: input.hullType,
    });
    return solo.lineItems[0];
  });

  const customLines = input.customLines ?? [];
  const selectedCustomCents = customLines
    .filter(isSelected)
    .reduce((sum, l) => sum + l.amountCents, 0);

  const subtotalCents = (engine?.subtotalCents ?? 0) + selectedCustomCents;
  const taxCents = roundHalfUpDiv(subtotalCents * taxRateBps, 10_000);
  const totalCents = subtotalCents + taxCents;
  const depositCents = Math.min(totalCents, roundHalfUpDiv(totalCents * depositRateBps, 10_000));

  const lineItems: QuotePricedLineItem[] = [
    ...(engine?.lineItems ?? []).map((l, i) => ({
      serviceId: l.serviceId,
      label: l.label,
      description: l.description,
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
      amountCents: l.amountCents,
      bundleEligible: l.bundleEligible,
      optional: selectedServices[i]?.optional === true,
      selected: true,
      custom: false,
    })),
    ...unselectedPriced.map((l) => ({
      serviceId: l.serviceId,
      label: l.label,
      description: l.description,
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
      amountCents: l.amountCents,
      bundleEligible: false,
      optional: true,
      selected: false,
      custom: false,
    })),
    ...customLines.map((l) => ({
      serviceId: "custom",
      label: l.label,
      description: l.description ?? l.label,
      quantity: 1,
      unitPriceCents: l.amountCents,
      amountCents: l.amountCents,
      bundleEligible: false,
      optional: l.optional === true,
      selected: isSelected(l),
      custom: true,
    })),
  ];

  return {
    currency: "CAD",
    lineItems,
    bundleId: engine?.bundle?.id ?? null,
    bundleSavingsCents: engine?.bundleSavingsCents ?? 0,
    subtotalCents,
    taxRateBps,
    taxCents,
    totalCents,
    depositRateBps,
    depositCents,
  };
}
