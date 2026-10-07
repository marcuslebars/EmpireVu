import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * No silent re-pricing.
 *
 * Editing a quote re-prices every line from the company's CURRENT price list. On a
 * quote the customer already has (sent / viewed), a changed total must not be saved
 * without the owner seeing both numbers and confirming. And "Make a new version"
 * (reissueQuote) must keep the tax and deposit terms the customer was quoted under.
 */

import { createFakeDb, fakeTenantContext, type FakeDb } from "./fake-supabase";

const h = vi.hoisted(() => ({
  priceCalls: [] as Array<Record<string, unknown>>,
  /** What the price list says today: the subtotal every pricing call returns. */
  subtotalCents: 50000,
}));

vi.mock("@/server/services/quotes/pricing", () => ({
  priceQuoteForCompany: async (_companyId: string, input: Record<string, unknown>) => {
    h.priceCalls.push(input);
    const taxRateBps = (input.taxRateBps as number | undefined) ?? 1300;
    const depositRateBps = (input.depositRateBps as number | undefined) ?? 2500;
    const subtotalCents = h.subtotalCents;
    const taxCents = Math.round((subtotalCents * taxRateBps) / 10_000);
    const totalCents = subtotalCents + taxCents;
    const flat = typeof input.depositFlatCents === "number" ? input.depositFlatCents : null;
    return {
      currency: "CAD",
      lineItems: [{ serviceId: "wrap", label: "Shrink wrap", description: "", quantity: 1, unitPriceCents: subtotalCents, amountCents: subtotalCents, bundleEligible: false, optional: false, selected: true, custom: false }],
      bundleId: null,
      bundleSavingsCents: 0,
      subtotalCents,
      taxRateBps,
      taxCents,
      totalCents,
      depositRateBps,
      depositFlatCents: flat,
      depositCents: flat ?? Math.round((totalCents * depositRateBps) / 10_000),
    };
  },
}));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({ emitActivityEventAndDispatch: vi.fn() }));
vi.mock("@/server/services/quotes/notify", () => ({ sendQuoteEmail: vi.fn(), sendQuoteReplacedEmail: vi.fn() }));

const { QuoteTotalChangedError, reissueQuote, updateQuote } = await import("@/server/services/quotes/service");
const { handleRoute } = await import("@/server/api/route");

const ORG = "org-1";
const services = [{ serviceId: "wrap", lengthFt: 24 }];

function quoteRow(over: Record<string, unknown> = {}) {
  return {
    id: "q1",
    organization_id: ORG,
    company_id: "co-1",
    contact_id: "ct-1",
    public_token: "a".repeat(32),
    quote_number: "Q-2026-0007",
    status: "sent",
    currency: "CAD",
    title: "Winter wrap",
    intro_message: null,
    line_items: [],
    subtotal_cents: 50000,
    tax_cents: 6500,
    total_cents: 56500,
    deposit_cents: 14125,
    // Issued under a 5% tax rate and a 50% deposit — NOT today's defaults.
    tax_rate_bps: 500,
    deposit_rate_bps: 5000,
    deposit_flat_cents: null,
    bundle_id: null,
    input_snapshot: { services, customLines: [], hullType: "sail", bundleId: null },
    notes: null,
    source: null,
    expires_at: null,
    valid_until: null,
    sent_at: "2026-10-01T00:00:00Z",
    first_viewed_at: null,
    auto_generated: false,
    source_lead_id: null,
    supersedes: null,
    superseded_by: null,
    cancelled_at: null,
    cancel_reason: null,
    created_by: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...over,
  };
}

let db: FakeDb;
beforeEach(() => {
  h.priceCalls.length = 0;
  h.subtotalCents = 50000;
  db = createFakeDb({
    companies: [{ id: "co-1", organization_id: ORG }],
    contacts: [{ id: "ct-1", organization_id: ORG }],
    quotes: [],
    quote_events: [],
  });
});

