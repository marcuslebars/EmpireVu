import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A customer is charged what the quote page showed them — never a fresh re-price.
 *
 * approveQuote freezes the amounts the deposit Checkout and the balance invoice
 * use. It used to re-price from the CURRENT catalog, so a price-list change after
 * the quote was sent meant: page shows $1,000, approve, charged on $1,150.
 */

import { createFakeDb, type FakeDb } from "./fake-supabase";

const h = vi.hoisted(() => ({
  db: null as FakeDb | null,
  /** Today's price list: cents per service id. */
  prices: {} as Record<string, number>,
  tasks: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.db?.client }));
vi.mock("@/server/services/quotes/workflow-triggers", () => ({ emitQuoteTrigger: vi.fn() }));
vi.mock("@/server/services/tasks", () => ({
  createTask: async (_ctx: unknown, input: Record<string, unknown>) => {
    h.tasks.push(input);
    return { id: `task-${h.tasks.length}` };
  },
}));
vi.mock("@/server/services/quotes/pricing", () => ({
  priceQuoteForCompany: async (_companyId: string, input: { services: Array<{ serviceId: string; optional?: boolean; selected?: boolean }>; taxRateBps: number; depositRateBps: number }) => {
    const on = input.services.filter((s) => !s.optional || s.selected);
    const off = input.services.filter((s) => s.optional && !s.selected);
    const line = (s: { serviceId: string; optional?: boolean }, selected: boolean) => ({
      serviceId: s.serviceId,
      label: s.serviceId,
      description: "",
      quantity: 1,
      unitPriceCents: h.prices[s.serviceId],
      amountCents: h.prices[s.serviceId],
      bundleEligible: false,
      optional: s.optional === true,
      selected,
      custom: false,
    });
    const subtotalCents = on.reduce((t, s) => t + h.prices[s.serviceId], 0);
    const taxCents = Math.round((subtotalCents * input.taxRateBps) / 10_000);
    const totalCents = subtotalCents + taxCents;
    return {
      currency: "CAD",
      lineItems: [...on.map((s) => line(s, true)), ...off.map((s) => line(s, false))],
      bundleId: null,
      bundleSavingsCents: 0,
      subtotalCents,
      taxRateBps: input.taxRateBps,
      taxCents,
      totalCents,
      depositRateBps: input.depositRateBps,
      depositFlatCents: null,
      depositCents: Math.round((totalCents * input.depositRateBps) / 10_000),
    };
  },
}));

const { approveQuote, priceForSelection, QuotePricesChangedError } = await import("@/server/services/quotes/public-service");

const TOKEN = "c".repeat(32);

/** Sent at: wrap $800 + optional paint $200 (not ticked). 13% tax, 25% deposit. */
function seed() {
  const line = (serviceId: string, cents: number, optional: boolean, selected: boolean) => ({
    serviceId, label: serviceId, description: "", quantity: 1, unitPriceCents: cents, amountCents: cents, optional, selected, custom: false,
  });
  h.db = createFakeDb({
    companies: [{ id: "co-1", organization_id: "org-1", name: "Bayview Marine" }],
    quotes: [
      {
        id: "q1",
        organization_id: "org-1",
        company_id: "co-1",
        contact_id: "ct-1",
        public_token: TOKEN,
        quote_number: "Q-2026-0010",
        status: "viewed",
        currency: "CAD",
        line_items: [line("wrap", 80000, false, true), line("paint", 20000, true, false)],
        subtotal_cents: 80000,
        tax_cents: 10400,
        total_cents: 90400,
        deposit_cents: 22600,
        tax_rate_bps: 1300,
        deposit_rate_bps: 2500,
        deposit_flat_cents: null,
        bundle_id: null,
        input_snapshot: { services: [{ serviceId: "wrap" }, { serviceId: "paint", optional: true, selected: false }], customLines: [] },
        valid_until: "2099-01-01T00:00:00Z",
        approved_at: null,
        superseded_by: null,
      },
    ],
    quote_events: [],
  });
}

const approve = (selected: string[], expectedTotalCents?: number) =>
  approveQuote({ token: TOKEN, fullName: "Pat Smith", termsAccepted: true, selectedServiceIds: selected, expectedTotalCents });

beforeEach(() => {
  h.prices = { wrap: 80000, paint: 20000 };
  h.tasks.length = 0;
  seed();
});

describe("approving the quote as sent", () => {
  it("freezes the stored amounts exactly, even after the price list went up", async () => {
    h.prices = { wrap: 92000, paint: 23000 }; // +15% since it was sent
    const row = await approve([], 90400);
    expect(row).toMatchObject({
      status: "approved",
      approved_subtotal_cents: 80000,
      approved_total_cents: 90400,
      approved_deposit_cents: 22600,
    });
    expect((row.approved_line_items as Array<{ amountCents: number }>)[0].amountCents).toBe(80000);
    expect(h.tasks).toHaveLength(0);
  });
});

describe("approving with options toggled", () => {
  it("prices the new selection when the price list hasn't moved", async () => {
    const row = await approve(["paint"], 113000);
    expect(row).toMatchObject({ status: "approved", approved_subtotal_cents: 100000, approved_total_cents: 113000 });
  });

  it("refuses, tells the customer plainly, and tasks the owner when prices changed", async () => {
    h.prices = { wrap: 92000, paint: 23000 };
    const err = await approve(["paint"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotePricesChangedError);
    expect((err as Error).message).toBe("Prices on this quote have changed. We've let Bayview Marine know — they'll send you an updated quote.");

    // Nothing approved, nothing frozen.
    expect(h.db!.tables.quotes[0]).toMatchObject({ status: "viewed", approved_at: null });
    // The owner hears about it, once.
    expect(h.tasks).toHaveLength(1);
    expect(h.tasks[0]).toMatchObject({ companyId: "co-1", contactId: "ct-1", priority: "high" });
    await approve(["paint"]).catch(() => undefined);
    expect(h.tasks).toHaveLength(1);
    expect(h.db!.tables.quote_events.filter((e) => e.event_type === "approval_blocked_prices_changed")).toHaveLength(2);
  });

  it("refuses a total that differs from the one the page showed", async () => {
    const err = await approve(["paint"], 112999).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotePricesChangedError);
    expect(h.db!.tables.quotes[0].status).toBe("viewed");
  });
});

describe("the page's live totals match what approval would charge", () => {
  it("shows the stored total for the sent selection and a fresh one for a toggled one", async () => {
    expect(await priceForSelection(TOKEN, [])).toMatchObject({ kind: "ok", pricing: { totalCents: 90400 } });
    expect(await priceForSelection(TOKEN, ["paint"])).toMatchObject({ kind: "ok", pricing: { totalCents: 113000 } });
  });

  it("says prices changed instead of showing a toggled total nobody quoted", async () => {
    h.prices = { wrap: 92000, paint: 23000 };
    expect(await priceForSelection(TOKEN, [])).toMatchObject({ kind: "ok", pricing: { totalCents: 90400 } });
    expect(await priceForSelection(TOKEN, ["paint"])).toEqual({ kind: "prices_changed" });
  });

  it("ignores ids that aren't optional lines on this quote", async () => {
    h.prices = { wrap: 92000, paint: 23000 };
    expect(await priceForSelection(TOKEN, ["wrap", "nonsense"])).toMatchObject({ kind: "ok", pricing: { totalCents: 90400 } });
  });
});
