import { describe, expect, it } from "vitest";

import { priceQuote, roundHalfUpDiv, type EngineType } from "@/server/services/quotes/pricing";

// Explicit rates so the goldens are independent of env (HST 13%, deposit 25%).
const RATES = { taxRateBps: 1300, depositRateBps: 2500 } as const;
const win = (t: EngineType, n = 1) => ({ serviceId: `winterization_${t}`, engineType: t, engineCount: n });

// ─────────────────────────────────────────────────────────────────────────────
// Golden anchors — the money contract. Subtotals come straight from
// @a1/pricing-engine (calculateQuote, storage line); tax = 13% HST; total =
// subtotal + tax; deposit = round-half-up(25% × total), clamped to the total.
// Values were captured from the real engine (scripts/dev/price-explore.ts) and are
// locked here so a pricing-engine bump can't silently move a customer's price.
// ─────────────────────────────────────────────────────────────────────────────
describe("priceQuote — golden anchors", () => {
  it("24ft standard winter à la carte (outdoor + shrink + winterization outboard)", () => {
    const p = priceQuote({
      services: [
        { serviceId: "outdoor_storage", lengthFt: 24 },
        { serviceId: "shrink_wrap", lengthFt: 24 },
        win("outboard"),
      ],
      ...RATES,
    });
    expect(p.subtotalCents).toBe(176_100); // $1,761.00
    expect(p.taxCents).toBe(22_893); //       13% HST
    expect(p.totalCents).toBe(198_993); //    $1,989.93
    expect(p.depositCents).toBe(49_748); //   25% of total → $497.48
    expect(p.lineItems).toHaveLength(3);
    expect(p.bundleId).toBeNull();
  });

  it("24ft Winter Ready Plus bundle (10% off) — exercises deposit round-half-up", () => {
    const p = priceQuote({
      services: [
        { serviceId: "outdoor_storage", lengthFt: 24 },
        { serviceId: "shrink_wrap", lengthFt: 24 },
        win("outboard"),
      ],
      bundleId: "winter_ready_plus",
      ...RATES,
    });
    expect(p.subtotalCents).toBe(158_490); //  $1,584.90 (176,100 − 10%)
    expect(p.bundleSavingsCents).toBe(17_610);
    expect(p.taxCents).toBe(20_604);
    expect(p.totalCents).toBe(179_094);
    // 179,094 × 25% = 44,773.5 → round-half-up → 44,774 ($447.74)
    expect(p.depositCents).toBe(44_774);
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
    expect(p.subtotalCents).toBe(393_910); //  $3,939.10
    expect(p.taxCents).toBe(51_208);
    expect(p.totalCents).toBe(445_118); //     $4,451.18
    expect(p.depositCents).toBe(111_280); //   $1,112.80
    expect(p.lineItems).toHaveLength(5);
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
    expect(p.subtotalCents).toBe(214_500); // $2,145.00 (pontoon +$8/ft on the two per-foot lines)
  });
});

describe("priceQuote — deposit + rate rules", () => {
  it("deposit never exceeds the tax-inclusive total", () => {
    const p = priceQuote({
      services: [{ serviceId: "shrink_wrap", lengthFt: 20 }],
      taxRateBps: 1300,
      depositRateBps: 10_000, // 100%
    });
    expect(p.depositCents).toBe(p.totalCents);
  });

  it("carries the configured rates through", () => {
    const p = priceQuote({ services: [{ serviceId: "shrink_wrap", lengthFt: 24 }], ...RATES });
    expect(p.taxRateBps).toBe(1300);
    expect(p.depositRateBps).toBe(2500);
  });

  it("propagates engine validation errors (unknown service throws)", () => {
    expect(() => priceQuote({ services: [{ serviceId: "helicopter_pad", lengthFt: 24 }] })).toThrow();
  });
});

describe("roundHalfUpDiv", () => {
  it("rounds the .5 boundary up", () => {
    expect(roundHalfUpDiv(5, 10)).toBe(1); //  0.5 → 1
    expect(roundHalfUpDiv(15, 10)).toBe(2); // 1.5 → 2
    expect(roundHalfUpDiv(179_094 * 2500, 10_000)).toBe(44_774); // 44,773.5 → 44,774
  });

  it("rounds below .5 down", () => {
    expect(roundHalfUpDiv(4, 10)).toBe(0); //  0.4 → 0
    expect(roundHalfUpDiv(14, 10)).toBe(1); // 1.4 → 1
  });
});
