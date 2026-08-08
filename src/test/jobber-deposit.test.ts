import { describe, expect, it } from "vitest";

import { computeDepositCents, type JobberDepositConfig } from "@/server/services/jobber/config";

const pct = (percent: number, extra: Partial<JobberDepositConfig> = {}): JobberDepositConfig => ({
  percent,
  flatCents: null,
  minCents: 0,
  ...extra,
});

describe("computeDepositCents", () => {
  it("takes the configured percent of the subtotal (25% default)", () => {
    expect(computeDepositCents(41_400, pct(25))).toBe(10_350);
    expect(computeDepositCents(100_000, pct(25))).toBe(25_000);
  });

  it("rounds to the nearest cent", () => {
    expect(computeDepositCents(999, pct(25))).toBe(250); // 249.75 → 250
  });

  it("a flat override wins over percent", () => {
    expect(computeDepositCents(41_400, pct(25, { flatCents: 5_000 }))).toBe(5_000);
  });

  it("applies the minimum floor", () => {
    expect(computeDepositCents(41_400, pct(25, { minCents: 15_000 }))).toBe(15_000);
  });

  it("never exceeds the subtotal (floor or flat clamped down)", () => {
    expect(computeDepositCents(10_000, pct(25, { minCents: 15_000 }))).toBe(10_000);
    expect(computeDepositCents(10_000, pct(25, { flatCents: 50_000 }))).toBe(10_000);
  });

  it("returns 0 for a non-positive or garbage subtotal", () => {
    expect(computeDepositCents(0, pct(25))).toBe(0);
    expect(computeDepositCents(-500, pct(25))).toBe(0);
    expect(computeDepositCents(Number.NaN, pct(25))).toBe(0);
  });
});
