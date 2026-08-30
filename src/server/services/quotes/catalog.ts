/**
 * Catalog pricing — the tenant-agnostic replacement for @a1/pricing-engine.
 *
 * PURE. Catalog in, priced lines out, no I/O. That is what lets the golden
 * fixtures prove the extraction did not move a single cent: the same inputs that
 * ran through the boat-storage engine run through this and must produce identical
 * integers.
 *
 * The model knows nothing about boats. `lengthFt` became `measure`, `engineCount`
 * became `quantity`, and hull type became a `variant`. The five pricing types
 * cover A1's cases and generalise: per_measure is per-foot, per-km, per-sq-ft or
 * per-hour; per_unit_declining is "engine 2+ at 75%" or "additional rooms at 60%".
 *
 * Money is integer cents throughout. Rounding happens in the named helpers below
 * and nowhere else — scattered Math.round is how cent drift gets in.
 */

export type PricingType =
  | "flat"
  | "per_unit"
  | "per_measure"
  | "per_unit_declining"
  | "tiered_by_measure"
  | "per_measure_banded";

/**
 * A choice that SCALES the rate — service tier, boat type, grade, urgency.
 * Groups multiply together, so tier x type is one price.
 */
export interface ModifierOption {
  key: string;
  label: string;
  multiplier: number;
}

export interface ModifierGroup {
  key: string;
  label: string;
  required?: boolean;
  options: ModifierOption[];
}

/**
 * A combination that must NOT be auto-quoted.
 *
 * Some work has to be eyeballed before a number is given — a yacht deep-clean, a
 * rush job on a hazardous site. Every `when` pair must match the customer's
 * selection for the rule to fire. Without this the catalog would confidently
 * quote jobs the business deliberately refuses to quote blind, which is how you
 * underprice the biggest work you take on.
 */
export interface ReviewRule {
  when: Record<string, string>;
  reason: string;
}

/** A per-measure RATE chosen by band. Distinct from tiered_by_measure, which picks a flat price. */
export interface RateBand {
  maxMeasure: number | null;
  rateCents: number;
}

export interface CatalogTier {
  /** Upper bound of the band; null is the open-ended top band. */
  maxMeasure: number | null;
  rateCents: number;
}

export interface CatalogItem {
  serviceKey: string;
  label: string;
  description?: string | null;
  pricingType: PricingType;
  rateCents: number;
  minimumCents: number;
  unitLabel?: string | null;
  additionalUnitMultiplier?: number | null;
  tiers?: CatalogTier[] | null;
  /** per_measure_banded: the rate changes by band; the per-measure math does not. */
  rateBands?: RateBand[] | null;
  /** Choices that scale the rate. Groups multiply. */
  modifierGroups?: ModifierGroup[] | null;
  /** Combinations this business will not auto-quote. */
  reviewRules?: ReviewRule[] | null;
  maxQuantity?: number | null;
  maxMeasure?: number | null;
  surchargeEligible: boolean;
}

export interface CatalogBundle {
  bundleKey: string;
  label: string;
  discountPct: number;
  /** A trailing '*' matches a family, e.g. "winterization_*". */
  serviceKeys: string[];
}

export interface CatalogSurcharge {
  variantKey: string;
  label: string;
  perMeasureCents: number;
}

export interface ServiceCatalog {
  items: Record<string, CatalogItem>;
  bundles: Record<string, CatalogBundle>;
  surcharges: Record<string, CatalogSurcharge>;
}

export interface CatalogLineInput {
  serviceKey: string;
  /** The measured dimension for per_measure / tiered_by_measure (feet, km, hours). */
  measure?: number;
  /** Unit count for per_unit / per_unit_declining. */
  quantity?: number;
  /** Free-form, carried through to the line for display. */
  note?: string;
  /** Selected modifier options, keyed by group: { tier: "deep", boatType: "cruiser" }. */
  modifiers?: Record<string, string>;
}

export interface CatalogPriceInput {
  catalog: ServiceCatalog;
  lines: CatalogLineInput[];
  /** Selects a surcharge, e.g. "pontoon". */
  variant?: string | null;
  bundleKey?: string | null;
}

