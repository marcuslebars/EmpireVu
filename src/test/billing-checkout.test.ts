/**
 * Checkout session construction — the parts that are easy to get wrong and that
 * Stripe validates at call time:
 *  - the recurring plan price is the only `line_items` entry;
 *  - a one-time setup fee rides as a SECOND `line_items` entry (subscription-mode
 *    Checkout accepts one-time prices alongside the recurring one — Stripe bills
 *    them on the initial invoice only);
 *  - the Stripe customer is created AND persisted to the org before redirect, and
 *    an existing customer is reused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const customersCreate = vi.fn();
const sessionsCreate = vi.fn();

vi.mock("@/server/services/billing/stripe", () => ({
  getStripeClient: () => ({
    checkout: { sessions: { create: (...a: unknown[]) => sessionsCreate(...a) } },
    customers: { create: (...a: unknown[]) => customersCreate(...a) },
  }),
}));

import { createCheckoutSession } from "@/server/services/billing/checkout";

type OrgRow = {
  billing_email: string | null;
  platform_brand?: string;
  crankleads_tier?: string | null;
  id: string;
  name: string;
  plan: string;
  stripe_customer_id: string | null;
};

/**
 * Minimal chainable fake for the two access shapes checkout uses:
 *   from(t).select('*').eq('id', x).single()   -> the org row
 *   from(t).update(patch).eq('id', x)          -> captured, resolves ok
 */
function makeSupabase(org: OrgRow | null) {
  const updates: Record<string, unknown>[] = [];
  const client = {
    from() {
      return {
        eq() {
          return this;
        },
        select() {
          return this;
        },
        single() {
          return Promise.resolve({
            data: org,
            error: org ? null : { message: "no row" },
          });
        },
        update(patch: Record<string, unknown>) {
          updates.push(patch);
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
    },
  };
  return { client, updates };
}

const org = (over: Partial<OrgRow> = {}): OrgRow => ({
  billing_email: "ops@example.com",
  id: "org-1",
  name: "Example Org",
  plan: "launch",
  stripe_customer_id: "cus_existing",
  ...over,
});

beforeEach(() => {
  customersCreate.mockReset();
  customersCreate.mockResolvedValue({ id: "cus_new" });
  sessionsCreate.mockReset();
  sessionsCreate.mockResolvedValue({ id: "cs_1", url: "https://checkout.stripe/cs_1" });
  process.env.STRIPE_PRICE_LAUNCH = "price_launch";
  process.env.APP_BASE_URL = "https://app.test";
});
afterEach(() => {
  delete process.env.STRIPE_PRICE_LAUNCH;
  delete process.env.STRIPE_SETUP_FEE_LAUNCH;
  delete process.env.APP_BASE_URL;
});

describe("createCheckoutSession", () => {
  it("puts only the recurring plan price in line_items (no setup fee configured)", async () => {
    const { client } = makeSupabase(org());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await createCheckoutSession(client as any, { organizationId: "org-1", plan: "launch" });

    expect(out).toEqual({ sessionId: "cs_1", url: "https://checkout.stripe/cs_1" });
    const params = sessionsCreate.mock.calls[0][0];
    expect(params.mode).toBe("subscription");
    expect(params.line_items).toEqual([{ price: "price_launch", quantity: 1 }]);
  });

  it("appends a one-time setup fee as a second line item when configured", async () => {
    process.env.STRIPE_SETUP_FEE_LAUNCH = "price_setup_launch";
    const { client } = makeSupabase(org());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createCheckoutSession(client as any, { organizationId: "org-1", plan: "launch" });

    const params = sessionsCreate.mock.calls[0][0];
    // Recurring plan price first, one-time setup fee second — Stripe bills the
    // one-time price on the initial invoice only.
    expect(params.line_items).toEqual([
      { price: "price_launch", quantity: 1 },
      { price: "price_setup_launch", quantity: 1 },
    ]);
  });

  it("creates and persists a Stripe customer when the org has none", async () => {
    const { client, updates } = makeSupabase(org({ stripe_customer_id: null }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createCheckoutSession(client as any, { organizationId: "org-1", plan: "launch" });

    expect(customersCreate).toHaveBeenCalledTimes(1);
    // id is written back to the org BEFORE the redirect is built.
    expect(updates).toContainEqual({ stripe_customer_id: "cus_new" });
    expect(sessionsCreate.mock.calls[0][0].customer).toBe("cus_new");
  });

  it("reuses an existing Stripe customer without creating another", async () => {
    const { client } = makeSupabase(org({ stripe_customer_id: "cus_existing" }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createCheckoutSession(client as any, { organizationId: "org-1", plan: "launch" });

    expect(customersCreate).not.toHaveBeenCalled();
    expect(sessionsCreate.mock.calls[0][0].customer).toBe("cus_existing");
  });

  it("an EmpireVu org keeps the account branding and APP_BASE_URL return links", async () => {
    const { client } = makeSupabase(org());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createCheckoutSession(client as any, { organizationId: "org-1", plan: "launch" });
    const params = sessionsCreate.mock.calls[0][0];
    expect(params.branding_settings).toBeUndefined();
    expect(params.success_url).toBe("https://app.test/settings/billing?checkout=success");
  });

  it("a CrankLeads org gets CrankLeads Checkout branding and returns to the CrankLeads host", async () => {
    process.env.CRANKLEADS_APP_BASE_URL = "https://app.crankleads.test";
    try {
      const { client } = makeSupabase(org({ platform_brand: "crankleads", crankleads_tier: "catch" }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await createCheckoutSession(client as any, { organizationId: "org-1", plan: "launch" });
      const params = sessionsCreate.mock.calls[0][0];
      expect(params.branding_settings).toMatchObject({ display_name: "CrankLeads", button_color: "#a6ee2b" });
      expect(params.success_url).toBe("https://app.crankleads.test/settings/billing?checkout=success");
      expect(params.cancel_url).toBe("https://app.crankleads.test/settings/billing?checkout=cancelled");
    } finally {
      delete process.env.CRANKLEADS_APP_BASE_URL;
    }
  });
});
