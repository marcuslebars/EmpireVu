/**
 * Everdoer rebrand PR 1 — Stripe:
 *   - metadata.source: readers accept {"crankleads", "everdoer"}; the Checkout writer stamps
 *     "everdoer" only under EVERDOER_WRITE_NEW_NAMES; new objects written with the old value are
 *     counted (reads are not: every live subscription carries the old value).
 *   - a second, optional webhook signing secret per endpoint (STRIPE_WEBHOOK_SECRET_2,
 *     STRIPE_CONNECT_WEBHOOK_SECRET_2), verified with the REAL Stripe library over the raw body.
 */
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureLegacyUsage } from "@/test/helpers/legacy-usage-capture";

const recordBillingEvent = vi.fn();
vi.mock("@/server/services/billing/events", () => ({ recordBillingEvent: (...a: unknown[]) => recordBillingEvent(...a) }));
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => ({}) }));
vi.mock("@/server/services/rate-limit", () => ({ enforceWebhookBackstop: () => Promise.resolve(null) }));
const stripe = new Stripe("sk_test_dummy");
vi.mock("@/server/services/billing/stripe", () => ({ getStripeClient: () => stripe }));
vi.mock("@/server/services/quotes/company-stripe", () => ({ getPlatformStripe: () => stripe }));

import { POST as connectPOST } from "@/app/api/webhooks/stripe/connect/route";
import { POST as platformPOST } from "@/app/api/webhooks/stripe/route";
import { constructStripeEvent, secondaryWebhookSecret } from "@/server/services/billing/webhook-secrets";
import { buildDoneForYouSessionParams } from "@/server/services/done-for-you/checkout";
import { isDoneForYouObject } from "@/server/services/done-for-you/provision";
import {
  DONE_FOR_YOU_STRIPE_SOURCES,
  isDoneForYouStripeSource,
  stripeSourceForWrite,
} from "@/server/services/done-for-you/stripe-source";

const ENV_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_WEBHOOK_SECRET_2",
  "STRIPE_CONNECT_WEBHOOK_SECRET",
  "STRIPE_CONNECT_WEBHOOK_SECRET_2",
  "EVERDOER_WRITE_NEW_NAMES",
  "STRIPE_PRICE_CL_CATCH",
  "STRIPE_SETUP_FEE_CL_CATCH",
];
const saved: Record<string, string | undefined> = {};
let usage: ReturnType<typeof captureLegacyUsage>;

