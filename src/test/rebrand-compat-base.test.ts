import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  envWithFallback,
  flushLegacyUsage,
  headerWithFallback,
  noteLegacyUsage,
  resetLegacyEnvNotes,
  sampleFromUrl,
  setLegacyUsageSink,
} from "@/server/services/rebrand/legacy-usage";
import { writeNewNames } from "@/server/services/rebrand/write-names";
import {
  isDoneForYou,
  isDoneForYouOrg,
  normalizeProductLine,
  PRODUCT_LINE_DB_VALUES,
  productLineForOrg,
} from "@/lib/product-line";

// Everdoer rebrand PR 1: the old-name usage counter and the product-line shim.
describe("legacy usage counter", () => {
  const calls: Array<[string, string, string | null, number]> = [];
  beforeEach(() => {
    calls.length = 0;
    resetLegacyEnvNotes();
    setLegacyUsageSink((kind, key, sample, count) => {
      calls.push([kind, key, sample, count]);
    });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => {
    setLegacyUsageSink(null);
    vi.restoreAllMocks();
  });

  it("counts a header fallback on every request (batched), never the value", async () => {
    const info = vi.mocked(console.info);
    const h = new Headers({ "x-empirevu-key": "secret-value" });
    expect(headerWithFallback(h, "x-everdoer-key", "x-empirevu-key", "/api/intake")).toBe("secret-value");
    expect(headerWithFallback(h, "x-everdoer-key", "x-empirevu-key", "/api/intake")).toBe("secret-value");
    expect(info).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([]);
    await flushLegacyUsage();
    expect(calls).toEqual([["header", "x-empirevu-key", "/api/intake", 2]]);
    expect(JSON.stringify(info.mock.calls)).not.toContain("secret-value");
    expect(JSON.stringify(calls)).not.toContain("secret-value");
  });

  it("prefers the new header and counts nothing", async () => {
    const h = new Headers({ "x-everdoer-key": "new", "x-empirevu-key": "old" });
    expect(headerWithFallback(h, "x-everdoer-key", "x-empirevu-key")).toBe("new");
    await flushLegacyUsage();
    expect(calls).toEqual([]);
    expect(headerWithFallback(new Headers(), "x-everdoer-key", "x-empirevu-key")).toBeNull();
  });

  it("reads the new env var first, then old names in order, counting each old name once", async () => {
    const env = { CRANKLEADS_APP_BASE_URL: " https://app.crankleads.com ", APP_BASE_URL: "x" };
    expect(envWithFallback("EVERDOER_APP_BASE_URL", ["CRANKLEADS_APP_BASE_URL"], env)).toBe("https://app.crankleads.com");
    expect(envWithFallback("EVERDOER_APP_BASE_URL", ["CRANKLEADS_APP_BASE_URL"], env)).toBe("https://app.crankleads.com");
    await flushLegacyUsage();
    expect(calls).toEqual([["env", "CRANKLEADS_APP_BASE_URL", "instead of EVERDOER_APP_BASE_URL", 1]]);
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
    noteLegacyUsage("host", "app.empirevu.com");
    await expect(flushLegacyUsage()).resolves.toBeUndefined();
    setLegacyUsageSink(() => Promise.reject(new Error("down")));
    noteLegacyUsage("host", "app.empirevu.com");
    await expect(flushLegacyUsage()).resolves.toBeUndefined();
  });

  it("logs a busy old host at most once a minute but counts every hit", async () => {
    const info = vi.mocked(console.info);
    for (let i = 0; i < 50; i += 1) noteLegacyUsage("host", "app.empirevu.com/api", "/api/me");
    expect(info).toHaveBeenCalledTimes(1);
    await flushLegacyUsage();
    expect(calls).toEqual([["host", "app.empirevu.com/api", "/api/me", 50]]);
  });

  it("flushes on its own after the delay", async () => {
    vi.useFakeTimers();
    try {
      noteLegacyUsage("route", "/welcome/crankleads");
      expect(calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(15_001);
      expect(calls).toEqual([["route", "/welcome/crankleads", null, 1]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("only writes new names when EVERDOER_WRITE_NEW_NAMES is on", () => {
    expect(writeNewNames({})).toBe(false);
    expect(writeNewNames({ EVERDOER_WRITE_NEW_NAMES: "0" })).toBe(false);
    expect(writeNewNames({ EVERDOER_WRITE_NEW_NAMES: " 1 " })).toBe(true);
    expect(writeNewNames({ EVERDOER_WRITE_NEW_NAMES: "true" })).toBe(true);
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
