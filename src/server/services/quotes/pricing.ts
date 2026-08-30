/**
 * Quote pricing — the money contract for Stripe-native quotes.
 *
 * Line items and the subtotal come from the TENANT'S OWN service catalog
 * (catalog.ts), not from any one customer's rate card. This module adds what the
 * catalog deliberately leaves out:
 *   • HST on the subtotal (quote-time estimate; Stripe Tax is authoritative at
 *     charge time),
 *   • the tax-inclusive total, and
 *   • the booking deposit = depositRate × total, round-half-up, never above the
 *     total.
 *
 * Two things the catalog cannot express, added here:
 *   • OPTIONAL lines. The customer ticks them on the hosted page and the totals
 *     move live. A deselected optional is excluded from the catalog call
 *     entirely — not subtracted afterwards — so bundle eligibility is computed
 *     against the cart the customer actually chose. Deselected lines still come
 *     back priced à la carte so the page can show what ticking one would add.
 *   • CUSTOM lines. Hand-quoted work carries its own amount and never
 *     participates in a bundle.
 *
 * priceQuote stays PURE — the catalog is passed in, not fetched. That is what
 * lets the golden fixtures price without a database, and it keeps the money math
 * testable in isolation. `priceQuoteForCompany` is the thin async wrapper that
 * loads a tenant's catalog first.
 *
 * FIELD NAMES: the quote layer keeps `serviceId` / `lengthFt` / `engineCount`
 * because thousands of stored `input_snapshot` rows use them. They are mapped to
 * the catalog's domain-neutral `serviceKey` / `measure` / `quantity` at the
 * boundary below, so old quotes reprice unchanged.
 *
 * Money is integer cents throughout; callers round only at display.
 */
import { loadCatalog } from "./catalog-repo";
import {
  priceFromCatalog,
  type CatalogLineInput,
  type CatalogPricing,
  type ServiceCatalog,
} from "./catalog";
import { getQuotesConfig } from "./config";

export type EngineType = "outboard" | "sterndrive" | "inboard";

/** A service the customer wants on the quote. */
export interface QuoteServiceInput {
  serviceId: string;
  lengthFt?: number;
  engineType?: EngineType;
  engineCount?: number;
  /** Unit count for per-unit services (batteries, PWCs, trips, months). */
  quantity?: number;
  /** Distance for distance-priced services. */
  distanceKm?: number;
  /** Customer may toggle this line on the hosted quote page. */
  optional?: boolean;
  /** Current selection. Required lines are always on; optional lines default OFF. */
  selected?: boolean;
}

/** A hand-priced line. Never catalog-computed, never bundle-eligible. */
export interface QuoteCustomLineInput {
  label: string;
  description?: string;
  amountCents: number;
  optional?: boolean;
  selected?: boolean;
}

export interface QuotePricingInput {
  /** The tenant's price list. Required — there is no default catalog. */
  catalog: ServiceCatalog;
  services: QuoteServiceInput[];
  customLines?: QuoteCustomLineInput[];
  /** Selects a variant surcharge, e.g. "pontoon". */
  hullType?: string;
  /** Applies a bundle discount, e.g. "winter_ready_plus". */
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
  optional: boolean;
  selected: boolean;
  custom: boolean;
}

export interface QuotePricing {
  currency: "CAD";
  lineItems: QuotePricedLineItem[];
  bundleId: string | null;
  bundleSavingsCents: number;
  subtotalCents: number;
  taxRateBps: number;
  taxCents: number;
  totalCents: number;
  depositRateBps: number;
  depositCents: number;
}

/**
 * Exact integer round-half-up of numerator/denominator for non-negative inputs —
 * no floating-point drift on the .5 boundary (add half the divisor, then floor).
 */
export function roundHalfUpDiv(numerator: number, denominator: number): number {
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

/** Required lines are always on; optional lines are off unless explicitly selected. */
function isSelected(line: { optional?: boolean; selected?: boolean }): boolean {
  if (!line.optional) return true;
  return line.selected === true;
}

/**
 * Quote-layer input -> catalog input.
 *
 * `lengthFt` and `distanceKm` are both a measured dimension; `engineCount` and
 * `quantity` are both a unit count. The catalog has one concept for each.
 */
function toCatalogLine(s: QuoteServiceInput): CatalogLineInput {
  return {
    serviceKey: s.serviceId,
    measure: s.lengthFt ?? s.distanceKm,
    quantity: s.quantity ?? s.engineCount,
  };
}

/** Price a quote: catalog subtotal + HST + tax-inclusive total + deposit. Pure. */
export function priceQuote(input: QuotePricingInput): QuotePricing {
  const cfg = getQuotesConfig();
  const taxRateBps = input.taxRateBps ?? cfg.taxRateBps;
  const depositRateBps = input.depositRateBps ?? cfg.depositRateBps;

  const selectedServices = input.services.filter(isSelected);
  const unselectedServices = input.services.filter((s) => !isSelected(s));

  // priceFromCatalog throws on invalid input (unknown service, missing measure,
  // bad bundle); the caller surfaces that as a 400 rather than swallowing it. It
  // also rejects an empty cart, so a quote whose every line is a deselected
  // optional (or is entirely custom) skips the catalog rather than throwing.
  const priced: CatalogPricing | null =
    selectedServices.length > 0
      ? priceFromCatalog({
          catalog: input.catalog,
          lines: selectedServices.map(toCatalogLine),
          variant: input.hullType ?? null,
          bundleKey: input.bundleId ?? null,
        })
      : null;

  // Deselected optional lines still need a price beside their checkbox. Each is
  // priced à la carte — alone, no bundle — which is exactly what it would add.
  const unselectedPriced = unselectedServices.map((s) => {
    const solo = priceFromCatalog({
      catalog: input.catalog,
      lines: [toCatalogLine(s)],
      variant: input.hullType ?? null,
    });
    return solo.lines[0];
  });

  const customLines = input.customLines ?? [];
  const selectedCustomCents = customLines
    .filter(isSelected)
    .reduce((sum, l) => sum + l.amountCents, 0);

  const subtotalCents = (priced?.subtotalCents ?? 0) + selectedCustomCents;
  const taxCents = roundHalfUpDiv(subtotalCents * taxRateBps, 10_000);
  const totalCents = subtotalCents + taxCents;
  const depositCents = Math.min(totalCents, roundHalfUpDiv(totalCents * depositRateBps, 10_000));

  const lineItems: QuotePricedLineItem[] = [
    ...(priced?.lines ?? []).map((l, i) => ({
      serviceId: l.serviceKey,
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
      serviceId: l.serviceKey,
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
    bundleId: priced?.bundle?.key ?? null,
    bundleSavingsCents: priced?.bundleSavingsCents ?? 0,
    subtotalCents,
    taxRateBps,
    taxCents,
    totalCents,
    depositRateBps,
    depositCents,
  };
}

/**
 * Price a quote for a tenant, loading their catalog first.
 *
 * The only async entry point. Everything that prices a real quote goes through
 * here; `priceQuote` stays pure for tests and for callers that already hold a
 * catalog.
 */
export async function priceQuoteForCompany(
  companyId: string,
  input: Omit<QuotePricingInput, "catalog">,
): Promise<QuotePricing> {
  const catalog = await loadCatalog(companyId);
  return priceQuote({ ...input, catalog });
}
