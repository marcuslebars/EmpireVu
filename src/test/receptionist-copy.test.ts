import { describe, expect, it } from "vitest";

import { PLATFORM_BRANDS, receptionistCopy, receptionistName } from "@/lib/platform-brand";

describe("the AI receptionist's name by brand", () => {
  it("house tenants keep Marina; CrankLeads owners never see the name", () => {
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
