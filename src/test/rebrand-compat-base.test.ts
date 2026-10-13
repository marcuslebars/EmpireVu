import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  envWithFallback,
  headerWithFallback,
  noteLegacyUsage,
  resetLegacyEnvNotes,
  sampleFromUrl,
  setLegacyUsageSink,
} from "@/server/services/rebrand/legacy-usage";
import {
  isDoneForYou,
  isDoneForYouOrg,
  normalizeProductLine,
  PRODUCT_LINE_DB_VALUES,
  productLineForOrg,
} from "@/lib/product-line";

// Everdoer rebrand PR 1: the old-name usage counter and the product-line shim.
describe("legacy usage counter", () => {
  const calls: Array<[string, string, string | null]> = [];
  beforeEach(() => {
    calls.length = 0;
    resetLegacyEnvNotes();
    setLegacyUsageSink((kind, key, sample) => {
      calls.push([kind, key, sample]);
    });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => {
    setLegacyUsageSink(null);
    vi.restoreAllMocks();
  });

  it("counts a header fallback on every request, never the value", () => {
    const h = new Headers({ "x-empirevu-key": "secret-value" });
    expect(headerWithFallback(h, "x-everdoer-key", "x-empirevu-key", "/api/intake")).toBe("secret-value");
    expect(headerWithFallback(h, "x-everdoer-key", "x-empirevu-key", "/api/intake")).toBe("secret-value");
    expect(calls).toEqual([
      ["header", "x-empirevu-key", "/api/intake"],
      ["header", "x-empirevu-key", "/api/intake"],
    ]);
    expect(JSON.stringify(calls)).not.toContain("secret-value");
  });

  it("prefers the new header and counts nothing", () => {
    const h = new Headers({ "x-everdoer-key": "new", "x-empirevu-key": "old" });
    expect(headerWithFallback(h, "x-everdoer-key", "x-empirevu-key")).toBe("new");
    expect(calls).toEqual([]);
    expect(headerWithFallback(new Headers(), "x-everdoer-key", "x-empirevu-key")).toBeNull();
  });

  it("reads the new env var first, then old names in order, counting each old name once", () => {
    const env = { CRANKLEADS_APP_BASE_URL: " https://app.crankleads.com ", APP_BASE_URL: "x" };
    expect(envWithFallback("EVERDOER_APP_BASE_URL", ["CRANKLEADS_APP_BASE_URL"], env)).toBe("https://app.crankleads.com");
    expect(envWithFallback("EVERDOER_APP_BASE_URL", ["CRANKLEADS_APP_BASE_URL"], env)).toBe("https://app.crankleads.com");
    expect(calls).toEqual([["env", "CRANKLEADS_APP_BASE_URL", "instead of EVERDOER_APP_BASE_URL"]]);
    expect(envWithFallback("EVERDOER_APP_BASE_URL", ["CRANKLEADS_APP_BASE_URL"], { ...env, EVERDOER_APP_BASE_URL: "https://app.everdoer.com" })).toBe("https://app.everdoer.com");
    expect(envWithFallback("EVERDOER_X", ["OLD_X"], { EVERDOER_X: "  ", OLD_X: "" })).toBeUndefined();
  });

  it("strips the query from samples and never throws when the sink fails", async () => {
    expect(sampleFromUrl("https://app.empirevu.com/q/abc?token=zzz")).toBe("/q/abc");
    expect(sampleFromUrl("/i/x?y=1")).toBe("/i/x");
    setLegacyUsageSink(() => {
      throw new Error("boom");
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(noteLegacyUsage("host", "app.empirevu.com")).resolves.toBeUndefined();
    setLegacyUsageSink(() => Promise.reject(new Error("down")));
    await expect(noteLegacyUsage("host", "app.empirevu.com")).resolves.toBeUndefined();
  });
});

describe("product line shim", () => {
  it("maps old and new stored values", () => {
    expect(normalizeProductLine("crankleads")).toBe("done_for_you");
    expect(normalizeProductLine("done_for_you")).toBe("done_for_you");
    expect(normalizeProductLine(" CrankLeads ")).toBe("done_for_you");
    expect(normalizeProductLine("empirevu")).toBe("standard");
    expect(normalizeProductLine("standard")).toBe("standard");
    expect(normalizeProductLine(null)).toBe("standard");
    expect(normalizeProductLine("something")).toBe("standard");
    expect(isDoneForYou("crankleads")).toBe(true);
  });

  it("treats a tier without a brand as done for you", () => {
    expect(productLineForOrg({ platform_brand: "empirevu", crankleads_tier: "growth" })).toBe("done_for_you");
    expect(productLineForOrg({ plan_tier: "starter" })).toBe("done_for_you");
    expect(productLineForOrg({ platform_brand: "empirevu" })).toBe("standard");
    expect(isDoneForYouOrg(null)).toBe(false);
  });

  it("filters on both old and new values", () => {
    expect(PRODUCT_LINE_DB_VALUES.done_for_you).toEqual(["crankleads", "done_for_you"]);
    expect(PRODUCT_LINE_DB_VALUES.standard).toEqual(["empirevu", "standard"]);
  });
});
