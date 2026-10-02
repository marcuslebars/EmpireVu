import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PLATFORM_BRAND_DEFAULTS,
  PLATFORM_BRAND_ENV_KEYS,
  platformBrandHtmlEnv,
  resolvePlatformBrand,
  splitWordmark,
} from "@/lib/platform-brand-core";
import { applyPlatformBrandToDocument, CLIENT_PLATFORM_BRAND_ENV, readClientPlatformBrand } from "@/lib/platform-brand";
import { getPlatformBrand } from "@/server/platform-brand";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("platform brand defaults (CrankLeads)", () => {
  it("resolves every field from an empty env", () => {
    const brand = resolvePlatformBrand(() => undefined);
    expect(brand).toEqual({
      name: "CrankLeads",
      shortName: "CrankLeads",
      tagline: "Done-for-you lead system for trades",
      supportEmail: PLATFORM_BRAND_DEFAULTS.supportEmail,
      websiteUrl: "https://crankleads.com",
      legalName: "CrankLeads",
      emailFromName: "CrankLeads",
      poweredBy: "Powered by CrankLeads",
      logoUrl: null,
      faviconUrl: "/crankleads-favicon.svg",
      accentHsl: "82 85% 55%",
      wordmark: { accent: "Crank", rest: "Leads" },
    });
  });

  it("the SPA and server adapters agree on the defaults", () => {
    expect(readClientPlatformBrand({})).toEqual(getPlatformBrand({}));
  });

  it("never defaults to the engine name", () => {
    const text = JSON.stringify(resolvePlatformBrand(() => undefined)).toLowerCase();
    expect(text).not.toContain("empirevu");
    expect(text).not.toContain("empire vu");
  });
});

