import { describe, expect, it } from "vitest";

import { brandForOrg, platformBrand, PLATFORM_BRANDS, receptionistCopy, receptionistName } from "@/lib/platform-brand";

describe("PR 2: the receptionist copy follows the PRODUCT LINE, not the brand name", () => {
  it("both entries display Everdoer, yet keep their product-line copy", () => {
    expect(PLATFORM_BRANDS.empirevu.name).toBe(PLATFORM_BRANDS.crankleads.name);
    expect(receptionistName({ productLine: "standard" })).toBe("Marina");
    expect(receptionistName({ productLine: "done_for_you" })).toBe("AI receptionist");
    // Old and Phase 3 stored values, and a done-for-you tier with no platform_brand.
    expect(receptionistName(platformBrand("crankleads"))).toBe("AI receptionist");
    expect(receptionistName(platformBrand("done_for_you"))).toBe("AI receptionist");
    expect(receptionistName(platformBrand("standard"))).toBe("Marina");
    expect(receptionistName(brandForOrg({ platform_brand: null, crankleads_tier: "front_desk" }))).toBe("AI receptionist");
    expect(receptionistName(brandForOrg({ platform_brand: "empirevu" }))).toBe("Marina");
  });
});

describe("the AI receptionist's name by brand", () => {
  it("house tenants keep Marina; done-for-you owners never see the name", () => {
    expect(receptionistName(PLATFORM_BRANDS.empirevu)).toBe("Marina");
    expect(receptionistName(PLATFORM_BRANDS.crankleads)).toBe("AI receptionist");
    expect(receptionistCopy("Call with Marina", PLATFORM_BRANDS.empirevu)).toBe("Call with Marina");
    const cl = (t: string) => receptionistCopy(t, PLATFORM_BRANDS.crankleads);
    expect(cl("Call with Marina")).toBe("Call with the AI receptionist");
    expect(cl("Voice (Marina)")).toBe("Voice (AI receptionist)");
    expect(cl("Marina call")).toBe("AI receptionist call");
    expect(cl("Marina is calling Jamie…")).toBe("The AI receptionist is calling Jamie…");
    expect(cl("Marina minutes")).toBe("AI receptionist minutes");
    for (const t of ["Call with Marina", "Voice (Marina)", "Marina call", "Recordings and transcripts of Marina's calls with this lead will appear here."]) {
      expect(cl(t)).not.toMatch(/Marina/);
    }
  });
});