const ctx = () => fakeTenantContext(db, ORG, "user-1");

describe("editing a quote the customer already has", () => {
  it("refuses to save a changed total without confirmation, and changes nothing", async () => {
    // The price list went up since the quote was sent.
    db.tables.quotes.push(quoteRow({ tax_rate_bps: 1300, tax_cents: 6500, total_cents: 56500 }));
    h.subtotalCents = 54000;

    const err = await updateQuote(ctx(), "q1", { services }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuoteTotalChangedError);
    expect(err).toMatchObject({ oldTotalCents: 56500, newTotalCents: 54000 + 7020 });

    const row = db.tables.quotes[0];
    expect(row.total_cents).toBe(56500);
    expect(db.ops.some((o) => o.table === "quotes" && o.op === "update")).toBe(false);
  });

  it("answers 409 total_changed with both totals through the route handler", async () => {
    db.tables.quotes.push(quoteRow({ tax_rate_bps: 1300 }));
    h.subtotalCents = 54000;
    const res = await handleRoute(async () => {
      await updateQuote(ctx(), "q1", { services });
      throw new Error("unreachable");
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "total_changed", oldTotalCents: 56500, newTotalCents: 61020 });
  });

  it("saves the new total once the owner confirms", async () => {
    db.tables.quotes.push(quoteRow({ tax_rate_bps: 1300 }));
    h.subtotalCents = 54000;
    const saved = await updateQuote(ctx(), "q1", { services, confirmTotalChange: true });
    expect(saved.total_cents).toBe(61020);
    expect(db.tables.quotes[0].total_cents).toBe(61020);
  });

  it("saves without asking when the total is unchanged", async () => {
    db.tables.quotes.push(quoteRow({ tax_rate_bps: 1300, status: "viewed" }));
    const saved = await updateQuote(ctx(), "q1", { services, title: "Winter wrap (24 ft)" });
    expect(saved.title).toBe("Winter wrap (24 ft)");
  });

  it("keeps the tax and deposit rates the quote was issued under", async () => {
    db.tables.quotes.push(quoteRow());
    await updateQuote(ctx(), "q1", { services, confirmTotalChange: true });
    expect(h.priceCalls[0]).toMatchObject({ taxRateBps: 500, depositRateBps: 5000, depositFlatCents: null });
  });
});

describe("editing a draft", () => {
  it("saves a changed total without confirmation — the customer hasn't seen it", async () => {
    db.tables.quotes.push(quoteRow({ status: "draft", quote_number: null, sent_at: null, tax_rate_bps: 1300 }));
    h.subtotalCents = 54000;
    const saved = await updateQuote(ctx(), "q1", { services });
    expect(saved.total_cents).toBe(61020);
  });
});

describe("Make a new version (reissueQuote)", () => {
  it("carries over the original quote's tax rate and deposit terms", async () => {
    db.tables.quotes.push(quoteRow({ deposit_flat_cents: 20000 }));
    await reissueQuote(ctx(), "q1", { reason: "Added bottom paint" });

    expect(h.priceCalls).toHaveLength(1);
    expect(h.priceCalls[0]).toMatchObject({ taxRateBps: 500, depositRateBps: 5000, depositFlatCents: 20000 });

    const successor = db.tables.quotes.find((q) => q.id !== "q1");
    expect(successor).toMatchObject({ status: "draft", tax_rate_bps: 500, deposit_rate_bps: 5000, deposit_flat_cents: 20000, supersedes: "q1" });
    expect(db.tables.quotes.find((q) => q.id === "q1")).toMatchObject({ status: "cancelled", superseded_by: successor?.id });
  });

  it("explains an already-void quote without exposing its id", async () => {
    db.tables.quotes.push(quoteRow({ status: "cancelled" }));
    const err = (await reissueQuote(ctx(), "q1").catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("This quote is already void.");
    expect(err.message).not.toContain("q1");
  });
});