describe("env overrides", () => {
  it("SPA reads VITE_-prefixed keys", () => {
    const brand = readClientPlatformBrand({
      VITE_PLATFORM_BRAND_NAME: "ShopBoss",
      VITE_PLATFORM_SUPPORT_EMAIL: "help@shopboss.test",
      VITE_PLATFORM_WEBSITE_URL: "https://shopboss.test/",
      VITE_PLATFORM_LEGAL_NAME: "ShopBoss Holdings Inc.",
      VITE_PLATFORM_BRAND_LOGO_URL: "/brand/shopboss.svg",
      VITE_PLATFORM_BRAND_ACCENT_HSL: "200, 90%, 50%",
      // Unprefixed keys are server-only and must be ignored by the SPA.
      PLATFORM_BRAND_NAME: "Wrong",
    });
    expect(brand.name).toBe("ShopBoss");
    expect(brand.shortName).toBe("ShopBoss");
    expect(brand.supportEmail).toBe("help@shopboss.test");
    expect(brand.websiteUrl).toBe("https://shopboss.test");
    expect(brand.legalName).toBe("ShopBoss Holdings Inc.");
    expect(brand.logoUrl).toBe("/brand/shopboss.svg");
    expect(brand.accentHsl).toBe("200 90% 50%");
    expect(brand.wordmark).toEqual({ accent: "Shop", rest: "Boss" });
    expect(brand.poweredBy).toBe("Powered by ShopBoss");
  });

  it("server reads unprefixed keys from process.env", () => {
    vi.stubEnv("PLATFORM_BRAND_NAME", "ShopBoss");
    vi.stubEnv("PLATFORM_SUPPORT_EMAIL", "help@shopboss.test");
    vi.stubEnv("PLATFORM_EMAIL_FROM_NAME", "ShopBoss Team");
    const brand = getPlatformBrand();
    expect(brand.name).toBe("ShopBoss");
    expect(brand.supportEmail).toBe("help@shopboss.test");
    expect(brand.emailFromName).toBe("ShopBoss Team");
  });

  it("emailFromName and legalName follow the name when unset", () => {
    const brand = getPlatformBrand({ PLATFORM_BRAND_NAME: "Acme" });
    expect(brand.emailFromName).toBe("Acme");
    expect(brand.legalName).toBe("Acme");
    expect(brand.wordmark).toEqual({ accent: "Acme", rest: "" });
  });

  it("blank, invalid or unsafe values fall back instead of winning", () => {
    const brand = getPlatformBrand({
      PLATFORM_BRAND_NAME: "   ",
      PLATFORM_SUPPORT_EMAIL: "not an email",
      PLATFORM_WEBSITE_URL: "javascript:alert(1)",
      PLATFORM_BRAND_LOGO_URL: "//evil.test/logo.png",
      PLATFORM_BRAND_FAVICON_URL: "data:image/svg+xml,<svg/>",
      PLATFORM_BRAND_ACCENT_HSL: "lime",
      PLATFORM_EMAIL_FROM_NAME: '<script>"x"</script>',
    });
    expect(brand.name).toBe("CrankLeads");
    expect(brand.supportEmail).toBe(PLATFORM_BRAND_DEFAULTS.supportEmail);
    expect(brand.websiteUrl).toBe("https://crankleads.com");
    expect(brand.logoUrl).toBeNull();
    expect(brand.faviconUrl).toBe("/crankleads-favicon.svg");
    expect(brand.accentHsl).toBe("82 85% 55%");
    expect(brand.emailFromName).not.toMatch(/[<>"]/);
  });

  it("rejects out-of-range HSL", () => {
    expect(getPlatformBrand({ PLATFORM_BRAND_ACCENT_HSL: "400 50% 50%" }).accentHsl).toBe("82 85% 55%");
  });
});

describe("wordmark split", () => {
  it.each([
    ["CrankLeads", "Crank", "Leads"],
    ["ShopBoss Pro", "Shop", "Boss Pro"],
    ["acme", "acme", ""],
    ["Acme", "Acme", ""],
  ])("%s → %s + %s", (name, accent, rest) => {
    expect(splitWordmark(name)).toEqual({ accent, rest });
  });
});

describe("index.html build-time values", () => {
  it("publishes resolved values for every %VITE_…% placeholder index.html uses", () => {
    const html = platformBrandHtmlEnv(resolvePlatformBrand(() => undefined));
    expect(html).toEqual({
      VITE_PLATFORM_BRAND_NAME: "CrankLeads",
      VITE_PLATFORM_BRAND_TAGLINE: "Done-for-you lead system for trades",
      VITE_PLATFORM_BRAND_FAVICON_URL: "/crankleads-favicon.svg",
    });
  });

  it("index.html contains no hardcoded product name, only placeholders vite.config fills", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const indexHtml = readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");
    const placeholders = [...indexHtml.matchAll(/%(VITE_[A-Z_]+)%/g)].map((m) => m[1]);
    expect(placeholders.length).toBeGreaterThan(0);
    const filled = Object.keys(platformBrandHtmlEnv(resolvePlatformBrand(() => undefined)));
    for (const key of placeholders) expect(filled).toContain(key);
    expect(indexHtml).not.toMatch(/EmpireVu|CrankLeads/);
  });

  it("client env names are the VITE_ form of the shared keys (server-only from-name excluded)", () => {
    expect(CLIENT_PLATFORM_BRAND_ENV).toContain("VITE_PLATFORM_BRAND_NAME");
    expect(CLIENT_PLATFORM_BRAND_ENV).not.toContain(`VITE_${PLATFORM_BRAND_ENV_KEYS.emailFromName}`);
  });
});

describe("applyPlatformBrandToDocument", () => {
  it("sets the accent variable and fills an unsubstituted title", () => {
    document.title = "%VITE_PLATFORM_BRAND_NAME%";
    applyPlatformBrandToDocument(readClientPlatformBrand({ VITE_PLATFORM_BRAND_ACCENT_HSL: "10 20% 30%" }));
    expect(document.documentElement.style.getPropertyValue("--brand-accent")).toBe("10 20% 30%");
    expect(document.title).toBe("CrankLeads");
  });

  it("leaves a real title alone (e.g. the public quote page's company title)", () => {
    document.title = "Quote Q-1 — A1 Marine";
    applyPlatformBrandToDocument(readClientPlatformBrand({}));
    expect(document.title).toBe("Quote Q-1 — A1 Marine");
  });
});
