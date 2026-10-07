import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Money-safety rules for invoicing and online payment:
 *   (a) only a quote the CUSTOMER APPROVED can become an invoice;
 *   (d) bank debit is offered only when Stripe has approved the brand's account for
 *       it, and a Stripe refusal of a debit falls back to a friendly message.
 */

import { createFakeDb, fakeTenantContext, type FakeDb } from "./fake-supabase";

const h = vi.hoisted(() => ({
  db: null as FakeDb | null,
  createSession: vi.fn(),
  createCustomer: vi.fn(),
}));

vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.db?.client }));
vi.mock("@/server/services/quotes/company-stripe", () => ({
  getCompanyStripeConfig: vi.fn(),
  getPlatformStripe: () => ({
    checkout: { sessions: { create: (...a: unknown[]) => h.createSession(...a), retrieve: vi.fn(), expire: vi.fn() } },
    customers: { create: (...a: unknown[]) => h.createCustomer(...a) },
  }),
  onAccount: () => ({ stripeAccount: "acct_brand" }),
  requireChargeableCompany: async () => ({ accountId: "acct_brand", statementDescriptorSuffix: null }),
  CompanyStripeError: class CompanyStripeError extends Error {},
}));
vi.mock("@/server/services/rate-limit", () => ({ enforceRateLimit: async () => null }));

const { createInvoiceFromBooking, createInvoiceFromQuote, isQuoteApprovedForInvoicing, QUOTE_NOT_APPROVED_MESSAGE } = await import(
  "@/server/services/invoices/service"
);
const { InvoiceConflictError } = await import("@/server/services/invoices/errors");
const { BANK_DEBIT_UNAVAILABLE_MESSAGE, createInvoiceCheckout } = await import("@/server/services/invoices/public");
const { syncConnectedAccountState } = await import("@/server/services/quotes/connect");
const payRoute = await import("@/app/api/public/invoices/[token]/pay/route");

const ORG = "org-1";
const TOKEN = "b".repeat(32);

function company(over: Record<string, unknown> = {}) {
  return {
    id: "co-1",
    organization_id: ORG,
    name: "Bayview Plumbing",
    timezone: "America/Toronto",
    brand_logo_url: null,
    brand_primary_color: null,
    brand_accent_color: null,
    brand_from_name: null,
    brand_reply_email: null,
    brand_reply_phone: null,
    brand_website_url: null,
    tax_registration_number: null,
    business_address: null,
    invoice_settings: { acceptCard: true, acceptBankDebit: true },
    quote_public_base_url: "https://pay.bayview.test",
    stripe_connected_account_id: "acct_brand",
    stripe_charges_enabled: true,
    stripe_acss_debit_enabled: true,
    ...over,
  };
}

function quote(over: Record<string, unknown> = {}) {
  return {
    id: "q1",
    organization_id: ORG,
    company_id: "co-1",
    contact_id: "ct-1",
    status: "sent",
    title: "Water heater",
    quote_number: "Q-2026-0003",
    line_items: [{ label: "Water heater", quantity: 1, unitPriceCents: 150000, amountCents: 150000 }],
    approved_line_items: null,
    approved_subtotal_cents: null,
    approved_at: null,
    approved_deposit_cents: null,
    deposit_paid_at: null,
    tax_rate_bps: 1300,
    ...over,
  };
}

function invoice(over: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    organization_id: ORG,
    company_id: "co-1",
    contact_id: "ct-1",
    customer_account_id: null,
    public_token: TOKEN,
    invoice_number: "INV-0009",
    title: "Water heater",
    status: "sent",
    currency: "CAD",
    issue_date: "2026-10-01",
    due_date: "2026-10-01",
    payment_terms_days: 0,
    bill_to: { name: "Pat" },
    line_items: [],
    subtotal_cents: 150000,
    tax_rate_bps: 1300,
    tax_cents: 19500,
    total_cents: 169500,
    credit_cents: 0,
    amount_paid_cents: 0,
    pending_payment_cents: 0,
    balance_due_cents: 169500,
    notes: null,
    paid_at: null,
    first_viewed_at: "2026-10-01T12:00:00Z",
    stripe_checkout_session_id: null,
    ...over,
  };
}

