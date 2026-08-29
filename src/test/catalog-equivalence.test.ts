import { calculateQuote } from "@a1/pricing-engine";
import { describe, expect, it } from "vitest";

import a1Catalog from "@/server/services/quotes/__fixtures__/a1-catalog.json";
import { priceFromCatalog, type ServiceCatalog } from "@/server/services/quotes/catalog";

const CATALOG = a1Catalog as unknown as ServiceCatalog;

/**
 * THE EXTRACTION PROOF.
 *
 * The catalog replaces a hard dependency on @a1/pricing-engine. These tests run
 * the SAME carts through both and require identical integers — so "we made
 * pricing tenant-configurable" cannot quietly mean "we changed someone's prices".
 *
 * The engine is imported HERE and nowhere else in the product. When it is finally
 * dropped from package.json, this file goes with it and the golden anchors in
 * quote-pricing.test.ts remain as the standing contract.
 */

/** Translate an engine cart into the catalog's domain-neutral shape. */
function toCatalogLines(items: { serviceId: string; lengthFt?: number; engineCount?: number; quantity?: number; distanceKm?: number }[]) {
  return items.map((i) => ({
    serviceKey: i.serviceId,
    measure: i.lengthFt ?? i.distanceKm,
    quantity: i.quantity ?? i.engineCount,
  }));
}

function bothWays(
  items: Parameters<typeof toCatalogLines>[0],
  opts: { hullType?: string; bundleId?: string } = {},
) {
  const engine = calculateQuote({
    serviceLine: "storage",
    items: items as never,
    hullType: opts.hullType,
    bundleId: opts.bundleId,
  });
  const catalog = priceFromCatalog({
    catalog: CATALOG,
    lines: toCatalogLines(items),
    variant: opts.hullType ?? null,
    bundleKey: opts.bundleId ?? null,
  });
  return { engine, catalog };
}

describe("catalog reproduces the engine — golden carts", () => {
  it("24ft storage + wrap + outboard winterization ($2,075)", () => {
    const { engine, catalog } = bothWays([
      { serviceId: "outdoor_storage", lengthFt: 24 },
      { serviceId: "shrink_wrap", lengthFt: 24 },
      { serviceId: "winterization_outboard", engineCount: 1 },
    ]);
    expect(catalog.subtotalCents).toBe(engine.subtotalCents);
    expect(catalog.subtotalCents).toBe(207_500);
  });

  it("Winter Ready Plus bundle — discount matches to the cent", () => {
    const { engine, catalog } = bothWays(
      [
        { serviceId: "outdoor_storage", lengthFt: 24 },
        { serviceId: "shrink_wrap", lengthFt: 24 },
        { serviceId: "winterization_outboard", engineCount: 1 },
      ],
      { bundleId: "winter_ready_plus" },
    );
    expect(catalog.bundleSavingsCents).toBe(engine.bundleSavingsCents);
    expect(catalog.subtotalCents).toBe(engine.subtotalCents);
    expect(catalog.subtotalCents).toBe(186_750);
  });

  it("40ft Full Care, twin inboard — the multi-unit rounding path", () => {
    const { engine, catalog } = bothWays(
      [
        { serviceId: "outdoor_storage", lengthFt: 40 },
        { serviceId: "shrink_wrap", lengthFt: 40 },
        { serviceId: "winterization_inboard", engineCount: 2 },
        { serviceId: "fall_detail", lengthFt: 40 },
        { serviceId: "spring_commissioning" },
      ],
      { bundleId: "full_care" },
    );
    expect(catalog.subtotalCents).toBe(engine.subtotalCents);
    expect(catalog.subtotalCents).toBe(440_352);
  });

  it("pontoon surcharge — the variant path", () => {
    const { engine, catalog } = bothWays(
      [
        { serviceId: "outdoor_storage", lengthFt: 24 },
        { serviceId: "shrink_wrap", lengthFt: 24 },
        { serviceId: "winterization_outboard", engineCount: 1 },
      ],
      { hullType: "pontoon" },
    );
    expect(catalog.subtotalCents).toBe(engine.subtotalCents);
    expect(catalog.subtotalCents).toBe(245_900);
  });

  it("the per_measure minimum floor", () => {
    // A 10ft boat pays the minimum, not 10 x the rate.
    const { engine, catalog } = bothWays([{ serviceId: "outdoor_storage", lengthFt: 10 }]);
    expect(catalog.subtotalCents).toBe(engine.subtotalCents);
    expect(catalog.lines[0].detail.minimumApplied).toBe(true);
  });

  it("tiered_by_measure picks the same band either side of the boundary", () => {
    for (const ft of [20, 26, 27, 38]) {
      const { engine, catalog } = bothWays([{ serviceId: "spring_wrap_removal", lengthFt: ft }]);
      expect(catalog.subtotalCents).toBe(engine.subtotalCents);
    }
  });

  it("per_unit and per_km lines", () => {
    const { engine, catalog } = bothWays([
      { serviceId: "battery_storage", quantity: 3 },
      { serviceId: "pwc_storage", quantity: 2 },
      { serviceId: "transport_regional", quantity: 2 },
      { serviceId: "transport_beyond_per_km", distanceKm: 120 },
    ]);
    expect(catalog.subtotalCents).toBe(engine.subtotalCents);
  });
});

