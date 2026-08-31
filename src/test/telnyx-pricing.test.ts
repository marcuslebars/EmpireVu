import { describe, expect, it } from "vitest";

import careCatalog from "@/server/services/quotes/__fixtures__/a1-care-catalog.json";
import coatingsCatalog from "@/server/services/quotes/__fixtures__/a1-coatings-catalog.json";
import storageCatalog from "@/server/services/quotes/__fixtures__/a1-catalog.json";
import type { ServiceCatalog } from "@/server/services/quotes/catalog";
import { priceTelnyxQuote, spokenAmount } from "@/server/services/telnyx/pricing";

type PartialCatalog = {
  items?: Record<string, unknown>;
  bundles?: Record<string, unknown>;
  surcharges?: Record<string, unknown>;
};

// A real voice call resolves to ONE brand, but this exercises the input→line
// mapping, so merge all three A1 catalogs into one fixture to cover every type.
function merge(...cats: PartialCatalog[]): ServiceCatalog {
  return {
    items: Object.assign({}, ...cats.map((c) => c.items ?? {})),
    bundles: Object.assign({}, ...cats.map((c) => c.bundles ?? {})),
    surcharges: Object.assign({}, ...cats.map((c) => c.surcharges ?? {})),
  } as unknown as ServiceCatalog;
}

const CATALOG = merge(
  storageCatalog as PartialCatalog,
  careCatalog as PartialCatalog,
  coatingsCatalog as PartialCatalog,
);
const STORAGE_ONLY = merge(storageCatalog as PartialCatalog);

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
    const result = priceTelnyxQuote(base, CATALOG);
    expect(result.status).toBe("missing_info");
    expect(result).toMatchObject({ missing: ["service_type"] });
  });

  it("asks for boat length on per-foot services", () => {
    for (const serviceType of ["shrink_wrap", "outdoor_storage", "ceramic", "detailing"]) {
      const result = priceTelnyxQuote({ ...base, serviceType }, CATALOG);
      expect(result.status, serviceType).toBe("missing_info");
      expect(result, serviceType).toMatchObject({ missing: ["boat_length_ft"] });
    }
  });

  it("asks for engine type on winterization (it picks the service)", () => {
    const result = priceTelnyxQuote({ ...base, boatLengthFt: 24, serviceType: "winterization" }, CATALOG);
    expect(result.status).toBe("missing_info");
    expect(result).toMatchObject({ missing: ["engine_type"] });
  });

  it("asks for a detailing tier rather than defaulting one in", () => {
    const result = priceTelnyxQuote({ ...base, boatLengthFt: 24, serviceType: "detailing" }, CATALOG);
    expect(result).toMatchObject({ missing: ["tier"], status: "missing_info" });
  });

  it("reports unsupported service types instead of inventing a price", () => {
    const result = priceTelnyxQuote({ ...base, boatLengthFt: 24, serviceType: "helicopter_pad" }, CATALOG);
    expect(result.status).toBe("unsupported");
  });
});

describe("priceTelnyxQuote — quoting from the brand catalog", () => {
  it("prices shrink wrap from the catalog in cents", () => {
    const result = priceTelnyxQuote(
      { ...base, boatLengthFt: 24, boatType: "bowrider", serviceType: "shrink_wrap" },
      CATALOG,
    );
    expect(result.status).toBe("quoted");
    if (result.status !== "quoted") return;
    // Sane positive amount in CENTS (a dollars/cents slip shows up here as 100x).
    expect(result.quoteTotalCents).toBeGreaterThan(10_000);
    expect(result.currency).toBe("CAD");
    expect(result.lineItems.length).toBeGreaterThan(0);
    expect(result.spokenSummary).toContain("24-foot bowrider");
  });

  it("prices ceramic coating in cents", () => {
    const result = priceTelnyxQuote({ ...base, boatLengthFt: 24, serviceType: "ceramic" }, CATALOG);
    expect(result.status).toBe("quoted");
    if (result.status !== "quoted") return;
    // 24ft × $35/ft = $840 = 84,000 cents — the catalog is cents, not dollars.
    expect(result.quoteTotalCents).toBe(84_000);
  });

  it("accepts a valid detailing tier", () => {
    const result = priceTelnyxQuote(
      { ...base, boatLengthFt: 24, serviceType: "detailing", tier: "standard" },
      CATALOG,
    );
    expect(result.status).toBe("quoted");
  });

  it("normalizes service type spelling/casing", () => {
    const result = priceTelnyxQuote({ ...base, boatLengthFt: 24, serviceType: "Shrink Wrap" }, CATALOG);
    expect(result.status).toBe("quoted");
  });

  it("never quotes a deposit larger than the job", () => {
    const result = priceTelnyxQuote({ ...base, boatLengthFt: 24, serviceType: "shrink_wrap" }, CATALOG);
    if (result.status !== "quoted") throw new Error("expected a quote");
    expect(result.depositCents).toBeLessThanOrEqual(result.quoteTotalCents);
    expect(result.depositCents).toBeGreaterThan(0);
  });
});

describe("priceTelnyxQuote — per-brand handoff", () => {
  it("hands off a service the brand doesn't sell (storage line asked for ceramic)", () => {
    // The storage catalog has no `ceramic` key (only ceramic_upgrade, a different
    // service), so Marina offers a callback rather than quoting a coatings price.
    const result = priceTelnyxQuote({ ...base, boatLengthFt: 24, serviceType: "ceramic" }, STORAGE_ONLY);
    expect(result.status).toBe("unsupported");
  });

  it("hands off when the brand has no catalog at all", () => {
    const result = priceTelnyxQuote({ ...base, boatLengthFt: 24, serviceType: "shrink_wrap" }, null);
    expect(result.status).toBe("unsupported");
  });
});

describe("spokenAmount", () => {
  it("drops trailing .00 so the agent says '$432' not '$432.00'", () => {
    expect(spokenAmount(43_200)).toBe("$432");
    expect(spokenAmount(43_250)).toBe("$432.50");
  });
});