beforeEach(() => {
  h.createSession.mockReset();
  h.createCustomer.mockReset();
  h.createCustomer.mockResolvedValue({ id: "cus_1" });
  h.db = createFakeDb({
    companies: [company()],
    contacts: [{ id: "ct-1", organization_id: ORG }],
    quotes: [],
    invoices: [],
    bookings: [],
    invoice_events: [],
    company_stripe_customers: [],
  });
});

const ctx = () => fakeTenantContext(h.db as FakeDb, ORG, "user-1");

// ── (a) approved-only invoicing ──────────────────────────────────────────────

describe("only an approved quote can be invoiced", () => {
  it.each(["draft", "sent", "viewed"])("refuses a %s quote with a plain-English reason", async (status) => {
    h.db!.tables.quotes.push(quote({ status }));
    const err = await createInvoiceFromQuote(ctx(), "q1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceConflictError);
    expect((err as Error).message).toBe(QUOTE_NOT_APPROVED_MESSAGE);
    expect((err as InstanceType<typeof InvoiceConflictError>).code).toBe("quote_not_approved");
    // Nothing was written.
    expect(h.db!.tables.invoices).toHaveLength(0);
  });

  it("refuses a void or expired quote", async () => {
    h.db!.tables.quotes.push(quote({ status: "cancelled" }));
    const err = (await createInvoiceFromQuote(ctx(), "q1").catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/void/);
    expect(err.message).not.toContain("cancelled");
  });

  it("does not trust a status that has no approval snapshot behind it", () => {
    expect(isQuoteApprovedForInvoicing({ status: "approved", approved_at: null, approved_line_items: null })).toBe(false);
    expect(isQuoteApprovedForInvoicing({ status: "approved", approved_at: "2026-10-01T00:00:00Z", approved_line_items: [] })).toBe(false);
    expect(isQuoteApprovedForInvoicing({ status: "sent", approved_at: null, approved_line_items: [{ label: "x" }] })).toBe(false);
  });

  it.each(["approved", "deposit_paid", "completed"])("accepts a %s quote with its approval snapshot", (status) => {
    expect(isQuoteApprovedForInvoicing({ status, approved_at: "2026-10-01T00:00:00Z", approved_line_items: [{ label: "Water heater" }] })).toBe(true);
  });

  it("invoices a job whose quote was never approved as an unpriced draft, not from the quote's live prices", async () => {
    h.db!.tables.quotes.push(quote({ status: "sent" }));
    h.db!.tables.bookings.push({ id: "b1", organization_id: ORG, company_id: "co-1", contact_id: "ct-1", quote_id: "q1", title: "Install water heater", description: null, recurring_job_id: null, price_cents: null, deposit_cents: null, deposit_paid_at: null });
    // The rest of createInvoice needs tables this fake doesn't model fully; we only
    // care what it was ASKED to bill.
    const seen: unknown[] = [];
    const client = h.db!.client as { from(t: string): unknown };
    const original = client.from.bind(client);
    client.from = (t: string) => {
      const b = original(t) as Record<string, unknown>;
      if (t === "invoices") {
        const insert = b.insert as (v: unknown) => unknown;
        b.insert = (v: unknown) => {
          seen.push(v);
          return insert(v);
        };
      }
      return b;
    };
    await createInvoiceFromBooking(ctx(), "b1").catch(() => undefined);
    expect(seen).toHaveLength(1);
    const lines = (seen[0] as { line_items: Array<{ label: string; unitPriceCents: number }> }).line_items;
    expect(lines).toEqual([expect.objectContaining({ label: "Install water heater", unitPriceCents: 0 })]);
    expect((seen[0] as { quote_id: unknown }).quote_id).toBeNull();
  });
});

// ── (d) bank debit gating + fallback ─────────────────────────────────────────

describe("bank debit at checkout", () => {
  it("is refused up front, with the friendly message, when Stripe hasn't enabled it", async () => {
    h.db!.tables.companies[0].stripe_acss_debit_enabled = false;
    h.db!.tables.invoices.push(invoice());
    await expect(createInvoiceCheckout(TOKEN, "bank_debit")).rejects.toMatchObject({
      message: BANK_DEBIT_UNAVAILABLE_MESSAGE,
      code: "method_unavailable",
    });
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it("falls back to the friendly message when Stripe still refuses the debit", async () => {
    h.db!.tables.invoices.push(invoice());
    h.createSession.mockRejectedValue(
      Object.assign(new Error("The payment method type acss_debit is invalid for account acct_brand."), { type: "StripeInvalidRequestError" }),
    );
    await expect(createInvoiceCheckout(TOKEN, "bank_debit")).rejects.toMatchObject({ message: BANK_DEBIT_UNAVAILABLE_MESSAGE });
  });

  it("answers the pay page with a 409 and the friendly message, never a raw 500", async () => {
    h.db!.tables.invoices.push(invoice());
    h.createSession.mockRejectedValue(Object.assign(new Error("acss_debit is not activated"), { type: "StripeInvalidRequestError" }));
    const res = await payRoute.POST(
      new Request(`https://pay.bayview.test/api/public/invoices/${TOKEN}/pay`, { method: "POST", body: JSON.stringify({ method: "bank_debit" }) }),
      { params: { token: TOKEN } },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe(BANK_DEBIT_UNAVAILABLE_MESSAGE);
    expect(JSON.stringify(body)).not.toContain("acss_debit");
  });

  it("still lets a card payment through when bank debit isn't enabled", async () => {
    h.db!.tables.companies[0].stripe_acss_debit_enabled = false;
    h.db!.tables.invoices.push(invoice());
    h.createSession.mockResolvedValue({ id: "cs_1", status: "open", url: "https://checkout.stripe.test/cs_1" });
    await expect(createInvoiceCheckout(TOKEN, "card")).resolves.toEqual({ url: "https://checkout.stripe.test/cs_1" });
  });

  it("masks an unexpected card-side Stripe error as a generic 500 with an error id", async () => {
    h.db!.tables.invoices.push(invoice());
    h.createSession.mockRejectedValue(Object.assign(new Error("Invalid API Key provided: sk_live_****"), { type: "StripeAuthenticationError" }));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await payRoute.POST(
      new Request(`https://pay.bayview.test/api/public/invoices/${TOKEN}/pay`, { method: "POST", body: JSON.stringify({ method: "card" }) }),
      { params: { token: TOKEN } },
    );
    spy.mockRestore();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.errorId).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("sk_live");
  });
});

describe("the ACSS capability is mirrored from Stripe", () => {
  const account = (capabilities: Record<string, string> | undefined) =>
    ({ id: "acct_brand", charges_enabled: true, payouts_enabled: true, details_submitted: true, requirements: null, capabilities }) as never;

  it("sets stripe_acss_debit_enabled only when acss_debit_payments is active", async () => {
    await syncConnectedAccountState(account({ card_payments: "active", acss_debit_payments: "pending" }));
    expect(h.db!.tables.companies[0].stripe_acss_debit_enabled).toBe(false);

    await syncConnectedAccountState(account({ card_payments: "active", acss_debit_payments: "active" }));
    expect(h.db!.tables.companies[0].stripe_acss_debit_enabled).toBe(true);

    await syncConnectedAccountState(account({ card_payments: "active" }));
    expect(h.db!.tables.companies[0].stripe_acss_debit_enabled).toBe(false);

    await syncConnectedAccountState(account(undefined));
    expect(h.db!.tables.companies[0].stripe_acss_debit_enabled).toBe(false);
  });
});