/**
 * Sweep rather than spot-check: every per-measure service at a range of measures,
 * and every declining service at 1–3 units. A single-cent divergence anywhere
 * fails here rather than in a customer's quote.
 */
describe("catalog reproduces the engine — exhaustive sweep", () => {
  it("every per_measure service across 10–60", () => {
    const perMeasure = Object.values(CATALOG.items).filter((i) => i.pricingType === "per_measure");
    expect(perMeasure.length).toBeGreaterThan(3);

    for (const item of perMeasure) {
      for (const measure of [10, 18, 24, 31, 45, 60]) {
        if (item.maxMeasure != null && measure > item.maxMeasure) continue;
        const isKm = item.serviceKey.includes("per_km");
        const { engine, catalog } = bothWays([
          isKm
            ? { serviceId: item.serviceKey, distanceKm: measure }
            : { serviceId: item.serviceKey, lengthFt: measure },
        ]);
        expect(
          catalog.subtotalCents,
          `${item.serviceKey} @ ${measure}`,
        ).toBe(engine.subtotalCents);
      }
    }
  });

  it("every declining service at 1, 2 and 3 units", () => {
    const declining = Object.values(CATALOG.items).filter((i) => i.pricingType === "per_unit_declining");
    expect(declining.length).toBeGreaterThan(0);

    for (const item of declining) {
      for (const qty of [1, 2, 3]) {
        const { engine, catalog } = bothWays([{ serviceId: item.serviceKey, engineCount: qty }]);
        expect(catalog.subtotalCents, `${item.serviceKey} x${qty}`).toBe(engine.subtotalCents);
      }
    }
  });

  it("every per_unit service at 1 and 4 units", () => {
    const perUnit = Object.values(CATALOG.items).filter((i) => i.pricingType === "per_unit");
    for (const item of perUnit) {
      for (const qty of [1, 4]) {
        if (item.maxQuantity != null && qty > item.maxQuantity) continue;
        const { engine, catalog } = bothWays([{ serviceId: item.serviceKey, quantity: qty }]);
        expect(catalog.subtotalCents, `${item.serviceKey} x${qty}`).toBe(engine.subtotalCents);
      }
    }
  });

  it("every flat service", () => {
    const flat = Object.values(CATALOG.items).filter((i) => i.pricingType === "flat");
    for (const item of flat) {
      const { engine, catalog } = bothWays([{ serviceId: item.serviceKey }]);
      expect(catalog.subtotalCents, item.serviceKey).toBe(engine.subtotalCents);
    }
  });
});

describe("the generated catalog covers the whole engine", () => {
  it("has an item for every engine service — nothing silently dropped", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { STORAGE } = require("@a1/pricing-engine") as any;
    for (const key of Object.keys(STORAGE.services)) {
      expect(CATALOG.items[key], `missing catalog item: ${key}`).toBeTruthy();
    }
    expect(Object.keys(CATALOG.bundles)).toHaveLength(Object.keys(STORAGE.bundles).length);
    expect(Object.keys(CATALOG.surcharges)).toHaveLength(Object.keys(STORAGE.hullSurcharges).length);
  });
});
