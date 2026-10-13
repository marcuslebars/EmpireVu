import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureLegacyUsage } from "@/test/helpers/legacy-usage-capture";

vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => ({}) }));
vi.mock("@/server/services/waitlist/notify", () => ({ notifyNewWaitlistSignup: vi.fn() }));

import { OPTIONS as waitlistOPTIONS } from "@/app/api/waitlist/route";
import {
  crankleadsCancelUrl,
  crankleadsCheckoutBranding,
  crankleadsFoundingCouponId,
  crankleadsMonthlyPriceId,
  crankleadsSetupPriceId,
  crankleadsSiteOrigins,
  crankleadsTierForPriceId,
  ENV_RENAMES,
} from "@/server/services/crankleads/config";
import { appBaseUrlFor, configuredAppBaseUrlFor } from "@/server/services/platform-brand";
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
    expect(crankleadsMonthlyPriceId("catch")).toBe("price_old_catch");
    expect(crankleadsTierForPriceId("price_old_catch")).toBe("catch");
    expect(crankleadsSetupPriceId("close")).toBe("price_old_setup_close");
    expect(crankleadsFoundingCouponId()).toBe("coupon_old");
    expect(crankleadsCancelUrl()).toBe("https://crankleads.com/#old");
    expect(crankleadsCheckoutBranding().buttonColor).toBe("#123456");
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
    expect(crankleadsMonthlyPriceId("catch")).toBe("price_new");
    expect(crankleadsTierForPriceId("price_old")).toBeNull();
    expect(crankleadsSetupPriceId("front_desk")).toBe("price_new_setup");
    expect(crankleadsCheckoutBranding()).toMatchObject({
      displayName: "New",
      logoUrl: "https://everdoer.com/logo.png",
      backgroundColor: "#000000",
    });
    expect(await envRows()).toEqual([]);
  });

  it("defaults are unchanged when nothing is set (plus the everdoer.com origins)", async () => {
    expect(crankleadsMonthlyPriceId("close")).toBeNull();
    expect(crankleadsFoundingCouponId()).toBeNull();
    expect(crankleadsCancelUrl()).toBe("https://crankleads.com/#pricing");
    expect(crankleadsCheckoutBranding()).toEqual({
      displayName: "CrankLeads",
      logoUrl: "https://crankleads.com/brand/crankleads-logo.png",
      backgroundColor: "#0c0f13",
      buttonColor: "#a6ee2b",
    });
    expect([...crankleadsSiteOrigins()].sort()).toEqual(
      ["https://crankleads.com", "https://www.crankleads.com", "https://everdoer.com", "https://www.everdoer.com"].sort(),
    );
    expect(await envRows()).toEqual([]);
  });

  it("EVERDOER_SITE_ORIGINS ← CRANKLEADS_SITE_ORIGINS", async () => {
    vi.stubEnv("CRANKLEADS_SITE_ORIGINS", "https://old.example/");
    expect([...crankleadsSiteOrigins()]).toEqual(["https://old.example"]);
    vi.stubEnv("EVERDOER_SITE_ORIGINS", "https://new.example");
    expect([...crankleadsSiteOrigins()]).toEqual(["https://new.example"]);
    expect(await envRows()).toEqual(["CRANKLEADS_SITE_ORIGINS"]);
  });
});

describe("appBaseUrlFor: EVERDOER_APP_BASE_URL ← CRANKLEADS_APP_BASE_URL (done for you only)", () => {
  it("done-for-you uses the new name, then the old, then APP_BASE_URL; EmpireVu keeps APP_BASE_URL", async () => {
    vi.stubEnv("APP_BASE_URL", "https://app.empirevu.com");
    expect(appBaseUrlFor("crankleads")).toBe("https://app.empirevu.com");
    vi.stubEnv("CRANKLEADS_APP_BASE_URL", "https://app.crankleads.com/");
    expect(appBaseUrlFor("crankleads")).toBe("https://app.crankleads.com");
    expect(configuredAppBaseUrlFor("crankleads")).toBe("https://app.crankleads.com");
    expect(await envRows()).toEqual(["CRANKLEADS_APP_BASE_URL"]);
    vi.stubEnv("EVERDOER_APP_BASE_URL", "https://app.everdoer.com");
    expect(appBaseUrlFor("crankleads")).toBe("https://app.everdoer.com");
    expect(appBaseUrlFor("empirevu")).toBe("https://app.empirevu.com");
    expect(configuredAppBaseUrlFor("empirevu")).toBe("https://app.empirevu.com");
  });

  it("configuredAppBaseUrlFor is null with nothing set", () => {
    expect(configuredAppBaseUrlFor("crankleads")).toBeNull();
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
