import { describe, expect, it } from "vitest";

import {
  addDays,
  agingBucket,
  balanceDueCents,
  computeInvoiceTotals,
  daysBetween,
  dueReminderIndex,
  isOverdue,
  lineAmountCents,
  quoteToInvoiceDraft,
  taxCentsFor,
  type QuoteForInvoice,
} from "@/server/services/invoices/math";
import { roundHalfUpDiv } from "@/server/services/quotes/pricing";

describe("invoice line + totals maths", () => {
  it("rounds each line to the cent once, and the lines add up to the subtotal", () => {
    const t = computeInvoiceTotals(
      [
        { label: "Detailing", quantity: 1.5, unitPriceCents: 8999 }, // 134.985 → 134.99
        { label: "Shrink wrap", quantity: 1, unitPriceCents: 52000 },
        { label: "Discount", quantity: 1, unitPriceCents: -2000 },
      ],
      1300,
    );
    expect(t.lineItems.map((l) => l.amountCents)).toEqual([13499, 52000, -2000]);
    expect(t.subtotalCents).toBe(63499);
    expect(t.taxCents).toBe(8255); // 63499 × 13% = 8254.87
    expect(t.totalCents).toBe(71754);
  });

  it("computes tax exactly like the quote engine, so a converted quote totals the same", () => {
    for (const subtotal of [1, 99, 5000, 61234, 123457, 99999999]) {
      expect(taxCentsFor(subtotal, 1300)).toBe(roundHalfUpDiv(subtotal * 1300, 10_000));
    }
  });

  it("never charges tax on a zero or negative subtotal, or at a 0% rate", () => {
    expect(taxCentsFor(0, 1300)).toBe(0);
    expect(taxCentsFor(-500, 1300)).toBe(0);
    expect(taxCentsFor(10000, 0)).toBe(0);
  });

  it("rounds discount lines symmetrically", () => {
    expect(lineAmountCents(1.5, -333)).toBe(-500); // -499.5 → -500
    expect(lineAmountCents(1.5, 333)).toBe(500);
  });

  it("ignores quantity precision beyond two decimals", () => {
    expect(lineAmountCents(1.005, 10000)).toBe(10000);
  });

  it("balance never goes negative", () => {
    expect(balanceDueCents(10000, 2500, 3000)).toBe(4500);
    expect(balanceDueCents(10000, 2500, 9000)).toBe(0);
  });
});

describe("dates, overdue and aging", () => {
  it("adds calendar days across month and year ends", () => {
    expect(addDays("2026-10-02", 30)).toBe("2026-11-01");
    expect(addDays("2026-12-15", 30)).toBe("2027-01-14");
    expect(addDays("2026-10-02", 0)).toBe("2026-10-02");
    expect(daysBetween("2026-10-01", "2026-10-31")).toBe(30);
  });

  it("is overdue only when open, owing, and the due date has passed", () => {
    const base = { status: "sent", due_date: "2026-10-01", balance_due_cents: 500 };
    expect(isOverdue(base, "2026-10-01")).toBe(false); // due today is not late
    expect(isOverdue(base, "2026-10-02")).toBe(true);
    expect(isOverdue({ ...base, status: "paid" }, "2026-12-01")).toBe(false);
    expect(isOverdue({ ...base, status: "draft" }, "2026-12-01")).toBe(false);
    expect(isOverdue({ ...base, balance_due_cents: 0 }, "2026-12-01")).toBe(false);
    expect(isOverdue({ ...base, due_date: null }, "2026-12-01")).toBe(false);
  });

  it("buckets aging the standard way", () => {
    expect(agingBucket("2026-10-10", "2026-10-10")).toBe("current");
    expect(agingBucket("2026-10-10", "2026-10-11")).toBe("1_30");
    expect(agingBucket("2026-10-10", "2026-11-09")).toBe("1_30");
    expect(agingBucket("2026-10-10", "2026-11-10")).toBe("31_60");
    expect(agingBucket("2026-10-10", "2027-01-08")).toBe("61_90");
    expect(agingBucket("2026-10-10", "2027-01-09")).toBe("over_90");
  });
});

