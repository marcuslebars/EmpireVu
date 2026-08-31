import { describe, expect, it } from "vitest";

import careCatalogJson from "@/server/services/quotes/__fixtures__/a1-care-catalog.json";
import coatingsCatalogJson from "@/server/services/quotes/__fixtures__/a1-coatings-catalog.json";
import { priceFromCatalog, resolveModifiers, type ServiceCatalog } from "@/server/services/quotes/catalog";

/**
 * Catalog-model behaviour that must hold on its own terms — modifiers, banded
 * rates, and the review rules.
 *
 * The engine-vs-catalog parity proof lived in catalog-care-equivalence.test.ts
 * and was retired together with the @a1/pricing-engine dependency (its job done).
 * This is the engine-free half worth keeping; the golden money anchors live in
 * quote-pricing.test.ts and quote-fixtures.test.ts.
 */
const toCents = (dollars: number) => Math.round(dollars * 100);

const CARE = careCatalogJson as unknown as ServiceCatalog;
const COATINGS = coatingsCatalogJson as unknown as ServiceCatalog;

function priceOne(catalog: ServiceCatalog, serviceKey: string, measure: number, modifiers?: Record<string, string>) {
  return priceFromCatalog({ catalog, lines: [{ serviceKey, measure, modifiers }] }).subtotalCents;
}

describe("banded rates", () => {
  it("gelcoat hull picks the same per-foot rate either side of each band edge", () => {
    // Bands are 20 / 25 / 30 / 35 / 40 / 45 / open.
    const rates: Record<number, number> = { 20: 21, 25: 23, 30: 25, 35: 27, 40: 30, 45: 34 };
    for (const [edgeStr, rate] of Object.entries(rates)) {
      const edge = Number(edgeStr);
      expect(priceOne(CARE, "gelcoat_hull", edge), `hull at ${edge}ft`).toBe(toCents(rate * edge));
    }
    // Above the last band, the open-ended top rate applies.
    expect(priceOne(CARE, "gelcoat_hull", 50)).toBe(toCents(36 * 50));
  });

  it("gelcoat topsides uses its own band set, not the hull's", () => {
    expect(priceOne(CARE, "gelcoat_topsides", 20)).toBe(toCents(24 * 20));
    expect(priceOne(CARE, "gelcoat_topsides", 50)).toBe(toCents(40 * 50));
  });

  it("the heavy-oxidation surcharge is a modifier on the banded rate", () => {
    const normal = priceOne(CARE, "gelcoat_hull", 30, { oxidation: "normal" });
    const heavy = priceOne(CARE, "gelcoat_hull", 30, { oxidation: "heavy" });
    expect(normal).toBe(toCents(25 * 30));
    expect(heavy).toBe(Math.round(normal * 1.2)); // 20% surcharge
  });
});

/**
 * A required modifier with nothing chosen must be an ERROR, not a silent 1.0.
 * The gap between "refresh" and "restoration" is 60% of the price; quoting the
 * cheaper one because a field was missing is the expensive failure mode.
 */
describe("modifier resolution refuses to guess", () => {
  const item = CARE.items.exterior_detailing;

  it("throws when a required group is unanswered", () => {
    expect(() => resolveModifiers(item, {})).toThrow(/requires a choice/);
    expect(() => resolveModifiers(item, undefined)).toThrow(/requires a choice/);
  });

  it("throws on an option nobody configured", () => {
    expect(() => resolveModifiers(item, { tier: "platinum" })).toThrow(/not a valid/);
  });

  it("multiplies groups together", () => {
    const interior = CARE.items.interior_detailing;
    const { multiplier } = resolveModifiers(interior, { tier: "deep", boatType: "Yacht / Multi-Cabin" });
    expect(multiplier).toBeCloseTo(1.5 * 1.6, 10);
  });

  it("is a no-op for items with no modifier groups", () => {
    expect(resolveModifiers(COATINGS.items.ceramic, undefined)).toEqual({ multiplier: 1, selected: {} });
  });
});

/**
 * The catalog must refuse the same jobs the business quotes by hand — a yacht
 * deep-clean priced anyway once quoted $1,296 for exactly the job that's meant to
 * be eyeballed first, and a zero subtotal could show a customer a free job.
 */
describe("review rules and caps", () => {
  it("refuses the yacht deep/restoration combinations, leaving them to be quoted by hand", () => {
    for (const tier of ["deep", "restoration"]) {
      expect(() =>
        priceOne(CARE, "interior_detailing", 30, { tier, boatType: "Yacht / Multi-Cabin" }),
      ).toThrow(/quoted by hand/);
    }
  });

  it("still prices a yacht at the auto-quotable tiers", () => {
    for (const tier of ["refresh", "standard"]) {
      expect(priceOne(CARE, "interior_detailing", 30, { tier, boatType: "Yacht / Multi-Cabin" })).toBeGreaterThan(0);
    }
  });

  it("carries the interior manual-review cap rather than quoting past it", () => {
    // The business refuses interior work over 45ft; the catalog expresses that as
    // a hard cap so a number nobody stands behind is never produced.
    expect(CARE.items.interior_detailing.maxMeasure).toBe(45);
    expect(() => priceOne(CARE, "interior_detailing", 60, { tier: "refresh", boatType: "Cuddy Cabin" })).toThrow(
      /exceeds/,
    );
  });
});

describe("the generated catalogs are complete", () => {
  it("care has an item for every marine_care service family", () => {
    for (const key of [
      "gelcoat_hull",
      "gelcoat_topsides",
      "exterior_detailing",
      "interior_detailing",
      "wet_sanding",
      "bottom_painting",
      "weekly_maintenance",
      "biweekly_maintenance",
    ]) {
      expect(CARE.items[key], `missing: ${key}`).toBeTruthy();
    }
  });

  it("coatings has ceramic and graphene with their add-ons", () => {
    expect(COATINGS.items.ceramic).toBeTruthy();
    expect(COATINGS.items.graphene).toBeTruthy();
    expect(COATINGS.items.ceramic_second_layer).toBeTruthy();
  });
});
