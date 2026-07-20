import { describe, expect, it } from "vitest";

import { priceTelnyxQuote, spokenAmount } from "@/server/services/telnyx/pricing";

const base = {
  boatLengthFt: null,
  boatType: null,
  engineCount: null,
  engineType: null,
  serviceType: null,
  tier: null,
};

describe("priceTelnyxQuote — missing info instead of guessing", () => {
  it("asks for the service type when absent", () => {
    const result = priceTelnyxQuote(base);
    expect(result.status).toBe("missing_info");
    expect(result).toMatchObject({ missing: ["service_type"] });
  });

  it("asks for boat length on per-foot services", () => {
    for (const serviceType of ["shrink_wrap", "outdoor_storage", "ceramic", "detailing"]) {
      const result = priceTelnyxQuote({ ...base, serviceType });
      expect(result.status, serviceType).toBe("missing_info");
      expect(result, serviceType).toMatchObject({ missing: ["boat_length_ft"] });
    }
  });

  it("asks for engine type on winterization (it picks the flat rate)", () => {
    const result = priceTelnyxQuote({ ...base, boatLengthFt: 24, serviceType: "winterization" });
    expect(result.status).toBe("missing_info");
    expect(result).toMatchObject({ missing: ["engine_type"] });
  });

  it("asks for a detailing tier rather than defaulting one in", () => {
    const result = priceTelnyxQuote({ ...base, boatLengthFt: 24, serviceType: "detailing" });
    expect(result).toMatchObject({ missing: ["tier"], status: "missing_info" });
  });

  it("reports unsupported service types instead of inventing a price", () => {
    const result = priceTelnyxQuote({ ...base, boatLengthFt: 24, serviceType: "helicopter_pad" });
    expect(result.status).toBe("unsupported");
  });
});

describe("priceTelnyxQuote — quoting", () => {
  it("prices shrink wrap from the storage engine in cents", () => {
    const result = priceTelnyxQuote({
      ...base,
      boatLengthFt: 24,
      boatType: "bowrider",
      serviceType: "shrink_wrap",
    });

    expect(result.status).toBe("quoted");
    if (result.status !== "quoted") return;
    // The engine is the source of truth; assert it's a sane positive amount in
    // CENTS (a dollars/cents slip would show up here as a 100x error).
    expect(result.quoteTotalCents).toBeGreaterThan(10_000);
    expect(result.currency).toBe("CAD");
    expect(result.lineItems.length).toBeGreaterThan(0);
    expect(result.spokenSummary).toContain("24-foot bowrider");
  });

  it("normalizes marine-care dollars into cents", () => {
    const result = priceTelnyxQuote({ ...base, boatLengthFt: 24, serviceType: "ceramic" });

    expect(result.status).toBe("quoted");
    if (result.status !== "quoted") return;
    // calculateCeramic returns 840 (DOLLARS) for 24ft; the adapter must store
    // 84000 cents, not 840.
    expect(result.quoteTotalCents).toBe(84_000);
  });

  it("accepts a valid detailing tier", () => {
    const result = priceTelnyxQuote({
      ...base,
      boatLengthFt: 24,
      serviceType: "detailing",
      tier: "standard",
    });
    expect(result.status).toBe("quoted");
  });

  it("normalizes service type spelling/casing", () => {
    const result = priceTelnyxQuote({ ...base, boatLengthFt: 24, serviceType: "Shrink Wrap" });
    expect(result.status).toBe("quoted");
  });

  it("never quotes a deposit larger than the job", () => {
    const result = priceTelnyxQuote({ ...base, boatLengthFt: 24, serviceType: "shrink_wrap" });
    if (result.status !== "quoted") throw new Error("expected a quote");
    expect(result.depositCents).toBeLessThanOrEqual(result.quoteTotalCents);
    expect(result.depositCents).toBeGreaterThan(0);
  });
});

describe("spokenAmount", () => {
  it("drops trailing .00 so the agent says '$432' not '$432.00'", () => {
    expect(spokenAmount(43_200)).toBe("$432");
    expect(spokenAmount(43_250)).toBe("$432.50");
  });
});
