import { describe, expect, it } from "vitest";

import mixedCustom from "@/server/services/quotes/__fixtures__/mixed-custom-package.json";
import multiVessel from "@/server/services/quotes/__fixtures__/multi-vessel-optional-package.json";
import { priceQuote as priceWithCatalog, type QuotePricingInput } from "@/server/services/quotes/pricing";
import a1Catalog from "@/server/services/quotes/__fixtures__/a1-catalog.json";
import type { ServiceCatalog } from "@/server/services/quotes/catalog";

// Tenant zero's catalog, generated from the rate card these anchors were taken
// from. Injected once so the goldens keep pricing without a database.
const CATALOG = a1Catalog as unknown as ServiceCatalog;
const priceQuote = (input: Omit<Parameters<typeof priceWithCatalog>[0], "catalog">) =>
  priceWithCatalog({ ...input, catalog: CATALOG });

// Explicit rates so the fixtures are independent of env (HST 13%, deposit 25%).
const RATES = { taxRateBps: 1300, depositRateBps: 2500 } as const;

/**
 * Structural fixtures — permanent test data, deliberately NOT named after customers.
 * They lock the two shapes the hosted quote page has to get right:
 *   • a mixed package: engine-computed lines PLUS hand-priced Care lines
 *   • a multi-vessel package with optional lines, asserted in BOTH selection states
 */
describe("fixture: mixed-custom-package", () => {
  const input = mixedCustom as unknown as QuotePricingInput & {
    expected: Record<string, number>;
  };

  it("prices engine lines and hand-priced Care lines into one subtotal", () => {
    const p = priceQuote({ services: input.services, customLines: input.customLines, ...RATES });
    const e = input.expected;

    expect(p.subtotalCents).toBe(e.subtotalCents);
    expect(p.taxCents).toBe(e.taxCents);
    expect(p.totalCents).toBe(e.totalCents);
    expect(p.depositCents).toBe(e.depositCents);
  });

  it("keeps Care lines out of the engine — never bundle-eligible, always custom", () => {
    const p = priceQuote({ services: input.services, customLines: input.customLines, ...RATES });
    const custom = p.lineItems.filter((l) => l.custom);

    expect(custom).toHaveLength(2);
    for (const line of custom) {
      expect(line.bundleEligible).toBe(false);
      expect(line.serviceId).toBe("custom");
    }
    expect(custom.reduce((sum, l) => sum + l.amountCents, 0)).toBe(input.expected.customCents);
  });

  it("splits the subtotal exactly between engine and custom", () => {
    const p = priceQuote({ services: input.services, customLines: input.customLines, ...RATES });
    const engineCents = p.lineItems.filter((l) => !l.custom).reduce((s, l) => s + l.amountCents, 0);

    expect(engineCents).toBe(input.expected.engineSubtotalCents);
    expect(engineCents + input.expected.customCents).toBe(p.subtotalCents);
  });
});

describe("fixture: multi-vessel-optional-package", () => {
  const input = multiVessel as unknown as QuotePricingInput & {
    expected: { coreOnly: Record<string, number>; allOptions: Record<string, number> };
  };

  /** Every optional line off — the default a customer first sees. */
  const coreOnly = () => priceQuote({ services: input.services, ...RATES });

  /** Every optional line ticked. */
  const allOptions = () =>
    priceQuote({
      services: input.services.map((s) => (s.optional ? { ...s, selected: true } : s)),
      ...RATES,
    });

  it("CORE ONLY: optionals default off and are excluded from every total", () => {
    const p = coreOnly();
    const e = input.expected.coreOnly;

    expect(p.subtotalCents).toBe(e.subtotalCents);
    expect(p.taxCents).toBe(e.taxCents);
    expect(p.totalCents).toBe(e.totalCents);
    expect(p.depositCents).toBe(e.depositCents);
  });

  it("ALL OPTIONS: ticking every optional moves all four numbers together", () => {
    const p = allOptions();
    const e = input.expected.allOptions;

    expect(p.subtotalCents).toBe(e.subtotalCents);
    expect(p.taxCents).toBe(e.taxCents);
    expect(p.totalCents).toBe(e.totalCents);
    expect(p.depositCents).toBe(e.depositCents);
  });

  it("the delta is exactly the optional lines, recomputed rather than added on", () => {
    const core = coreOnly();
    const all = allOptions();
    const optionalCents = all.lineItems
      .filter((l) => l.optional && l.selected)
      .reduce((sum, l) => sum + l.amountCents, 0);

    expect(all.subtotalCents - core.subtotalCents).toBe(optionalCents);
    // Tax and deposit are recomputed from the new subtotal, not scaled.
    expect(all.taxCents).toBeGreaterThan(core.taxCents);
    expect(all.depositCents).toBeGreaterThan(core.depositCents);
  });

  it("returns deselected optionals priced à la carte so the page can show them", () => {
    const p = coreOnly();
    const off = p.lineItems.filter((l) => l.optional && !l.selected);

    expect(off.length).toBeGreaterThan(0);
    for (const line of off) expect(line.amountCents).toBeGreaterThan(0);
    // ...but they contribute nothing to the totals.
    expect(p.subtotalCents).toBe(input.expected.coreOnly.subtotalCents);
  });

  it("deposit stays 25% of the tax-inclusive total in both states", () => {
    for (const p of [coreOnly(), allOptions()]) {
      expect(p.depositCents).toBe(Math.floor((p.totalCents * 2500 + 5000) / 10_000));
    }
  });
});