describe("reminder schedule", () => {
  const days = [1, 7, 14];
  it("sends the next reminder only once its day is reached", () => {
    expect(dueReminderIndex(0, days, 0)).toBeNull();
    expect(dueReminderIndex(1, days, 0)).toBe(0);
    expect(dueReminderIndex(6, days, 1)).toBeNull();
    expect(dueReminderIndex(7, days, 1)).toBe(1);
    expect(dueReminderIndex(30, days, 3)).toBeNull(); // all sent
  });

  it("catches up ONE reminder at a time, never a burst", () => {
    // 20 days late when reminders were switched on: today sends #1 only.
    expect(dueReminderIndex(20, days, 0)).toBe(0);
  });
});

describe("quote → invoice conversion", () => {
  const quote: QuoteForInvoice = {
    title: "Winter storage",
    quote_number: "Q-2026-0042",
    line_items: [],
    approved_line_items: [
      { label: "Outdoor storage", description: "24 ft", quantity: 1, unitPriceCents: 60000, amountCents: 60000, optional: false, selected: true },
      { label: "Shrink wrap", description: "Shrink wrap", quantity: 1, unitPriceCents: 52000, amountCents: 52000, optional: false, selected: true },
      { label: "Battery storage", description: "", quantity: 2, unitPriceCents: 2500, amountCents: 5000, optional: true, selected: true },
      { label: "Bottom paint", description: "", quantity: 1, unitPriceCents: 40000, amountCents: 40000, optional: true, selected: false },
    ],
    subtotal_cents: 0,
    approved_subtotal_cents: 107000, // bundle saved $100
    tax_rate_bps: 1300,
    approved_deposit_cents: 25000,
    deposit_paid_at: "2026-09-01T12:00:00Z",
  };

  it("invoices exactly the approved selection, with the bundle saving as a discount line", () => {
    const d = quoteToInvoiceDraft(quote);
    expect(d.lines.map((l) => l.label)).toEqual(["Outdoor storage", "Shrink wrap", "Battery storage", "Bundle discount"]);
    expect(d.lines[3].unitPriceCents).toBe(-10000);
    const totals = computeInvoiceTotals(d.lines, d.taxRateBps);
    expect(totals.subtotalCents).toBe(107000);
    expect(totals.totalCents).toBe(107000 + roundHalfUpDiv(107000 * 1300, 10_000));
  });

  it("credits the deposit only when it was actually paid", () => {
    expect(quoteToInvoiceDraft(quote).creditCents).toBe(25000);
    expect(quoteToInvoiceDraft({ ...quote, deposit_paid_at: null }).creditCents).toBe(0);
  });

  it("drops duplicate descriptions and names the quote in the title", () => {
    const d = quoteToInvoiceDraft(quote);
    expect(d.lines[1].description).toBeNull(); // "Shrink wrap" == label
    expect(d.title).toBe("Winter storage (Q-2026-0042)");
  });

  it("falls back to the live selection for an unapproved quote", () => {
    const d = quoteToInvoiceDraft({
      ...quote,
      approved_line_items: null,
      approved_subtotal_cents: null,
      line_items: quote.approved_line_items,
      subtotal_cents: 117000,
      deposit_paid_at: null,
    });
    expect(d.lines.map((l) => l.label)).toEqual(["Outdoor storage", "Shrink wrap", "Battery storage"]);
    expect(d.creditCents).toBe(0);
  });

  it("invoices a whole-priced engine line as one line of its amount", () => {
    const d = quoteToInvoiceDraft({
      ...quote,
      approved_line_items: [{ label: "Winterization", quantity: 2, unitPriceCents: 10000, amountCents: 25000 }],
      approved_subtotal_cents: 25000,
    });
    expect(d.lines).toEqual([{ label: "Winterization", description: null, quantity: 1, unitPriceCents: 25000 }]);
  });
});