beforeEach(() => {
  usage = captureLegacyUsage();
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  recordBillingEvent.mockReset().mockResolvedValue("be-1");
});
afterEach(() => {
  usage.restore();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("metadata.source readers accept both values", () => {
  it("the set is exactly {crankleads, everdoer}", () => {
    expect([...DONE_FOR_YOU_STRIPE_SOURCES].sort()).toEqual(["crankleads", "everdoer"]);
    expect(isDoneForYouStripeSource("crankleads")).toBe(true);
    expect(isDoneForYouStripeSource("everdoer")).toBe(true);
    expect(isDoneForYouStripeSource("empirevu")).toBe(false);
    expect(isDoneForYouStripeSource(undefined)).toBe(false);
  });

  it("isCrankleadsObject: session, subscription_details and parent.subscription_details, either value", async () => {
    for (const source of ["crankleads", "everdoer"]) {
      expect(isDoneForYouObject({ metadata: { source } } as never)).toBe(true);
      expect(isDoneForYouObject({ subscription_details: { metadata: { source } } } as never)).toBe(true);
      expect(isDoneForYouObject({ parent: { subscription_details: { metadata: { source } } } } as never)).toBe(true);
    }
    expect(isDoneForYouObject({ metadata: { source: "something_else" } } as never)).toBe(false);
    expect(isDoneForYouObject({ metadata: {} } as never)).toBe(false);
    // Reads of the old value are deliberately NOT counted (every live subscription has it).
    expect(await usage.rows()).toEqual([]);
  });
});

describe("metadata.source writer", () => {
  it("flag off: 'crankleads', counted once per new object", async () => {
    expect(stripeSourceForWrite()).toBe("crankleads");
    expect(await usage.rows()).toEqual([{ kind: "stripe_metadata", key: "source=crankleads", sample: "checkout.sessions.create", count: 1 }]);
  });

  it("flag on: 'everdoer', not counted", async () => {
    process.env.EVERDOER_WRITE_NEW_NAMES = "1";
    expect(stripeSourceForWrite()).toBe("everdoer");
    expect(await usage.rows()).toEqual([]);
  });

  it("the Checkout Session and its subscription carry the same value, following the flag", () => {
    process.env.STRIPE_PRICE_CL_CATCH = "price_m";
    process.env.STRIPE_SETUP_FEE_CL_CATCH = "price_s";
    const input = { tier: "catch", email: "a@b.co", name: "Pat", phone: "+17055550100", businessName: "Pat's", businessType: "plumbing" } as never;
    for (const [flag, value] of [[undefined, "crankleads"], ["1", "everdoer"]] as const) {
      if (flag) process.env.EVERDOER_WRITE_NEW_NAMES = flag;
      const params = buildDoneForYouSessionParams({ id: "p1" }, input, {}, null);
      expect(params.metadata?.source).toBe(value);
      expect((params.subscription_data?.metadata as Record<string, string>).source).toBe(value);
    }
  });
});

describe("second webhook secret", () => {
  const PRIMARY = "whsec_primary_123";
  const SECONDARY = "whsec_secondary_456";
  const body = JSON.stringify({ id: "evt_1", object: "event", type: "invoice.paid", data: { object: {} } });
  const signed = (secret: string) => stripe.webhooks.generateTestHeaderString({ payload: body, secret });
  const req = (path: string, sig: string) => new Request(`http://test${path}`, { method: "POST", body, headers: { "stripe-signature": sig } });

  it("secondaryWebhookSecret reads <NAME>_2, blank = unset", () => {
    expect(secondaryWebhookSecret("STRIPE_WEBHOOK_SECRET", { STRIPE_WEBHOOK_SECRET_2: " s2 " })).toBe("s2");
    expect(secondaryWebhookSecret("STRIPE_WEBHOOK_SECRET", { STRIPE_WEBHOOK_SECRET_2: "  " })).toBeNull();
    expect(secondaryWebhookSecret("STRIPE_CONNECT_WEBHOOK_SECRET", {})).toBeNull();
  });

  it("constructStripeEvent: primary, then secondary; neither → the primary's error", () => {
    expect(constructStripeEvent(stripe.webhooks, body, signed(PRIMARY), PRIMARY, SECONDARY).id).toBe("evt_1");
    expect(constructStripeEvent(stripe.webhooks, body, signed(SECONDARY), PRIMARY, SECONDARY).id).toBe("evt_1");
    expect(() => constructStripeEvent(stripe.webhooks, body, signed(SECONDARY), PRIMARY, null)).toThrow(/signature/i);
    expect(() => constructStripeEvent(stripe.webhooks, body, signed("whsec_other"), PRIMARY, SECONDARY)).toThrow(/signature/i);
    // Raw body is untouched: a re-serialised body fails under both secrets.
    expect(() => constructStripeEvent(stripe.webhooks, `${body} `, signed(SECONDARY), PRIMARY, SECONDARY)).toThrow();
  });

  describe("/api/webhooks/stripe", () => {
    beforeEach(() => {
      process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
      process.env.STRIPE_WEBHOOK_SECRET = PRIMARY;
    });
    it("primary verifies; secondary unset → a secondary-signed event is 400 with no write", async () => {
      expect((await platformPOST(req("/api/webhooks/stripe", signed(PRIMARY)))).status).toBe(200);
      expect((await platformPOST(req("/api/webhooks/stripe", signed(SECONDARY)))).status).toBe(400);
      expect(recordBillingEvent).toHaveBeenCalledTimes(1);
    });
    it("STRIPE_WEBHOOK_SECRET_2 set → both verify; a third secret is still 400", async () => {
      process.env.STRIPE_WEBHOOK_SECRET_2 = SECONDARY;
      expect((await platformPOST(req("/api/webhooks/stripe", signed(PRIMARY)))).status).toBe(200);
      expect((await platformPOST(req("/api/webhooks/stripe", signed(SECONDARY)))).status).toBe(200);
      expect((await platformPOST(req("/api/webhooks/stripe", signed("whsec_other")))).status).toBe(400);
      expect(recordBillingEvent).toHaveBeenCalledTimes(2);
    });
    it("the secondary never replaces a missing primary (503)", async () => {
      delete process.env.STRIPE_WEBHOOK_SECRET;
      process.env.STRIPE_WEBHOOK_SECRET_2 = SECONDARY;
      expect((await platformPOST(req("/api/webhooks/stripe", signed(SECONDARY)))).status).toBe(503);
    });
  });

  describe("/api/webhooks/stripe/connect", () => {
    beforeEach(() => {
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET = PRIMARY;
    });
    it("primary verifies; secondary only when STRIPE_CONNECT_WEBHOOK_SECRET_2 is set", async () => {
      // No event.account → acknowledged 200 after verification, no handler runs.
      expect((await connectPOST(req("/api/webhooks/stripe/connect", signed(PRIMARY)))).status).toBe(200);
      expect((await connectPOST(req("/api/webhooks/stripe/connect", signed(SECONDARY)))).status).toBe(400);
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET_2 = SECONDARY;
      expect((await connectPOST(req("/api/webhooks/stripe/connect", signed(SECONDARY)))).status).toBe(200);
      expect((await connectPOST(req("/api/webhooks/stripe/connect", signed("whsec_other")))).status).toBe(400);
    });
    it("the secondary never replaces a missing primary (500, Stripe retries)", async () => {
      delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET_2 = SECONDARY;
      expect((await connectPOST(req("/api/webhooks/stripe/connect", signed(SECONDARY)))).status).toBe(500);
    });
  });
});
