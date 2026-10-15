import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureLegacyUsage } from "@/test/helpers/legacy-usage-capture";

vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => ({}) }));
vi.mock("@/server/services/waitlist/notify", () => ({ notifyNewWaitlistSignup: vi.fn() }));

import { OPTIONS as waitlistOPTIONS } from "@/app/api/waitlist/route";
import {
  doneForYouCancelUrl,
  doneForYouCheckoutBranding,
  doneForYouFoundingCouponId,
  doneForYouMonthlyPriceId,
  doneForYouSetupPriceId,
  doneForYouSiteOrigins,
  planTierForPriceId,
  ENV_RENAMES,
} from "@/server/services/done-for-you/config";
import {
  appBaseUrlFor,
  configuredAppBaseUrlFor,
  resetRejectedEverdoerAppBaseUrls,
} from "@/server/services/platform-brand";
import { quotePublicBaseUrlFor } from "@/server/services/quotes/config";

// Everdoer rebrand PR 1: EVERDOER_* env names read first, the old names as a counted fallback.

let capture: ReturnType<typeof captureLegacyUsage>;

const ALL_NAMES = [
  ...Object.keys(ENV_RENAMES),
  ...Object.values(ENV_RENAMES).flat(),
  "EVERDOER_APP_BASE_URL",
  "CRANKLEADS_APP_BASE_URL",
  "APP_BASE_URL",
  "QUOTE_PUBLIC_BASE_URL",
  "QUOTE_PUBLIC_BASE_URL_EVERDOER",
  "QUOTE_PUBLIC_BASE_URL_CRANKLEADS",
];

beforeEach(() => {
  for (const name of ALL_NAMES) vi.stubEnv(name, "");
  capture = captureLegacyUsage();
});

afterEach(() => {
  capture.restore();
  vi.unstubAllEnvs();
});

async function envRows(): Promise<string[]> {
  return (await capture.rows()).filter((r) => r.kind === "env").map((r) => r.key);
}

