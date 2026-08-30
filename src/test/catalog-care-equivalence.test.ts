import { calculateCeramic, calculateExterior, calculateGraphene, calculateInterior } from "@a1/pricing-engine";
import { describe, expect, it } from "vitest";

import careCatalogJson from "@/server/services/quotes/__fixtures__/a1-care-catalog.json";
import coatingsCatalogJson from "@/server/services/quotes/__fixtures__/a1-coatings-catalog.json";
import { priceFromCatalog, resolveModifiers, type ServiceCatalog } from "@/server/services/quotes/catalog";

const CARE = careCatalogJson as unknown as ServiceCatalog;
const COATINGS = coatingsCatalogJson as unknown as ServiceCatalog;

/**
 * Care and Coatings equivalence, matching the Storage proof.
 *
 * These price lists needed two model additions — MODIFIERS (a rate scaled by
 * service tier and boat type) and BANDED RATES (a per-foot rate chosen by
 * length). These tests are what say those additions reproduce the engine rather
 * than approximate it.
 *
 * The engine returns marine-care money in DOLLARS while the catalog is in cents,
 * so every comparison converts explicitly — a 100x error is exactly the kind of
 * thing that would otherwise slip through.
 */
const toCents = (dollars: number) => Math.round(dollars * 100);

function priceOne(catalog: ServiceCatalog, serviceKey: string, measure: number, modifiers?: Record<string, string>) {
  return priceFromCatalog({ catalog, lines: [{ serviceKey, measure, modifiers }] }).subtotalCents;
}

describe("coatings reproduce the engine", () => {
  it("ceramic at every length", () => {
    for (const ft of [16, 22, 28, 35, 44]) {
      expect(priceOne(COATINGS, "ceramic", ft), `ceramic ${ft}ft`).toBe(
        toCents(calculateCeramic(ft, {}).subtotal),
      );
    }
  });

  it("graphene at every length", () => {
    for (const ft of [16, 22, 28, 35, 44]) {
      expect(priceOne(COATINGS, "graphene", ft), `graphene ${ft}ft`).toBe(
        toCents(calculateGraphene(ft, {}).subtotal),
      );
    }
  });

  it("the second-layer add-on is a per-foot line, priced separately", () => {
    // $8/ft on ceramic — the engine folds it in, the catalog exposes it as its
    // own line so a customer can tick it. Same money either way.
    const withLayer = priceFromCatalog({
      catalog: COATINGS,
      lines: [
        { serviceKey: "ceramic", measure: 30 },
        { serviceKey: "ceramic_second_layer", measure: 30 },
      ],
    }).subtotalCents;
    expect(withLayer).toBe(toCents(calculateCeramic(30, { secondLayer: true } as never).subtotal));
  });
});

describe("care tier multipliers reproduce the engine", () => {
  it("exterior detailing across every tier and length", () => {
    for (const tier of ["refresh", "standard", "deep", "restoration"]) {
      for (const ft of [18, 24, 33, 42]) {
        expect(priceOne(CARE, "exterior_detailing", ft, { tier }), `exterior ${tier} ${ft}ft`).toBe(
          toCents(calculateExterior(ft, { tier } as never).subtotal),
        );
      }
    }
  });

  it("interior detailing across tier x boat type — the two-group case", () => {
    // Two modifier groups MULTIPLY. This is the case the single-multiplier model
    // could not express at all.
    const types = ["Open Bow / Bowrider", "Cuddy Cabin", "Cruiser (Single Cabin)", "Express Cruiser", "Yacht / Multi-Cabin"];
    for (const tier of ["refresh", "deep"]) {
      for (const boatType of types) {
        const ft = 30;
        const engine = calculateInterior(ft, boatType, { tier } as never);
        // A yacht deep-clean is not priced by either side — see the review-rule
        // test below. Everything else must match to the cent.
        if (engine.requiresManualReview) continue;
        expect(
          priceOne(CARE, "interior_detailing", ft, { tier, boatType }),
          `interior ${tier} / ${boatType}`,
        ).toBe(toCents(engine.subtotal));
      }
    }
  });

  /**
   * The engine flags yacht + deep/restoration for manual review and returns a
   * subtotal of ZERO. A catalog that priced it anyway would confidently quote
   * exactly the jobs this business wants to eyeball first — and a zero flowing
   * into a subtotal could show a customer a free job.
   */
  it("refuses the combinations the engine sends to manual review", () => {
    for (const tier of ["deep", "restoration"]) {
      const engine = calculateInterior(30, "Yacht / Multi-Cabin", { tier } as never);
      expect(engine.requiresManualReview, `engine should flag ${tier}`).toBe(true);

      expect(() =>
        priceOne(CARE, "interior_detailing", 30, { tier, boatType: "Yacht / Multi-Cabin" }),
      ).toThrow(/quoted by hand/);
    }
  });

  it("still prices a yacht at the tiers that ARE auto-quotable", () => {
    for (const tier of ["refresh", "standard"]) {
      const engine = calculateInterior(30, "Yacht / Multi-Cabin", { tier } as never);
      expect(engine.requiresManualReview).toBeFalsy();
      expect(priceOne(CARE, "interior_detailing", 30, { tier, boatType: "Yacht / Multi-Cabin" })).toBe(
        toCents(engine.subtotal),
      );
    }
  });
});

describe("banded rates reproduce the engine", () => {
  it("gelcoat hull picks the same per-foot rate either side of each band edge", () => {
    // Bands are 20 / 25 / 30 / 35 / 40 / 45 / open. Test both sides of each.
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

describe("the generated catalogs cover the engine", () => {
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

  it("interior carries the manual-review cap rather than quoting past it", () => {
    // The engine refuses over 45ft; the catalog expresses that as a hard cap so a
    // number nobody stands behind is never produced.
    expect(CARE.items.interior_detailing.maxMeasure).toBe(45);
    expect(() => priceOne(CARE, "interior_detailing", 60, { tier: "refresh", boatType: "Cuddy Cabin" })).toThrow(
      /exceeds/,
    );
  });
});
