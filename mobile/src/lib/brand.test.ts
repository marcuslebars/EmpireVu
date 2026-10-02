import { describe, expect, it } from "vitest";

import { resolveMobileBrand } from "@m/lib/brand";

describe("mobile brand", () => {
  it("defaults to CrankLeads with the lime accent", () => {
    const b = resolveMobileBrand({});
    expect(b.name).toBe("CrankLeads");
    expect(b.wordmark).toEqual({ accent: "Crank", rest: "Leads" });
    expect(b.accentHsl).toBe("82 85% 55%");
    expect(b.supportEmail).toContain("@");
  });

  it("takes env overrides and rejects junk", () => {
    const b = resolveMobileBrand({
      VITE_PLATFORM_BRAND_NAME: "  Acme ",
      VITE_PLATFORM_SUPPORT_EMAIL: "not-an-email",
      VITE_PLATFORM_BRAND_ACCENT_HSL: "200 50% 40%",
    });
    expect(b.name).toBe("Acme");
    expect(b.wordmark).toEqual({ accent: "Acme", rest: "" });
    expect(b.supportEmail).not.toBe("not-an-email");
    expect(b.accentHsl).toBe("200 50% 40%");
  });
});