describe("crankleads/config.ts env renames", () => {
  it("lists the exact new → old names", () => {
    expect(ENV_RENAMES).toEqual({
      STRIPE_PRICE_EVERDOER_CATCH: ["STRIPE_PRICE_CL_CATCH"],
      STRIPE_PRICE_EVERDOER_CLOSE: ["STRIPE_PRICE_CL_CLOSE"],
      STRIPE_PRICE_EVERDOER_FRONT_DESK: ["STRIPE_PRICE_CL_FRONT_DESK"],
      STRIPE_SETUP_FEE_EVERDOER_CATCH: ["STRIPE_SETUP_FEE_CL_CATCH"],
      STRIPE_SETUP_FEE_EVERDOER_CLOSE: ["STRIPE_SETUP_FEE_CL_CLOSE"],
      STRIPE_SETUP_FEE_EVERDOER_FRONT_DESK: ["STRIPE_SETUP_FEE_CL_FRONT_DESK"],
      STRIPE_COUPON_EVERDOER_FOUNDING: ["STRIPE_COUPON_CL_FOUNDING"],
      EVERDOER_SITE_ORIGINS: ["CRANKLEADS_SITE_ORIGINS"],
      EVERDOER_CANCEL_URL: ["CRANKLEADS_CANCEL_URL"],
      EVERDOER_CHECKOUT_DISPLAY_NAME: ["CRANKLEADS_CHECKOUT_DISPLAY_NAME"],
      EVERDOER_CHECKOUT_LOGO_URL: ["CRANKLEADS_CHECKOUT_LOGO_URL"],
      EVERDOER_CHECKOUT_BACKGROUND_COLOR: ["CRANKLEADS_CHECKOUT_BACKGROUND_COLOR"],
      EVERDOER_CHECKOUT_BUTTON_COLOR: ["CRANKLEADS_CHECKOUT_BUTTON_COLOR"],
    });
  });

  it("old names still work and are counted", async () => {
    vi.stubEnv("STRIPE_PRICE_CL_CATCH", "price_old_catch");
    vi.stubEnv("STRIPE_SETUP_FEE_CL_CLOSE", "price_old_setup_close");
    vi.stubEnv("STRIPE_COUPON_CL_FOUNDING", "coupon_old");
    vi.stubEnv("CRANKLEADS_CANCEL_URL", "https://crankleads.com/#old");
    vi.stubEnv("CRANKLEADS_CHECKOUT_BUTTON_COLOR", "#123456");
    expect(doneForYouMonthlyPriceId("catch")).toBe("price_old_catch");
    expect(planTierForPriceId("price_old_catch")).toBe("catch");
    expect(doneForYouSetupPriceId("close")).toBe("price_old_setup_close");
    expect(doneForYouFoundingCouponId()).toBe("coupon_old");
    expect(doneForYouCancelUrl()).toBe("https://crankleads.com/#old");
    expect(doneForYouCheckoutBranding().buttonColor).toBe("#123456");
    expect((await envRows()).sort()).toEqual(
      [
        "CRANKLEADS_CANCEL_URL",
        "CRANKLEADS_CHECKOUT_BUTTON_COLOR",
        "STRIPE_COUPON_CL_FOUNDING",
        "STRIPE_PRICE_CL_CATCH",
        "STRIPE_SETUP_FEE_CL_CLOSE",
      ].sort(),
    );
  });

  it("new names win when both are set, and are not counted", async () => {
    vi.stubEnv("STRIPE_PRICE_CL_CATCH", "price_old");
    vi.stubEnv("STRIPE_PRICE_EVERDOER_CATCH", "price_new");
    vi.stubEnv("STRIPE_SETUP_FEE_EVERDOER_FRONT_DESK", "price_new_setup");
    vi.stubEnv("CRANKLEADS_CHECKOUT_DISPLAY_NAME", "Old");
    vi.stubEnv("EVERDOER_CHECKOUT_DISPLAY_NAME", "New");
    vi.stubEnv("EVERDOER_CHECKOUT_LOGO_URL", "https://everdoer.com/logo.png");
    vi.stubEnv("EVERDOER_CHECKOUT_BACKGROUND_COLOR", "#000000");
    expect(doneForYouMonthlyPriceId("catch")).toBe("price_new");
    expect(planTierForPriceId("price_old")).toBeNull();
    expect(doneForYouSetupPriceId("front_desk")).toBe("price_new_setup");
    expect(doneForYouCheckoutBranding()).toMatchObject({
      displayName: "New",
      logoUrl: "https://everdoer.com/logo.png",
      backgroundColor: "#000000",
    });
    expect(await envRows()).toEqual([]);
  });

  it("defaults when nothing is set: Everdoer checkout branding (plus the everdoer.com origins)", async () => {
    expect(doneForYouMonthlyPriceId("close")).toBeNull();
    expect(doneForYouFoundingCouponId()).toBeNull();
    expect(doneForYouCancelUrl()).toBe("https://crankleads.com/#pricing");
    // No https app origin (local dev): Stripe needs an https logo, so the old hosted image.
    expect(doneForYouCheckoutBranding()).toEqual({
      displayName: "Everdoer",
      logoUrl: "https://crankleads.com/brand/crankleads-logo.png",
      backgroundColor: "#0C0E12",
      buttonColor: "#A6EE2B",
    });
    vi.stubEnv("APP_BASE_URL", "https://app.empirevu.com/");
    expect(doneForYouCheckoutBranding().logoUrl).toBe("https://app.empirevu.com/brand/everdoer/everdoer-logo-dark.png");
    vi.stubEnv("EVERDOER_APP_BASE_URL", "https://app.everdoer.com");
    expect(doneForYouCheckoutBranding().logoUrl).toBe("https://app.everdoer.com/brand/everdoer/everdoer-logo-dark.png");
    expect([...doneForYouSiteOrigins()].sort()).toEqual(
      ["https://crankleads.com", "https://www.crankleads.com", "https://everdoer.com", "https://www.everdoer.com"].sort(),
    );
    expect(await envRows()).toEqual([]);
  });

  it("EVERDOER_SITE_ORIGINS ← CRANKLEADS_SITE_ORIGINS", async () => {
    vi.stubEnv("CRANKLEADS_SITE_ORIGINS", "https://old.example/");
    expect([...doneForYouSiteOrigins()]).toEqual(["https://old.example"]);
    vi.stubEnv("EVERDOER_SITE_ORIGINS", "https://new.example");
    expect([...doneForYouSiteOrigins()]).toEqual(["https://new.example"]);
    expect(await envRows()).toEqual(["CRANKLEADS_SITE_ORIGINS"]);
  });
});

