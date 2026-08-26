import { describe, expect, it } from "vitest";

import { priceQuote, roundHalfUpDiv, type EngineType } from "@/server/services/quotes/pricing";

// Explicit rates so the goldens are independent of env (HST 13%, deposit 25%).
const RATES = { taxRateBps: 1300, depositRateBps: 2500 } as const;
const win = (t: EngineType, n = 1) => ({ serviceId: `winterization_${t}`, engineType: t, engineCount: n });

// ─────────────────────────────────────────────────────────────────────────────
// Golden anchors — the money contract. Subtotals come straight from
// @a1/pricing-engine (calculateQuote, storage line); tax = 13% HST; total =
// subtotal + tax; deposit = round-half-up(25% × total), clamped to the total.
//
// REQUIRES @a1/pricing-engine >= 1.3.0. These values moved when the stale v1.0.1
// pin was corrected: v1.0.1 carried the 2025 table ($46/ft storage, $18/ft wrap,
// $225 winterization) and produced a 24ft anchor of $1,761 — about 15% under the
// ratified rate. The anchors below are the ratified 2026/27 prices.
// ─────────────────────────────────────────────────────────────────────────────
describe("priceQuote — golden anchors", () => {
  // ── Plan fixture (a) ──────────────────────────────────────────────────────
  it("GOLDEN (a): 24ft storage + wrap + outboard winterization = $2,075 subtotal", () => {
    const p = priceQuote({
      services: [
        { serviceId: "outdoor_storage", lengthFt: 24 },
        { serviceId: "shrink_wrap", lengthFt: 24 },
        win("outboard"),
      ],
      ...RATES,
    });
    expect(p.subtotalCents).toBe(207_500); // $2,075.00 — 24×$50 + 24×$25 + $275
    expect(p.taxCents).toBe(26_975); //       13% HST
    expect(p.totalCents).toBe(234_475); //    $2,344.75
    expect(p.depositCents).toBe(58_619); //   25% of total → $586.19
  });

  it("24ft Winter Ready Plus bundle (10% off)", () => {
    const p = priceQuote({
      services: [
        { serviceId: "outdoor_storage", lengthFt: 24 },
        { serviceId: "shrink_wrap", lengthFt: 24 },
        win("outboard"),
      ],
      bundleId: "winter_ready_plus",
      ...RATES,
    });
    expect(p.subtotalCents).toBe(186_750); // $1,867.50 ($2,075 − 10%)
    expect(p.bundleSavingsCents).toBe(20_750);
    expect(p.taxCents).toBe(24_278);
    expect(p.totalCents).toBe(211_028);
    expect(p.depositCents).toBe(52_757);
  });

  it("40ft Full Care bundle (inboard twin) — a larger multi-service job", () => {
    const p = priceQuote({
      services: [
        { serviceId: "outdoor_storage", lengthFt: 40 },
        { serviceId: "shrink_wrap", lengthFt: 40 },
        win("inboard", 2),
        { serviceId: "fall_detail", lengthFt: 40 },
        { serviceId: "spring_commissioning" },
      ],
      bundleId: "full_care",
      ...RATES,
    });
    expect(p.subtotalCents).toBe(440_352); // $4,403.52
    expect(p.bundleSavingsCents).toBe(60_048);
    expect(p.taxCents).toBe(57_246);
    expect(p.totalCents).toBe(497_598); //   $4,975.98
    expect(p.depositCents).toBe(124_400); // $1,244.00
  });

  it("24ft pontoon à la carte — hull surcharge flows into the subtotal", () => {
    const p = priceQuote({
      services: [
        { serviceId: "outdoor_storage", lengthFt: 24 },
        { serviceId: "shrink_wrap", lengthFt: 24 },
        win("outboard"),
      ],
      hullType: "pontoon",
      ...RATES,
    });
    expect(p.subtotalCents).toBe(245_900); // $2,459.00 (pontoon +$8/ft on the two per-foot lines)
  });

  // ── Plan fixture (d) ──────────────────────────────────────────────────────
  it("GOLDEN (d1): PWC-only (storage + winterization) = $625 → deposit $176.56", () => {
    const p = priceQuote({
      services: [{ serviceId: "pwc_storage" }, { serviceId: "pwc_winterization" }],
      ...RATES,
    });
    expect(p.subtotalCents).toBe(62_500);
    expect(p.totalCents).toBe(70_625); //   $706.25
    expect(p.depositCents).toBe(17_656); // $176.56
  });

  it("GOLDEN (d2): one vessel stored 2 months past April 30 = $200 → deposit $56.50", () => {
    const p = priceQuote({
      services: [{ serviceId: "extended_storage", quantity: 2 }],
      ...RATES,
    });
    expect(p.subtotalCents).toBe(20_000);
    expect(p.totalCents).toBe(22_600);
    expect(p.depositCents).toBe(5_650);
  });

  it("transport bands price per trip and carry into the total", () => {
    const p = priceQuote({
      services: [
        { serviceId: "outdoor_storage", lengthFt: 24 },
        { serviceId: "transport_regional", quantity: 2 }, // round trip
      ],
      ...RATES,
    });
    expect(p.subtotalCents).toBe(170_000); // $1,200 + 2 × $250
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Optional line items — the Jobber mechanic the runabout/Waverunner quote needs.
// A deselected optional line is EXCLUDED from the engine call, so it changes
// bundle eligibility too, not just the arithmetic.
// ─────────────────────────────────────────────────────────────────────────────
describe("priceQuote — optional line items", () => {
  const base = [
    { serviceId: "outdoor_storage", lengthFt: 24 },
    { serviceId: "shrink_wrap", lengthFt: 24 },
  ];

  it("an optional line is OFF by default and excluded from the totals", () => {
    const p = priceQuote({
      services: [...base, { serviceId: "battery_storage", quantity: 2, optional: true }],
      ...RATES,
    });
    expect(p.subtotalCents).toBe(180_000); // $1,200 + $600 only
    const battery = p.lineItems.find((l) => l.serviceId === "battery_storage")!;
    expect(battery.selected).toBe(false);
    expect(battery.optional).toBe(true);
    // Still priced, so the page can show what ticking it would add.
    expect(battery.amountCents).toBe(20_000);
  });

  it("selecting an optional line moves subtotal, tax, total and deposit together", () => {
    const off = priceQuote({
      services: [...base, { serviceId: "battery_storage", quantity: 2, optional: true }],
      ...RATES,
    });
    const on = priceQuote({
      services: [...base, { serviceId: "battery_storage", quantity: 2, optional: true, selected: true }],
      ...RATES,
    });
    expect(on.subtotalCents - off.subtotalCents).toBe(20_000);
    expect(on.totalCents).toBeGreaterThan(off.totalCents);
    expect(on.depositCents).toBeGreaterThan(off.depositCents);
    expect(on.lineItems.find((l) => l.serviceId === "battery_storage")!.selected).toBe(true);
  });

  it("a required line is always counted regardless of `selected`", () => {
    const p = priceQuote({
      services: [{ serviceId: "outdoor_storage", lengthFt: 24, selected: false }],
      ...RATES,
    });
    expect(p.subtotalCents).toBe(120_000);
  });

  it("deselecting a bundle-eligible optional drops the bundle with it", () => {
    // With the winterization line ON, the trio bundles normally.
    const on = priceQuote({
      services: [...base, { ...win("outboard"), optional: true, selected: true }],
      bundleId: "winter_ready_plus",
      ...RATES,
    });
    expect(on.bundleSavingsCents).toBe(20_750);

    // With it OFF it is not in the cart at all, so the engine refuses the bundle
    // rather than silently discounting a trio the customer did not buy.
    const off = () =>
      priceQuote({
        services: [...base, { ...win("outboard"), optional: true }],
        bundleId: "winter_ready_plus",
        ...RATES,
      });
    expect(off).toThrow();
  });

  it("prices a quote whose only lines are deselected optionals as zero", () => {
    const p = priceQuote({
      services: [{ serviceId: "battery_storage", optional: true }],
      ...RATES,
    });
    expect(p.subtotalCents).toBe(0);
    expect(p.totalCents).toBe(0);
    expect(p.depositCents).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Custom (Care) lines — hand-priced, never engine-computed, never bundled.
// ─────────────────────────────────────────────────────────────────────────────
describe("priceQuote — custom Care lines", () => {
  it("adds a selected custom line to the subtotal without touching the engine", () => {
    const p = priceQuote({
      services: [{ serviceId: "outdoor_storage", lengthFt: 24 }],
      customLines: [{ label: "Gelcoat restoration — port side", amountCents: 85_000 }],
      ...RATES,
    });
    expect(p.subtotalCents).toBe(205_000); // $1,200 + $850
    const custom = p.lineItems.find((l) => l.custom)!;
    expect(custom.selected).toBe(true);
    expect(custom.bundleEligible).toBe(false);
  });

  it("an optional custom line is off by default", () => {
    const p = priceQuote({
      services: [{ serviceId: "outdoor_storage", lengthFt: 24 }],
      customLines: [{ label: "Interior detail", amountCents: 45_000, optional: true }],
      ...RATES,
    });
    expect(p.subtotalCents).toBe(120_000);
    expect(p.lineItems.find((l) => l.custom)!.selected).toBe(false);
  });

  it("prices a Care-only quote with no engine services at all", () => {
    const p = priceQuote({
      services: [],
      customLines: [{ label: "Full restoration", amountCents: 250_000 }],
      ...RATES,
    });
    expect(p.subtotalCents).toBe(250_000);
    expect(p.taxCents).toBe(32_500);
    expect(p.totalCents).toBe(282_500);
    expect(p.depositCents).toBe(70_625);
  });
});

describe("priceQuote — deposit + rate rules", () => {
  it("deposit never exceeds the tax-inclusive total", () => {
    const p = priceQuote({
      services: [{ serviceId: "outdoor_storage", lengthFt: 24 }],
      taxRateBps: 1300,
      depositRateBps: 20_000, // 200% — absurd on purpose
    });
    expect(p.depositCents).toBe(p.totalCents);
  });

  it("carries the configured rates through", () => {
    const p = priceQuote({ services: [{ serviceId: "outdoor_storage", lengthFt: 24 }] });
    expect(p.taxRateBps).toBe(1300);
    expect(p.depositRateBps).toBe(2500);
  });

  it("propagates engine validation errors (unknown service throws)", () => {
    expect(() => priceQuote({ services: [{ serviceId: "nope" }], ...RATES })).toThrow();
  });
});

describe("roundHalfUpDiv", () => {
  it("rounds the .5 boundary up", () => {
    expect(roundHalfUpDiv(5, 10)).toBe(1); //  0.5 → 1
    expect(roundHalfUpDiv(15, 10)).toBe(2); // 1.5 → 2
  });

  it("rounds below .5 down", () => {
    expect(roundHalfUpDiv(4, 10)).toBe(0); //  0.4 → 0
    expect(roundHalfUpDiv(14, 10)).toBe(1); // 1.4 → 1
  });

  // The plan's Nestor deposit: 25% of $5,723.45 = $1,430.8625 → $1,430.86.
  it("matches the plan's stated Nestor deposit rounding", () => {
    expect(roundHalfUpDiv(572_345 * 2500, 10_000)).toBe(143_086);
  });
});
