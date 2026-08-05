/**
 * Stripe webhook route — signature gate + durable-write ordering.
 * Proves: missing config -> 503; missing/invalid signature -> 400 and NO write;
 * valid signature -> 200 and record called once; a duplicate (record resolves
 * null) still returns 200.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recordBillingEvent = vi.fn();
const constructEvent = vi.fn();

vi.mock("@/server/services/billing/events", () => ({
  recordBillingEvent: (...args: unknown[]) => recordBillingEvent(...args),
}));
vi.mock("@/server/services/billing/stripe", () => ({
  getStripeClient: () => ({ webhooks: { constructEvent: (...a: unknown[]) => constructEvent(...a) } }),
}));
vi.mock("@/server/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({}),
}));

import { POST } from "@/app/api/webhooks/stripe/route";

const req = (body: string, sig?: string) =>
  new Request("http://test/api/webhooks/stripe", {
    body,
    headers: sig ? { "stripe-signature": sig } : {},
    method: "POST",
  });

const validEvent = { data: { object: {} }, id: "evt_1", type: "invoice.paid" };

beforeEach(() => {
  recordBillingEvent.mockReset();
  recordBillingEvent.mockResolvedValue("be-1");
  constructEvent.mockReset();
  constructEvent.mockReturnValue(validEvent);
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_x";
});
afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

describe("stripe webhook route", () => {
  it("503 when Stripe env is not configured, and no write", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const res = await POST(req("{}", "sig"));
    expect(res.status).toBe(503);
    expect(constructEvent).not.toHaveBeenCalled();
    expect(recordBillingEvent).not.toHaveBeenCalled();
  });

  it("400 when the signature header is missing, and no write", async () => {
    const res = await POST(req("{}"));
    expect(res.status).toBe(400);
    expect(recordBillingEvent).not.toHaveBeenCalled();
  });

  it("400 on an invalid signature, and no write", async () => {
    constructEvent.mockImplementation(() => {
      throw new Error("bad signature");
    });
    const res = await POST(req("{}", "sig"));
    expect(res.status).toBe(400);
    expect(recordBillingEvent).not.toHaveBeenCalled();
  });

  it("200 on a valid signature, record called once", async () => {
    const res = await POST(req(JSON.stringify(validEvent), "sig"));
    expect(res.status).toBe(200);
    expect(recordBillingEvent).toHaveBeenCalledTimes(1);
    expect((await res.json()).received).toBe(true);
  });

  it("200 on a duplicate delivery (record resolves null = no-op)", async () => {
    recordBillingEvent.mockResolvedValue(null);
    const res = await POST(req(JSON.stringify(validEvent), "sig"));
    expect(res.status).toBe(200);
    expect(recordBillingEvent).toHaveBeenCalledTimes(1);
  });
});