describe("appBaseUrlFor: EVERDOER_APP_BASE_URL for every org (PR 2)", () => {
  it("done-for-you: the new name, then the old, then APP_BASE_URL; standard: the new name, then APP_BASE_URL", async () => {
    vi.stubEnv("APP_BASE_URL", "https://app.empirevu.com");
    expect(appBaseUrlFor("crankleads")).toBe("https://app.empirevu.com");
    vi.stubEnv("CRANKLEADS_APP_BASE_URL", "https://app.crankleads.com/");
    expect(appBaseUrlFor("crankleads")).toBe("https://app.crankleads.com");
    expect(configuredAppBaseUrlFor("crankleads")).toBe("https://app.crankleads.com");
    // Until EVERDOER_APP_BASE_URL is set, a standard org (A1 etc.) is unchanged: never the old
    // done-for-you origin.
    expect(appBaseUrlFor("empirevu")).toBe("https://app.empirevu.com");
    expect(appBaseUrlFor("standard")).toBe("https://app.empirevu.com");
    expect(await envRows()).toEqual(["CRANKLEADS_APP_BASE_URL"]);
    vi.stubEnv("EVERDOER_APP_BASE_URL", "https://app.everdoer.com/");
    expect(appBaseUrlFor("crankleads")).toBe("https://app.everdoer.com");
    expect(appBaseUrlFor("done_for_you")).toBe("https://app.everdoer.com");
    expect(appBaseUrlFor("empirevu")).toBe("https://app.everdoer.com");
    expect(appBaseUrlFor(null)).toBe("https://app.everdoer.com");
    expect(configuredAppBaseUrlFor("empirevu")).toBe("https://app.everdoer.com");
  });

  it.each([
    "https://app.crankleads.com",
    "https://app.empirevu.com",
    "https://quotes.a1marinestorage.ca",
    "https://everdoer.com.evil.example",
    "https://noteverdoer.com",
    "ftp://app.everdoer.com",
    "not a url",
  ])("ignores EVERDOER_APP_BASE_URL=%s (not an everdoer or dev host), counted once", async (bad) => {
    resetRejectedEverdoerAppBaseUrls();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("APP_BASE_URL", "https://app.empirevu.com");
    vi.stubEnv("CRANKLEADS_APP_BASE_URL", "https://app.crankleads.com");
    vi.stubEnv("EVERDOER_APP_BASE_URL", bad);
    // A1's links don't move; done-for-you keeps its PR 1 chain.
    expect(appBaseUrlFor("empirevu")).toBe("https://app.empirevu.com");
    expect(appBaseUrlFor("crankleads")).toBe("https://app.crankleads.com");
    expect(configuredAppBaseUrlFor("empirevu")).toBe("https://app.empirevu.com");
    expect(quotePublicBaseUrlFor({ platform_brand: "crankleads" })).toBe("https://app.crankleads.com");
    expect(warn).toHaveBeenCalledTimes(1);
    expect((await envRows()).sort()).toEqual(["CRANKLEADS_APP_BASE_URL", "EVERDOER_APP_BASE_URL(invalid-host)"]);
  });

  it.each([
    ["https://app.everdoer.com", "https://app.everdoer.com"],
    ["https://everdoer.com/", "https://everdoer.com"],
    ["https://staging.app.everdoer.com", "https://staging.app.everdoer.com"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://app.everdoer.localhost:5173", "http://app.everdoer.localhost:5173"],
    ["https://app.everdoer.test", "https://app.everdoer.test"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
  ])("honours EVERDOER_APP_BASE_URL=%s", async (good, expected) => {
    vi.stubEnv("APP_BASE_URL", "https://app.empirevu.com");
    vi.stubEnv("EVERDOER_APP_BASE_URL", good);
    expect(appBaseUrlFor("empirevu")).toBe(expected);
    expect(appBaseUrlFor("crankleads")).toBe(expected);
    expect(await envRows()).toEqual([]);
  });

  it("standard orgs: EVERDOER_APP_BASE_URL alone is enough (no APP_BASE_URL)", () => {
    vi.stubEnv("EVERDOER_APP_BASE_URL", "https://app.everdoer.com");
    expect(configuredAppBaseUrlFor("empirevu")).toBe("https://app.everdoer.com");
  });

  it("configuredAppBaseUrlFor is null with nothing set", () => {
    expect(configuredAppBaseUrlFor("crankleads")).toBeNull();
    expect(configuredAppBaseUrlFor("empirevu")).toBeNull();
  });
});

describe("quotePublicBaseUrlFor", () => {
  it("QUOTE_PUBLIC_BASE_URL_EVERDOER ← QUOTE_PUBLIC_BASE_URL_CRANKLEADS ← app base, for either stored value", async () => {
    vi.stubEnv("QUOTE_PUBLIC_BASE_URL", "https://app.empirevu.com");
    vi.stubEnv("CRANKLEADS_APP_BASE_URL", "https://app.crankleads.com");
    expect(quotePublicBaseUrlFor({ platform_brand: "crankleads" })).toBe("https://app.crankleads.com");
    expect(quotePublicBaseUrlFor({ platform_brand: "done_for_you" })).toBe("https://app.crankleads.com");
    vi.stubEnv("QUOTE_PUBLIC_BASE_URL_CRANKLEADS", "https://quotes-old.example");
    expect(quotePublicBaseUrlFor({ platform_brand: "crankleads" })).toBe("https://quotes-old.example");
    vi.stubEnv("QUOTE_PUBLIC_BASE_URL_EVERDOER", "https://quotes-new.example");
    expect(quotePublicBaseUrlFor({ platform_brand: "crankleads" })).toBe("https://quotes-new.example");
    expect(quotePublicBaseUrlFor({ platform_brand: "empirevu" })).toBe("https://app.empirevu.com");
    expect(quotePublicBaseUrlFor({ platform_brand: "standard" })).toBe("https://app.empirevu.com");
    // A tenant's own domain always wins.
    expect(quotePublicBaseUrlFor({ platform_brand: "crankleads", quote_public_base_url: "https://quotes.a1marinecare.ca" })).toBe(
      "https://quotes.a1marinecare.ca",
    );
    expect((await envRows()).sort()).toEqual(["CRANKLEADS_APP_BASE_URL", "QUOTE_PUBLIC_BASE_URL_CRANKLEADS"]);
  });

  it("PR 2: EVERDOER_APP_BASE_URL never moves a standard org's customer links off QUOTE_PUBLIC_BASE_URL", () => {
    // Customer links (quotes, invoices, portal) are company-branded; the platform-wide quote origin
    // may be a tenant domain (docs/empirevu-hub-setup.md), so only a company's own column or the
    // owner's env changes it.
    vi.stubEnv("QUOTE_PUBLIC_BASE_URL", "https://quotes.a1marinestorage.ca");
    vi.stubEnv("EVERDOER_APP_BASE_URL", "https://app.everdoer.com");
    expect(quotePublicBaseUrlFor({ platform_brand: "empirevu" })).toBe("https://quotes.a1marinestorage.ca");
    expect(quotePublicBaseUrlFor({ platform_brand: "empirevu", quote_public_base_url: "https://quotes.a1marinecare.ca" })).toBe(
      "https://quotes.a1marinecare.ca",
    );
    expect(quotePublicBaseUrlFor({ platform_brand: "crankleads" })).toBe("https://app.everdoer.com");
  });
});

describe("waitlist CORS defaults", () => {
  let savedWaitlist: string | undefined;
  beforeEach(() => {
    savedWaitlist = process.env.WAITLIST_ALLOWED_ORIGINS;
    delete process.env.WAITLIST_ALLOWED_ORIGINS;
  });
  afterEach(() => {
    if (savedWaitlist !== undefined) process.env.WAITLIST_ALLOWED_ORIGINS = savedWaitlist;
  });

  it.each(["https://empirevu.com", "https://www.empirevu.com", "https://everdoer.com", "https://www.everdoer.com"])(
    "allows %s by default",
    async (origin) => {
      const res = await waitlistOPTIONS(new Request("https://app.empirevu.com/api/waitlist", { method: "OPTIONS", headers: { origin } }));
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    },
  );

  it("still refuses other origins, and WAITLIST_ALLOWED_ORIGINS still overrides", async () => {
    const preflight = (origin: string) =>
      waitlistOPTIONS(new Request("https://app.empirevu.com/api/waitlist", { method: "OPTIONS", headers: { origin } }));
    expect((await preflight("https://evil.example")).headers.get("access-control-allow-origin")).toBeNull();
    vi.stubEnv("WAITLIST_ALLOWED_ORIGINS", "https://only.example");
    expect((await preflight("https://only.example")).headers.get("access-control-allow-origin")).toBe("https://only.example");
    expect((await preflight("https://everdoer.com")).headers.get("access-control-allow-origin")).toBeNull();
  });
});
