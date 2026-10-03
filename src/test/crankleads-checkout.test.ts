/**
 * Public CrankLeads checkout — POST /api/public/crankleads/checkout, the welcome-page status
 * poll, and the resend endpoint. Proves: validation, CORS allow-list (no credentials), rate
 * limits, body cap, the durable staging row BEFORE Stripe, the EXACT Checkout Session params
 * (prices from env, no amounts), and that the status endpoint leaks nothing but
 * { status, businessName, emailMasked }.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "./helpers/fake-supabase";

let db: FakeDb;
vi.mock("@/server/supabase/admin", () => ({
  createSupabaseAdminClient: () => db.client,
}));

const enforceRateLimit = vi.fn();
vi.mock("@/server/services/rate-limit", () => ({
  clientIp: () => "203.0.113.9",
  trustedClientIp: () => "203.0.113.9",
  enforceRateLimit: (...args: unknown[]) => enforceRateLimit(...args),
}));

const sessionsCreate = vi.fn();
const couponsRetrieve = vi.fn();
vi.mock("@/server/services/billing/stripe", () => ({
  getStripeClient: () => ({
    checkout: { sessions: { create: (...args: unknown[]) => sessionsCreate(...args) } },
    coupons: { retrieve: (...args: unknown[]) => couponsRetrieve(...args) },
  }),
}));

const resendWelcomeEmail = vi.fn();
vi.mock("@/server/services/crankleads/provision", () => ({
  resendWelcomeEmail: (...args: unknown[]) => resendWelcomeEmail(...args),
}));

import { OPTIONS, POST } from "@/app/api/public/crankleads/checkout/route";
import { GET as STATUS } from "@/app/api/public/crankleads/checkout/[sessionId]/route";
import { POST as RESEND } from "@/app/api/public/crankleads/checkout/[sessionId]/resend/route";
import { maskEmail } from "@/server/services/crankleads/purchases";
import { utmMetadata } from "@/server/services/crankleads/checkout";

const SITE = "https://crankleads.com";
const URL_ = "https://app.empirevu.test/api/public/crankleads/checkout";
const SESSION = "cs_test_a1b2c3d4e5f6g7h8i9";

const validBody = {
  tier: "close",
  name: "Jane Roofer",
  email: "Jane@RoofCo.example",
  phone: "(705) 555-0101",
  businessName: "Jane's Roofing",
  businessType: "Roofing",
  utm: { utm_source: "google", utm_campaign: "fall" },
};

function post(body: unknown, headers: Record<string, string> = {}): Request {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", origin: SITE, ...headers },
    body: raw,
  });
}

beforeEach(() => {
  db = createFakeDb({ crankleads_purchases: [] });
  enforceRateLimit.mockReset().mockResolvedValue(null);
  sessionsCreate.mockReset().mockResolvedValue({ id: SESSION, url: "https://checkout.stripe.com/c/pay/cs_test_x" });
  resendWelcomeEmail.mockReset();
  couponsRetrieve.mockReset().mockResolvedValue({ id: "crankleads_founding_50", valid: true });
  vi.stubEnv("APP_BASE_URL", "https://app.empirevu.test/");
  vi.stubEnv("STRIPE_PRICE_CL_CATCH", "price_cl_catch_m");
  vi.stubEnv("STRIPE_SETUP_FEE_CL_CATCH", "price_cl_catch_s");
  vi.stubEnv("STRIPE_PRICE_CL_CLOSE", "price_cl_close_m");
  vi.stubEnv("STRIPE_SETUP_FEE_CL_CLOSE", "price_cl_close_s");
  vi.stubEnv("STRIPE_PRICE_CL_FRONT_DESK", "price_cl_fd_m");
  vi.stubEnv("STRIPE_SETUP_FEE_CL_FRONT_DESK", "price_cl_fd_s");
  vi.stubEnv("STRIPE_COUPON_CL_FOUNDING", "");
  vi.stubEnv("CRANKLEADS_SITE_ORIGINS", "");
  vi.stubEnv("CRANKLEADS_CANCEL_URL", "");
  vi.stubEnv("STRIPE_AUTOMATIC_TAX", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/public/crankleads/checkout", () => {
  it("stages the purchase, then creates the exact Stripe Checkout Session, and returns { url }", async () => {
    const res = await POST(post(validBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_x" });
    expect(res.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();

    // Durable staging row (with the session id recorded afterwards).
    expect(db.tables.crankleads_purchases).toHaveLength(1);
    const row = db.tables.crankleads_purchases[0];
    expect(row).toMatchObject({
      status: "checkout_created",
      tier: "close",
      owner_name: "Jane Roofer",
      owner_email: "jane@roofco.example",
      owner_phone: "(705) 555-0101",
      business_name: "Jane's Roofing",
      business_type: "Roofing",
      founding: false,
      utm: { utm_source: "google", utm_campaign: "fall" },
      stripe_checkout_session_id: SESSION,
    });
    const insertIndex = db.queries.findIndex((q) => q.table === "crankleads_purchases" && q.op === "insert");
    expect(insertIndex).toBeGreaterThanOrEqual(0);

    // The exact session params (golden).
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    const [params, options] = sessionsCreate.mock.calls[0];
    const metadata = {
      source: "crankleads",
      purchaseId: row.id,
      tier: "close",
      plan: "operate",
      businessName: "Jane's Roofing",
      businessType: "Roofing",
      ownerName: "Jane Roofer",
      ownerPhone: "(705) 555-0101",
      utm: '{"utm_source":"google","utm_campaign":"fall"}',
    };
    expect(params).toEqual({
      mode: "subscription",
      line_items: [
        { price: "price_cl_close_m", quantity: 1 },
        { price: "price_cl_close_s", quantity: 1 },
      ],
      customer_email: "jane@roofco.example",
      client_reference_id: row.id,
      currency: "cad",
      billing_address_collection: "required",
      automatic_tax: { enabled: false },
      allow_promotion_codes: false,
      metadata,
      subscription_data: { metadata },
      success_url: "https://app.empirevu.test/welcome/crankleads?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://crankleads.com/#pricing",
    });
    expect(options).toEqual({ idempotencyKey: `crankleads-checkout-${row.id}` });
  });

  it("applies the founding coupon (and no promotion codes) only when asked AND configured", async () => {
    vi.stubEnv("STRIPE_COUPON_CL_FOUNDING", "crankleads_founding_50");
    vi.stubEnv("STRIPE_AUTOMATIC_TAX", "true");
    vi.stubEnv("CRANKLEADS_CANCEL_URL", "https://crankleads.com/pricing");
    await POST(post({ ...validBody, tier: "front_desk", founding: true }));
    const [params] = sessionsCreate.mock.calls[0];
    expect(params.discounts).toEqual([{ coupon: "crankleads_founding_50" }]);
    expect(params.allow_promotion_codes).toBeUndefined();
    expect(params.automatic_tax).toEqual({ enabled: true });
    expect(params.cancel_url).toBe("https://crankleads.com/pricing");
    expect(params.line_items).toEqual([
      { price: "price_cl_fd_m", quantity: 1 },
      { price: "price_cl_fd_s", quantity: 1 },
    ]);
    expect(params.metadata.plan).toBe("front_desk");

    // founding requested but no coupon configured → full price, still no promo-code box.
    vi.stubEnv("STRIPE_COUPON_CL_FOUNDING", "");
    sessionsCreate.mockClear();
    await POST(post({ ...validBody, founding: true }));
    expect(sessionsCreate.mock.calls[0][0].discounts).toBeUndefined();
    expect(sessionsCreate.mock.calls[0][0].allow_promotion_codes).toBe(false);
  });

  it("an exhausted / missing founding coupon never breaks checkout — full price instead", async () => {
    vi.stubEnv("STRIPE_COUPON_CL_FOUNDING", "crankleads_founding_50");
    couponsRetrieve.mockResolvedValueOnce({ id: "crankleads_founding_50", valid: false });
    const exhausted = await POST(post({ ...validBody, founding: true }));
    expect(exhausted.status).toBe(200);
    expect(sessionsCreate.mock.calls[0][0].discounts).toBeUndefined();

    couponsRetrieve.mockRejectedValueOnce(Object.assign(new Error("No such coupon"), { code: "resource_missing" }));
    sessionsCreate.mockClear();
    expect((await POST(post({ ...validBody, founding: true }))).status).toBe(200);
    expect(sessionsCreate.mock.calls[0][0].discounts).toBeUndefined();

    // Valid at check time, rejected at create (last redemption raced us) → retried without it.
    sessionsCreate.mockReset()
      .mockRejectedValueOnce(new Error("Coupon crankleads_founding_50 has reached its max redemptions"))
      .mockResolvedValueOnce({ id: SESSION, url: "https://checkout.stripe.com/c/pay/cs_test_y" });
    const raced = await POST(post({ ...validBody, founding: true }));
    expect(raced.status).toBe(200);
    expect(sessionsCreate.mock.calls[0][0].discounts).toEqual([{ coupon: "crankleads_founding_50" }]);
    expect(sessionsCreate.mock.calls[1][0].discounts).toBeUndefined();
    expect(sessionsCreate.mock.calls[1][1].idempotencyKey).toMatch(/-nodiscount$/);
  });

  it("rejects invalid input with 400 and field errors — nothing staged, Stripe not called", async () => {
    for (const bad of [
      { ...validBody, tier: "platinum" },
      { ...validBody, email: "not-an-email" },
      { ...validBody, phone: "555" },
      { ...validBody, businessName: "   " },
      { tier: "catch" },
    ]) {
      const res = await POST(post(bad));
      expect(res.status, JSON.stringify(bad)).toBe(400);
      const body = await res.json();
      expect(body.fields).toBeTruthy();
    }
    const badJson = await POST(post("{nope"));
    expect(badJson.status).toBe(400);
    expect(db.tables.crankleads_purchases).toHaveLength(0);
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("CORS: allow-listed origins only; a foreign browser origin is refused; preflight answers without credentials", async () => {
    const pre = await OPTIONS(new Request(URL_, { method: "OPTIONS", headers: { origin: "https://www.crankleads.com" } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://www.crankleads.com");
    expect(pre.headers.get("access-control-allow-credentials")).toBeNull();

    const evilPre = await OPTIONS(new Request(URL_, { method: "OPTIONS", headers: { origin: "https://evil.example" } }));
    expect(evilPre.headers.get("access-control-allow-origin")).toBeNull();

    const evil = await POST(post(validBody, { origin: "https://evil.example" }));
    expect(evil.status).toBe(403);
    expect(sessionsCreate).not.toHaveBeenCalled();

    vi.stubEnv("CRANKLEADS_SITE_ORIGINS", "https://staging.crankleads.com, https://crankleads.com/");
    const staging = await POST(post(validBody, { origin: "https://staging.crankleads.com" }));
    expect(staging.status).toBe(200);
    expect(staging.headers.get("access-control-allow-origin")).toBe("https://staging.crankleads.com");
  });

  it("rate-limits per IP (before parsing) and per email", async () => {
    const tooMany = new Response(JSON.stringify({ error: "Too many requests." }), { status: 429 });
    enforceRateLimit.mockResolvedValueOnce(tooMany);
    const res = await POST(post(validBody));
    expect(res.status).toBe(429);
    expect(enforceRateLimit.mock.calls[0][1]).toMatchObject({ scope: "crankleads_checkout", keyParts: ["203.0.113.9"] });
    expect(sessionsCreate).not.toHaveBeenCalled();

    enforceRateLimit.mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce(tooMany);
    const byEmail = await POST(post(validBody));
    expect(byEmail.status).toBe(429);
    expect(enforceRateLimit.mock.calls[1][1]).toMatchObject({ scope: "crankleads_checkout_email", keyParts: ["jane@roofco.example"] });
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("caps the body (declared and streamed)", async () => {
    const big = { ...validBody, businessName: "x".repeat(9000) };
    const declared = await POST(post(big, { "content-length": "9100" }));
    expect(declared.status).toBe(413);
    const streamed = await POST(post(big));
    expect(streamed.status).toBe(413);
    expect(db.tables.crankleads_purchases).toHaveLength(0);
  });

  it("503 when the tier's prices aren't configured (nothing staged); 502 when Stripe fails (row kept)", async () => {
    vi.stubEnv("STRIPE_SETUP_FEE_CL_CATCH", "");
    const unconfigured = await POST(post({ ...validBody, tier: "catch" }));
    expect(unconfigured.status).toBe(503);
    expect(db.tables.crankleads_purchases).toHaveLength(0);

    sessionsCreate.mockRejectedValueOnce(new Error("stripe down"));
    const failed = await POST(post(validBody));
    expect(failed.status).toBe(502);
    expect(db.tables.crankleads_purchases).toHaveLength(1);
  });

  it("keeps utm metadata within Stripe's 500-char limit", () => {
    const utm: Record<string, string> = {};
    for (let i = 0; i < 10; i += 1) utm[`k${i}`] = "v".repeat(100);
    const json = utmMetadata(utm);
    expect(json.length).toBeLessThanOrEqual(500);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

describe("GET /api/public/crankleads/checkout/[sessionId] (welcome page poll)", () => {
  function seed(status: string) {
    db.tables.crankleads_purchases.push({
      id: "p-1",
      status,
      tier: "catch",
      stripe_checkout_session_id: SESSION,
      stripe_customer_id: "cus_secret",
      owner_name: "Jane Roofer",
      owner_email: "jane@roofco.example",
      owner_phone: "+17055550101",
      business_name: "Jane's Roofing",
      business_type: "Roofing",
      organization_id: "org-secret",
      last_error: "internal detail",
    });
  }
  const get = (id: string) => STATUS(new Request(`${URL_}/${id}`), { params: { sessionId: id } });

  it("returns ONLY status, businessName and a masked email", async () => {
    seed("provisioned");
    const res = await get(SESSION);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: { status: "ready", businessName: "Jane's Roofing", emailMasked: "j***@roofco.example" } });
    const text = JSON.stringify(body);
    for (const secret of ["jane@roofco.example", "cus_secret", "org-secret", "7055550101", "internal detail", "p-1"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("maps the internal states", async () => {
    for (const [internal, shown] of [
      ["checkout_created", "pending"],
      ["paid", "provisioning"],
      ["provisioning", "provisioning"],
      ["failed", "failed"],
    ]) {
      db = createFakeDb({ crankleads_purchases: [] });
      seed(internal);
      const body = await (await get(SESSION)).json();
      expect(body.data.status, internal).toBe(shown);
    }
  });

  it("404 for an unknown or malformed session id", async () => {
    expect((await get(SESSION)).status).toBe(404);
    expect((await get("not-a-session")).status).toBe(404);
    expect((await get("cs_test_' or 1=1")).status).toBe(404);
  });

  it("masks emails safely", () => {
    expect(maskEmail("jane@example.com")).toBe("j***@example.com");
    expect(maskEmail("x@y.z")).toBe("x***@y.z");
    expect(maskEmail("broken")).toBe("***");
  });
});

describe("POST /api/public/crankleads/checkout/[sessionId]/resend", () => {
  const resend = (id: string) => RESEND(new Request(`${URL_}/${id}/resend`, { method: "POST" }), { params: { sessionId: id } });

  it("is rate-limited per IP and per session, and maps outcomes", async () => {
    resendWelcomeEmail.mockResolvedValueOnce("sent");
    const ok = await resend(SESSION);
    expect(ok.status).toBe(200);
    expect(enforceRateLimit.mock.calls.map((c) => c[1].scope)).toEqual(["crankleads_resend_ip", "crankleads_resend"]);
    expect(enforceRateLimit.mock.calls[1][1]).toMatchObject({ limit: 3, keyParts: [SESSION] });

    resendWelcomeEmail.mockResolvedValueOnce("not_ready");
    expect((await resend(SESSION)).status).toBe(409);
    resendWelcomeEmail.mockResolvedValueOnce("not_found");
    expect((await resend(SESSION)).status).toBe(404);
    resendWelcomeEmail.mockResolvedValueOnce("use_forgot_password");
    const forgot = await resend(SESSION);
    expect(forgot.status).toBe(409);
    expect((await forgot.json()).error).toMatch(/Forgot password/);

    enforceRateLimit.mockResolvedValueOnce(null).mockResolvedValueOnce(new Response("{}", { status: 429 }));
    expect((await resend(SESSION)).status).toBe(429);
    expect((await resend("bogus")).status).toBe(404);
  });
});
