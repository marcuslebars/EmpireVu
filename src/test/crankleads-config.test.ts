/**
 * CrankLeads tier → plan / price / pack / recipe mapping, the phone-step gating by plan,
 * the Stripe catalog setup script (mocked Stripe), the welcome email copy, and the
 * set-password link plumbing on the SPA side.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PLAN_FEATURE_DEFAULTS } from "@/server/services/billing/config";
import { planForStripePriceId } from "@/server/services/billing/env";
import {
  CATCH_RECIPE_SLUGS,
  CRANKLEADS_BUSINESS_TYPES,
  CRANKLEADS_TIER_PLAN,
  crankleadsTierForPriceId,
  packIdForBusinessType,
  packRecipesForTier,
  RECEPTIONIST_RECIPE_SLUGS,
} from "@/server/services/crankleads/config";
import { renderWelcomeEmail } from "@/server/services/crankleads/emails";
import { parseProvisionJobArgs } from "@/server/services/crankleads/rerun";
import { getPack } from "@/server/services/packs";
import { getRecipe } from "@/server/services/workflow-engine/recipes";
import { isPublicPath, safeNextPath } from "@/lib/public-routes";
import {
  formatEnv,
  isLiveKey,
  parseArgs,
  setupCrankleads,
  UsageError,
} from "../../scripts/stripe/setup-crankleads.mjs";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("tier → plan", () => {
  it("Catch and Close run on operate (workflows + SMS); Front Desk on front_desk", () => {
    expect(CRANKLEADS_TIER_PLAN).toEqual({ catch: "operate", close: "operate", front_desk: "front_desk" });
    // Catch needs the missed-call text-back + instant replies: workflows + SMS.
    expect(PLAN_FEATURE_DEFAULTS.operate.workflows).toBe(true);
    expect(PLAN_FEATURE_DEFAULTS.operate.sms_sequences).toBe(true);
    // Only Front Desk gets the AI receptionist.
    expect(PLAN_FEATURE_DEFAULTS.operate.marina_reception).toBe(false);
    expect(PLAN_FEATURE_DEFAULTS.front_desk.marina_reception).toBe(true);
  });

  it("maps CrankLeads monthly price ids to plans in the billing worker (alongside the plan prices)", () => {
    vi.stubEnv("STRIPE_PRICE_OPERATE", "price_operate");
    vi.stubEnv("STRIPE_PRICE_CL_CATCH", "price_cl_catch");
    vi.stubEnv("STRIPE_PRICE_CL_CLOSE", "price_cl_close");
    vi.stubEnv("STRIPE_PRICE_CL_FRONT_DESK", "price_cl_fd");
    expect(planForStripePriceId("price_operate")).toBe("operate");
    expect(planForStripePriceId("price_cl_catch")).toBe("operate");
    expect(planForStripePriceId("price_cl_close")).toBe("operate");
    expect(planForStripePriceId("price_cl_fd")).toBe("front_desk");
    expect(planForStripePriceId("price_unknown")).toBeNull();
    expect(crankleadsTierForPriceId("price_cl_close")).toBe("close");
    expect(crankleadsTierForPriceId("price_operate")).toBeNull();
  });

  it("an unset CrankLeads env never matches an empty price id", () => {
    vi.stubEnv("STRIPE_PRICE_CL_CATCH", "");
    expect(crankleadsTierForPriceId("")).toBeNull();
    expect(planForStripePriceId(null)).toBeNull();
  });
});

describe("business type → industry pack", () => {
  it("maps every crankleads.com business type", () => {
    const mapped = Object.fromEntries(CRANKLEADS_BUSINESS_TYPES.map((t) => [t, packIdForBusinessType(t)]));
    expect(mapped).toEqual({
      "Property maintenance & snow": "property-maintenance-snow",
      Landscaping: "landscaping",
      Roofing: "roofing",
      "HVAC & plumbing": "hvac-plumbing",
      "Contracting & renovation": "general-contractor",
      Marine: "marine",
      "Auto detailing": null,
      Cleaning: null,
      Other: null,
    });
    for (const id of Object.values(mapped)) if (id) expect(getPack(id), id).not.toBeNull();
    expect(packIdForBusinessType("  roofing ")).toBe("roofing");
    expect(packIdForBusinessType("Something new")).toBeNull();
  });
});

describe("recipes per tier", () => {
  const roofing = getPack("roofing")!.recipes.map((r) => r.slug);

  it("every referenced recipe exists", () => {
    for (const slug of [...CATCH_RECIPE_SLUGS, ...RECEPTIONIST_RECIPE_SLUGS]) expect(getRecipe(slug), slug).not.toBeNull();
  });

  it("Catch gets text-back, new-lead alert, booking reminder, reply forwarding — no receptionist recipes", () => {
    const catchSet = packRecipesForTier("catch", roofing);
    expect(catchSet).toEqual(expect.arrayContaining(["missed-call-text-back", "new-lead-owner-alert", "booking-reminder"]));
    expect(catchSet.every((s) => CATCH_RECIPE_SLUGS.includes(s))).toBe(true);
  });

  it("Close gets every pack recipe except the receptionist ones; Front Desk gets them all", () => {
    const close = packRecipesForTier("close", roofing);
    expect(close.some((s) => RECEPTIONIST_RECIPE_SLUGS.includes(s))).toBe(false);
    expect(close).toContain("quote-follow-up");
    expect(packRecipesForTier("front_desk", roofing)).toEqual(roofing);
    expect(roofing.some((s) => RECEPTIONIST_RECIPE_SLUGS.includes(s))).toBe(true);
  });
});

describe("welcome email", () => {
  const base = {
    ownerName: "Jane Roofer",
    businessName: "Jane's Roofing",
    setPasswordUrl: "https://app.test/update-password?token_hash=h&type=recovery&next=%2Fonboarding",
    appUrl: "https://app.test",
    formUrl: "https://app.test/f/evpk_x",
    packName: "Roofing",
    servicesNeedingPrices: 7,
  };

  it("names CrankLeads as the purchase AND the app; done-for-you copy (setup link, no DIY steps); no prices", () => {
    const setupUrl = "https://app.test/setup/abcdefghijklmnopqrstuvwxyz012345";
    const email = renderWelcomeEmail({ ...base, tier: "catch", setupUrl });
    expect(email.subject).toBe("You're in — we're setting up CrankLeads for you");
    expect(email.body).toContain("You can still log in to CrankLeads at app.test any time");
    for (const tier of ["catch", "close", "front_desk"] as const) {
      for (const setPasswordUrl of [base.setPasswordUrl, null]) {
        const e = renderWelcomeEmail({ ...base, tier, setPasswordUrl, setupUrl });
        expect(`${e.subject}\n${e.body}\n${e.html}\n${e.fromName}`).not.toMatch(/empire\s*vu/i);
      }
    }
    expect(email.body).toContain(base.setPasswordUrl);
    expect(email.body).toContain("Check your texts");
    expect(email.body).toContain(setupUrl);
    expect(email.html).toContain(`href="${setupUrl}"`);
    expect(email.body).toContain("we're setting up Jane's Roofing for you");
    // No self-serve checklist any more.
    expect(email.body).not.toMatch(/Finish these|Add your prices|turn on missed-call forwarding|10 minutes/);
    expect(email.body).toContain("Already done:");
    expect(email.body).toContain(base.formUrl);
    expect(email.body).not.toMatch(/\$\s?\d/);
    expect(email.html).toContain("<strong>Jane's Roofing</strong>");
    expect(renderWelcomeEmail({ ...base, tier: "front_desk" }).body).toContain("AI receptionist");
    // Without a link (couldn't be made) it still points at the text.
    const noLink = renderWelcomeEmail({ ...base, tier: "catch", setupUrl: null });
    expect(noLink.body).toContain("we're sending you a link to a 60-second quick setup");
    expect(noLink.body).not.toContain("/setup/");
  });

  it("escapes HTML", () => {
    const email = renderWelcomeEmail({ ...base, tier: "close", businessName: "<script>x</script>" });
    expect(email.html).not.toContain("<script>");
  });
});

describe("re-run job args", () => {
  it("parses --session in both spellings", () => {
    expect(parseProvisionJobArgs(["--session", "cs_test_1"])).toMatchObject({ sessionId: "cs_test_1", stuck: false });
    expect(parseProvisionJobArgs(["--session=cs_test_2"])).toMatchObject({ sessionId: "cs_test_2" });
    expect(parseProvisionJobArgs([])).toEqual({ sessionId: null, stuck: false, olderThanMinutes: 15 });
    expect(parseProvisionJobArgs(["--stuck", "--older-than-minutes", "30"])).toEqual({ sessionId: null, stuck: true, olderThanMinutes: 30 });
  });
});

describe("SPA set-password plumbing", () => {
  it("the welcome page and the set-password page open signed out", () => {
    expect(isPublicPath("/welcome/crankleads")).toBe(true);
    expect(isPublicPath("/update-password")).toBe(true);
    expect(isPublicPath("/welcome/crankleads/admin")).toBe(false);
  });

  it("only follows same-origin `next` paths", () => {
    expect(safeNextPath("/onboarding")).toBe("/onboarding");
    expect(safeNextPath("//evil.example")).toBeNull();
    expect(safeNextPath("https://evil.example")).toBeNull();
    expect(safeNextPath("/\\evil.example")).toBeNull();
    expect(safeNextPath(null)).toBeNull();
  });
});

// ── scripts/stripe/setup-crankleads.mjs (mocked Stripe client) ─────────────────

const ARGS = [
  "--catch-setup", "100",
  "--catch-monthly", "10",
  "--close-setup", "200",
  "--close-monthly", "20",
  "--front-desk-setup", "300",
  "--front-desk-monthly", "30",
];

interface FakePrice {
  id: string;
  product: string;
  unit_amount: number;
  currency: string;
  lookup_key: string;
  recurring: { interval: string; interval_count: number } | null;
  active: boolean;
}

function fakeStripe() {
  const products = new Map<string, { id: string; active: boolean }>();
  const prices: FakePrice[] = [];
  const coupons = new Map<string, Record<string, unknown>>();
  let seq = 0;
  const missing = () => Object.assign(new Error("No such resource"), { code: "resource_missing", statusCode: 404 });
  const stripe = {
    products: {
      retrieve: vi.fn(async (id: string) => {
        const p = products.get(id);
        if (!p) throw missing();
        return p;
      }),
      create: vi.fn(async (params: { id: string }) => {
        products.set(params.id, { id: params.id, active: true });
        return products.get(params.id);
      }),
      update: vi.fn(),
    },
    prices: {
      list: vi.fn(async ({ lookup_keys }: { lookup_keys: string[] }) => ({
        data: prices.filter((p) => p.active && lookup_keys.includes(p.lookup_key)),
      })),
      create: vi.fn(async (params: Record<string, unknown>) => {
        if (params.transfer_lookup_key) {
          for (const p of prices) if (p.lookup_key === params.lookup_key) p.lookup_key = "";
        }
        const price: FakePrice = {
          id: `price_${++seq}`,
          product: params.product as string,
          unit_amount: params.unit_amount as number,
          currency: params.currency as string,
          lookup_key: params.lookup_key as string,
          recurring: (params.recurring as FakePrice["recurring"]) ?? null,
          active: true,
        };
        prices.push(price);
        return price;
      }),
    },
    coupons: {
      retrieve: vi.fn(async (id: string) => {
        const c = coupons.get(id);
        if (!c) throw missing();
        return c;
      }),
      create: vi.fn(async (params: Record<string, unknown>) => {
        const c = { ...params, applies_to: params.applies_to };
        coupons.set(params.id as string, c);
        return c;
      }),
    },
  };
  return { stripe, prices, products, coupons };
}

describe("stripe:setup-crankleads", () => {
  const silent = () => undefined;

  it("requires every amount (no defaults) and validates them", () => {
    expect(() => parseArgs([])).toThrow(UsageError);
    expect(() => parseArgs(ARGS.slice(0, -1))).toThrow(/front-desk-monthly/);
    expect(() => parseArgs([...ARGS.slice(0, -1), "12.50"])).toThrow(/whole number of cents/);
    expect(() => parseArgs([...ARGS, "--founding-percent", "150", "--founding-max", "5"])).toThrow(/1–100/);
    const parsed = parseArgs([...ARGS, "--founding-percent", "50", "--founding-max", "5", "--dry-run"]);
    expect(parsed.amounts.front_desk).toEqual({ setup: 300, monthly: 30 });
    expect(parsed.founding).toEqual({ percent: 50, max: 5 });
    expect(parsed.dryRun).toBe(true);
  });

  it("refuses a live key unless --live", async () => {
    expect(isLiveKey("sk_live_x")).toBe(true);
    expect(isLiveKey("rk_live_x")).toBe(true);
    expect(isLiveKey("sk_test_x")).toBe(false);
    const { stripe } = fakeStripe();
    await expect(setupCrankleads({ stripe, args: parseArgs(ARGS), keyIsLive: true, log: silent })).rejects.toThrow(/LIVE/);
    expect(stripe.products.create).not.toHaveBeenCalled();
  });

  it("dry run creates nothing", async () => {
    const { stripe } = fakeStripe();
    await setupCrankleads({ stripe, args: parseArgs([...ARGS, "--dry-run", "--founding-percent", "50", "--founding-max", "5"]), keyIsLive: false, log: silent });
    expect(stripe.products.create).not.toHaveBeenCalled();
    expect(stripe.prices.create).not.toHaveBeenCalled();
    expect(stripe.coupons.create).not.toHaveBeenCalled();
  });

  it("creates products, CAD prices with lookup keys and a setup-only founding coupon — and is idempotent", async () => {
    const { stripe, prices } = fakeStripe();
    const args = parseArgs([...ARGS, "--founding-percent", "50", "--founding-max", "5"]);
    const env = await setupCrankleads({ stripe, args, keyIsLive: false, log: silent });

    expect(Object.keys(env)).toEqual([
      "STRIPE_PRICE_CL_CATCH",
      "STRIPE_SETUP_FEE_CL_CATCH",
      "STRIPE_PRICE_CL_CLOSE",
      "STRIPE_SETUP_FEE_CL_CLOSE",
      "STRIPE_PRICE_CL_FRONT_DESK",
      "STRIPE_SETUP_FEE_CL_FRONT_DESK",
      "STRIPE_COUPON_CL_FOUNDING",
    ]);
    expect(formatEnv(env)).toContain("STRIPE_COUPON_CL_FOUNDING=crankleads_founding_50");
    expect(prices).toHaveLength(6);
    const monthly = prices.find((p) => p.lookup_key === "crankleads_catch_monthly")!;
    expect(monthly).toMatchObject({ unit_amount: 10, currency: "cad", product: "crankleads_catch", recurring: { interval: "month", interval_count: 1 } });
    const setup = prices.find((p) => p.lookup_key === "crankleads_catch_setup")!;
    expect(setup).toMatchObject({ unit_amount: 100, currency: "cad", product: "crankleads_catch_setup", recurring: null });

    const couponParams = stripe.coupons.create.mock.calls[0][0];
    expect(couponParams).toMatchObject({
      id: "crankleads_founding_50",
      percent_off: 50,
      duration: "once",
      max_redemptions: 5,
      applies_to: { products: ["crankleads_catch_setup", "crankleads_close_setup", "crankleads_front_desk_setup"] },
    });

    // Second run: everything found, nothing created, same env.
    const again = await setupCrankleads({ stripe, args, keyIsLive: false, log: silent });
    expect(again).toEqual(env);
    expect(stripe.prices.create).toHaveBeenCalledTimes(6);
    expect(stripe.products.create).toHaveBeenCalledTimes(6);
    expect(stripe.coupons.create).toHaveBeenCalledTimes(1);
  });

  it("refuses a lookup key that points at a price on the WRONG product", async () => {
    const { stripe, prices } = fakeStripe();
    await setupCrankleads({ stripe, args: parseArgs(ARGS), keyIsLive: false, log: silent });
    prices.find((p) => p.lookup_key === "crankleads_close_monthly")!.product = "prod_someone_else";
    await expect(setupCrankleads({ stripe, args: parseArgs(ARGS), keyIsLive: false, log: silent })).rejects.toThrow(/belongs to product prod_someone_else/);
  });

  it("a changed amount needs --replace (prices are immutable), which moves the lookup key", async () => {
    const { stripe } = fakeStripe();
    const first = await setupCrankleads({ stripe, args: parseArgs(ARGS), keyIsLive: false, log: silent });
    const changed = [...ARGS.slice(0, 3), "11", ...ARGS.slice(4)];
    await expect(setupCrankleads({ stripe, args: parseArgs(changed), keyIsLive: false, log: silent })).rejects.toThrow(/--replace/);
    const replaced = await setupCrankleads({ stripe, args: parseArgs([...changed, "--replace"]), keyIsLive: false, log: silent });
    expect(replaced.STRIPE_PRICE_CL_CATCH).not.toBe(first.STRIPE_PRICE_CL_CATCH);
    expect(replaced.STRIPE_SETUP_FEE_CL_CATCH).toBe(first.STRIPE_SETUP_FEE_CL_CATCH);
    expect(stripe.prices.create.mock.calls.at(-1)?.[0]).toMatchObject({ transfer_lookup_key: true, unit_amount: 11 });
  });
});

beforeEach(() => {
  vi.unstubAllEnvs();
});