export interface PricedLine {
  serviceKey: string;
  label: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  bundleEligible: boolean;
  detail: {
    pricingType: PricingType;
    rateCents?: number;
    measure?: number;
    quantity?: number;
    minimumCents?: number;
    minimumApplied?: boolean;
    surchargePerMeasureCents?: number;
    surchargeCents?: number;
    /** Product of the selected modifier multipliers; 1 when none apply. */
    modifierMultiplier?: number;
    modifiers?: Record<string, string>;
    additionalUnitMultiplier?: number;
    additionalUnitCents?: number;
  };
}

export interface CatalogPricing {
  lines: PricedLine[];
  bundle: { key: string; label: string; discountPct: number; eligibleCents: number; discountCents: number } | null;
  aLaCarteCents: number;
  bundleSavingsCents: number;
  subtotalCents: number;
}

export class CatalogError extends Error {
  constructor(
    message: string,
    readonly code: "unknown_service" | "bad_input" | "unknown_bundle" | "empty" | "requires_review",
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

// Guards against absurd inputs reaching the money math.
const MAX_MEASURE = 1000;
const MAX_QUANTITY = 100;

/** Money helpers. All rounding lives here. */
export const money = {
  perMeasure: (rateCents: number, measure: number) => Math.round(rateCents * measure),
  atLeast: (amountCents: number, minimumCents: number) => Math.max(amountCents, minimumCents),
  discount: (eligibleCents: number, pct: number) => Math.round((eligibleCents * pct) / 100),
  /**
   * Additional-unit price, rounded to the nearest whole DOLLAR.
   *
   * Not an accident: it keeps multi-unit lines quoting in clean dollars
   * ($275 x 0.75 = $206.25 -> $206). Inherited from the original engine, and the
   * golden fixtures depend on it — changing it would silently reprice every
   * multi-engine quote.
   */
  additionalUnit: (baseRateCents: number, multiplier: number) =>
    Math.round((baseRateCents * multiplier) / 100) * 100,
  format: (cents: number) => {
    const sign = cents < 0 ? "-" : "";
    const abs = Math.abs(cents);
    const dollars = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${sign}$${dollars}.${(abs % 100).toString().padStart(2, "0")}`;
  },
};

function requireMeasure(line: CatalogLineInput, item: CatalogItem): number {
  const m = line.measure;
  if (typeof m !== "number" || !Number.isFinite(m) || m <= 0) {
    throw new CatalogError(`"${line.serviceKey}" requires a positive measure (got ${String(m)}).`, "bad_input");
  }
  const cap = item.maxMeasure ?? MAX_MEASURE;
  if (m > cap) {
    throw new CatalogError(`"${line.serviceKey}" measure ${m} exceeds the ${cap} maximum.`, "bad_input");
  }
  return m;
}

function requireQuantity(line: CatalogLineInput, item: CatalogItem): number {
  const q = line.quantity ?? 1;
  if (!Number.isInteger(q) || q < 1) {
    throw new CatalogError(`"${line.serviceKey}" requires a quantity >= 1 (got ${String(line.quantity)}).`, "bad_input");
  }
  const cap = item.maxQuantity ?? MAX_QUANTITY;
  if (q > cap) {
    throw new CatalogError(`"${line.serviceKey}" quantity ${q} exceeds the ${cap} maximum.`, "bad_input");
  }
  return q;
}

/**
 * Resolve the multiplier for a line's chosen modifiers.
 *
 * A required group with nothing chosen is an error rather than a silent 1.0: the
 * difference between a "refresh" and a "restoration" detail is 60% of the price,
 * and quoting the cheaper one because a field was missing is the expensive
 * failure. An unknown option key is likewise rejected — better a 400 at creation
 * than a customer charged at a rate nobody configured.
 */
export function resolveModifiers(
  item: CatalogItem,
  chosen: Record<string, string> | undefined,
): { multiplier: number; selected: Record<string, string> } {
  const groups = item.modifierGroups ?? [];
  if (groups.length === 0) return { multiplier: 1, selected: {} };

  let multiplier = 1;
  const selected: Record<string, string> = {};

  for (const group of groups) {
    const pick = chosen?.[group.key];
    if (!pick) {
      if (group.required) {
        throw new CatalogError(
          `"${item.serviceKey}" requires a choice for "${group.label}".`,
          "bad_input",
        );
      }
      continue;
    }
    const option = group.options.find((o) => o.key === pick);
    if (!option) {
      throw new CatalogError(
        `"${pick}" is not a valid ${group.label} for "${item.serviceKey}".`,
        "bad_input",
      );
    }
    multiplier *= option.multiplier;
    selected[group.key] = option.key;
  }

  return { multiplier, selected };
}

/**
 * Refuse to price a combination the business quotes by hand.
 *
 * Thrown, not returned as zero: a zero would flow into a subtotal and a customer
 * could be shown a free job. An error stops the quote where a human can pick it up.
 */
export function assertQuotable(item: CatalogItem, selected: Record<string, string>): void {
  for (const rule of item.reviewRules ?? []) {
    const matches = Object.entries(rule.when).every(([group, option]) => selected[group] === option);
    if (matches) {
      throw new CatalogError(
        `"${item.serviceKey}" needs a manual quote: ${rule.reason}`,
        "requires_review",
      );
    }
  }
}

/** The per-measure rate for a banded item. */
function bandedRate(item: CatalogItem, measure: number): number {
  const bands = item.rateBands ?? [];
  const band = bands.find((b) => b.maxMeasure == null || measure <= b.maxMeasure) ?? bands[bands.length - 1];
  if (!band) throw new CatalogError(`"${item.serviceKey}" has no rate bands configured.`, "bad_input");
  return band.rateCents;
}

function surchargePerMeasure(
  catalog: ServiceCatalog,
  variant: string | null | undefined,
  eligible: boolean,
): number {
  if (!eligible || !variant) return 0;
  return catalog.surcharges[variant]?.perMeasureCents ?? 0;
}

function priceLine(input: CatalogPriceInput, line: CatalogLineInput): PricedLine {
  const item = input.catalog.items[line.serviceKey];
  if (!item) throw new CatalogError(`Unknown service: "${line.serviceKey}".`, "unknown_service");

  const base = {
    serviceKey: item.serviceKey,
    label: item.label,
    bundleEligible: false,
    quantity: 1,
  };

  switch (item.pricingType) {
    case "flat":
      return {
        ...base,
        description: item.label,
        unitPriceCents: item.rateCents,
        amountCents: item.rateCents,
        detail: { pricingType: "flat", rateCents: item.rateCents },
      };

    case "per_unit": {
      const qty = requireQuantity(line, item);
      const amount = item.rateCents * qty;
      return {
        ...base,
        description:
          qty > 1
            ? `${item.label} — ${qty} × ${money.format(item.rateCents)}/${item.unitLabel ?? "unit"}`
            : item.label,
        unitPriceCents: amount,
        amountCents: amount,
        detail: { pricingType: "per_unit", rateCents: item.rateCents, quantity: qty },
      };
    }

    case "per_unit_declining": {
      const qty = requireQuantity(line, item);
      const multiplier = item.additionalUnitMultiplier ?? 1;
      const addUnit = money.additionalUnit(item.rateCents, multiplier);
      const amount = item.rateCents + (qty - 1) * addUnit;
      return {
        ...base,
        description:
          qty > 1
            ? `${item.label} — ${item.unitLabel ?? "unit"} 1 ${money.format(item.rateCents)} + ${qty - 1} add'l @ ${Math.round(
                multiplier * 100,
              )}% (${money.format(addUnit)} ea)`
            : item.label,
        unitPriceCents: amount,
        amountCents: amount,
        detail: {
          pricingType: "per_unit_declining",
          rateCents: item.rateCents,
          quantity: qty,
          additionalUnitMultiplier: multiplier,
          additionalUnitCents: addUnit,
        },
      };
    }

    case "tiered_by_measure": {
      const measure = requireMeasure(line, item);
      const tiers = item.tiers ?? [];
      const tier = tiers.find((t) => t.maxMeasure == null || measure <= t.maxMeasure) ?? tiers[tiers.length - 1];
      if (!tier) throw new CatalogError(`"${line.serviceKey}" has no tiers configured.`, "bad_input");
      return {
        ...base,
        description: `${item.label} — ${measure} (${money.format(tier.rateCents)})`,
        unitPriceCents: tier.rateCents,
        amountCents: tier.rateCents,
        detail: { pricingType: "tiered_by_measure", rateCents: tier.rateCents, measure },
      };
    }

    case "per_measure_banded":
    case "per_measure": {
      const measure = requireMeasure(line, item);
      const { multiplier, selected } = resolveModifiers(item, line.modifiers);
      assertQuotable(item, selected);
      const baseRate =
        item.pricingType === "per_measure_banded" ? bandedRate(item, measure) : item.rateCents;
      // Multiplier applies to the RATE, before the minimum floor: a deep-clean
      // minimum should scale with the work, not sit at the refresh floor.
      const effectiveRate = Math.round(baseRate * multiplier);
      const raw = money.perMeasure(effectiveRate, measure);
      const floored = money.atLeast(raw, item.minimumCents);
      const minimumApplied = raw < item.minimumCents;
      const perMeasure = surchargePerMeasure(input.catalog, input.variant, item.surchargeEligible);
      const surcharge = money.perMeasure(perMeasure, measure);
      const amount = floored + surcharge;

      let description = minimumApplied
        ? `${item.label} — ${measure} (minimum ${money.format(item.minimumCents)})`
        : `${item.label} — ${measure} × ${money.format(effectiveRate)}`;
      if (surcharge > 0) {
        description += ` + ${input.variant} surcharge ${money.format(perMeasure)}`;
      }

      return {
        ...base,
        description,
        unitPriceCents: amount,
        amountCents: amount,
        detail: {
          pricingType: item.pricingType,
          rateCents: effectiveRate,
          measure,
          modifierMultiplier: multiplier,
          modifiers: selected,
          minimumCents: item.minimumCents,
          minimumApplied,
          surchargePerMeasureCents: perMeasure,
          surchargeCents: surcharge,
        },
      };
    }

    default:
      throw new CatalogError(`Unsupported pricing type on "${line.serviceKey}".`, "bad_input");
  }
}

/** Expand a bundle's service keys, resolving `family_*` against the cart. */
function resolveBundleKeys(bundle: CatalogBundle, lines: CatalogLineInput[]): string[] {
  return bundle.serviceKeys.flatMap((key) => {
    if (!key.endsWith("*")) return [key];
    const prefix = key.slice(0, -1);
    const matches = lines.filter((l) => l.serviceKey.startsWith(prefix)).map((l) => l.serviceKey);
    if (matches.length === 0) {
      throw new CatalogError(
        `Bundle "${bundle.label}" requires a "${key}" service in the line list.`,
        "unknown_bundle",
      );
    }
    // ALL matches, so bundle eligibility is order-independent and every line the
    // customer chose from that family is discounted.
    return matches;
  });
}

/** Price a cart against a catalog. Pure. */
export function priceFromCatalog(input: CatalogPriceInput): CatalogPricing {
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new CatalogError("A quote needs at least one line.", "empty");
  }

  const lines = input.lines.map((l) => priceLine(input, l));

  let bundle: CatalogPricing["bundle"] = null;
  if (input.bundleKey) {
    const def = input.catalog.bundles[input.bundleKey];
    if (!def) throw new CatalogError(`Unknown bundle: "${input.bundleKey}".`, "unknown_bundle");

    const eligibleKeys = new Set(resolveBundleKeys(def, input.lines));
    for (const required of eligibleKeys) {
      if (!lines.some((l) => l.serviceKey === required)) {
        throw new CatalogError(
          `Bundle "${def.label}" requires service "${required}", which is not in the line list.`,
          "unknown_bundle",
        );
      }
    }

    let eligibleCents = 0;
    for (const line of lines) {
      if (eligibleKeys.has(line.serviceKey)) {
        line.bundleEligible = true;
        eligibleCents += line.amountCents;
      }
    }
    bundle = {
      key: def.bundleKey,
      label: def.label,
      discountPct: def.discountPct,
      eligibleCents,
      discountCents: money.discount(eligibleCents, def.discountPct),
    };
  }

  const aLaCarteCents = lines.reduce((sum, l) => sum + l.amountCents, 0);
  const bundleSavingsCents = bundle?.discountCents ?? 0;

  return {
    lines,
    bundle,
    aLaCarteCents,
    bundleSavingsCents,
    subtotalCents: aLaCarteCents - bundleSavingsCents,
  };
}
