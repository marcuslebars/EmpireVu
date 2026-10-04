import { describe, expect, it } from "vitest";

import { ValidationError } from "@/server/organizations/context";
import { getBusinessOverview, validateRange } from "@/server/services/reports/overview";
import {
  bucketFor,
  bucketKeys,
  buildPeriod,
  computeOverview,
  emptyOverviewInputs,
  isYmd,
  localMidnightUtc,
  previousRange,
} from "@/server/services/reports/overview-logic";
import { createFakeDb, fakeTenantContext } from "./fake-supabase";

const TZ = "America/Toronto";
const ORG = "org-1";
const CO = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("period rules", () => {
  it("validates calendar dates", () => {
    expect(isYmd("2026-10-01")).toBe(true);
    expect(isYmd("2026-02-30")).toBe(false);
    expect(isYmd("2026-1-1")).toBe(false);
    expect(isYmd(null)).toBe(false);
  });

  it("local midnight is DST-safe", () => {
    expect(localMidnightUtc("2026-10-01", TZ)).toBe("2026-10-01T04:00:00.000Z"); // EDT
    expect(localMidnightUtc("2026-12-01", TZ)).toBe("2026-12-01T05:00:00.000Z"); // EST
    expect(localMidnightUtc("2026-11-01", TZ)).toBe("2026-11-01T04:00:00.000Z"); // fall-back day starts in EDT
    expect(localMidnightUtc("2026-03-08", TZ)).toBe("2026-03-08T05:00:00.000Z"); // spring-forward day starts in EST
  });

  it("compares a month (or month to date) with the same span of the month before", () => {
    expect(previousRange("2026-10-01", "2026-11-01")).toEqual({ prevFromDate: "2026-09-01", prevToDate: "2026-10-01" });
    expect(previousRange("2026-10-01", "2026-10-05")).toEqual({ prevFromDate: "2026-09-01", prevToDate: "2026-09-05" });
    // 31st clamps to the end of a shorter month.
    expect(previousRange("2026-03-01", "2026-03-31")).toEqual({ prevFromDate: "2026-02-01", prevToDate: "2026-02-28" });
  });

  it("compares a quarter with the quarter before, and year-to-date with last year", () => {
    expect(previousRange("2026-07-01", "2026-10-01")).toEqual({ prevFromDate: "2026-04-01", prevToDate: "2026-07-01" });
    expect(previousRange("2026-01-01", "2026-10-05")).toEqual({ prevFromDate: "2025-01-01", prevToDate: "2025-10-05" });
    // A January month is still "the month before".
    expect(previousRange("2026-01-01", "2026-02-01")).toEqual({ prevFromDate: "2025-12-01", prevToDate: "2026-01-01" });
  });

  it("compares any other range with the same number of days just before", () => {
    expect(previousRange("2026-09-05", "2026-10-05")).toEqual({ prevFromDate: "2026-08-06", prevToDate: "2026-09-05" });
  });

  it("picks day / week / month buckets by length and covers the range", () => {
    expect(bucketFor(31)).toBe("day");
    expect(bucketFor(90)).toBe("week");
    expect(bucketFor(365)).toBe("month");
    expect(bucketKeys("2026-10-01", "2026-10-04", "day")).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(bucketKeys("2026-10-01", "2026-10-15", "week")).toEqual(["2026-09-28", "2026-10-05", "2026-10-12"]);
    expect(bucketKeys("2026-01-01", "2026-04-01", "month")).toEqual(["2026-01", "2026-02", "2026-03"]);
  });

  it("rejects bad ranges", () => {
    expect(() => validateRange("2026-10-05", "2026-10-05")).toThrow(ValidationError);
    expect(() => validateRange("2026-10-05", "2026-10-01")).toThrow(ValidationError);
    expect(() => validateRange("2024-01-01", "2026-10-01")).toThrow(ValidationError);
    expect(() => validateRange("yesterday", "2026-10-01")).toThrow(ValidationError);
    expect(() => validateRange("2026-01-01", "2027-01-01")).not.toThrow();
  });
});

describe("computeOverview", () => {
  const period = buildPeriod("2026-10-01", "2026-11-01", TZ); // prev = September
  const now = new Date("2026-10-20T16:00:00Z");

  it("collects payments and deposits, by period, by method and by bucket", () => {
    const inputs = {
      ...emptyOverviewInputs(),
      payments: [
        { invoiceId: "i1", amountCents: 50_000, method: "card", receivedAt: "2026-10-02T15:00:00Z", currency: "CAD" },
        { invoiceId: "i2", amountCents: 20_000, method: "etransfer", receivedAt: "2026-10-02T23:30:00Z", currency: "CAD" },
        // 11:30pm Toronto on Sep 30 is still September.
        { invoiceId: "i3", amountCents: 9_999, method: "card", receivedAt: "2026-10-01T03:30:00Z", currency: "CAD" },
      ],
      deposits: [{ contactId: "c2", cents: 10_000, paidAt: "2026-10-03T12:00:00Z", currency: "CAD" }],
      invoiceContacts: { i1: "c1", i2: "c1", i3: "c3" },
      contactNames: { c1: "Pat Smith", c2: "Sam Lee" },
    };
    const r = computeOverview(inputs, period, now);
    expect(r.money.collected).toEqual({ value: 80_000, previous: 9_999 });
    expect(r.money.depositsCents).toBe(10_000);
    expect(r.money.byMethod).toEqual([
      { method: "card", cents: 50_000, count: 1 },
      { method: "etransfer", cents: 20_000, count: 1 },
      { method: "deposit", cents: 10_000, count: 1 },
    ]);
    expect(r.series).toHaveLength(31);
    expect(r.series.find((s) => s.key === "2026-10-02")?.collectedCents).toBe(70_000);
    expect(r.series.find((s) => s.key === "2026-10-03")?.collectedCents).toBe(10_000);
    expect(r.topCustomers.map((c) => [c.name, c.collectedCents])).toEqual([
      ["Pat Smith", 70_000],
      ["Sam Lee", 10_000],
    ]);
    expect(r.customers.payingCustomers).toBe(2);
  });

  it("ages receivables from today and counts money in transit", () => {
    const r = computeOverview(
      {
        ...emptyOverviewInputs(),
        open: [
          { balanceCents: 1_000, pendingCents: 0, dueDate: "2026-10-25", currency: "CAD" },
          { balanceCents: 2_000, pendingCents: 0, dueDate: null, currency: "CAD" },
          { balanceCents: 3_000, pendingCents: 3_000, dueDate: "2026-10-10", currency: "CAD" },
          { balanceCents: 4_000, pendingCents: 0, dueDate: "2026-08-01", currency: "CAD" },
          { balanceCents: 5_000, pendingCents: 0, dueDate: "2026-06-01", currency: "CAD" },
        ],
      },
      period,
      now,
    );
    expect(r.receivables.outstandingCents).toBe(15_000);
    expect(r.receivables.overdueCents).toBe(12_000);
    expect(r.receivables.overdueInvoices).toBe(3);
    expect(r.receivables.inTransitCents).toBe(3_000);
    expect(Object.fromEntries(r.receivables.aging.map((a) => [a.key, a.cents]))).toEqual({
      current: 3_000,
      "1_30": 3_000,
      "31_60": 0,
      "61_90": 4_000,
      "90_plus": 5_000,
    });
  });

  it("counts jobs by status and quotes by sent/won/approved", () => {
    const r = computeOverview(
      {
        ...emptyOverviewInputs(),
        bookings: [
          { scheduledFor: "2026-10-05T14:00:00Z", status: "completed", contactId: "c1" },
          { scheduledFor: "2026-10-06T14:00:00Z", status: "no_show", contactId: null },
          { scheduledFor: "2026-10-07T14:00:00Z", status: "cancelled", contactId: null },
          { scheduledFor: "2026-10-28T14:00:00Z", status: "confirmed", contactId: null },
          { scheduledFor: "2026-09-10T14:00:00Z", status: "completed", contactId: null },
        ],
        quotes: [
          { sentAt: "2026-10-02T12:00:00Z", approvedAt: "2026-10-04T12:00:00Z", status: "approved", supersededBy: null, approvedTotalCents: 90_000, totalCents: 100_000 },
          { sentAt: "2026-10-03T12:00:00Z", approvedAt: null, status: "viewed", supersededBy: null, approvedTotalCents: null, totalCents: 5_000 },
          { sentAt: "2026-10-03T12:00:00Z", approvedAt: null, status: "sent", supersededBy: "q9", approvedTotalCents: null, totalCents: 5_000 },
          { sentAt: "2026-10-08T12:00:00Z", approvedAt: null, status: "expired", supersededBy: null, approvedTotalCents: null, totalCents: 7_000 },
          // Sent in September, approved in October: September's win, October's approved value.
          { sentAt: "2026-09-20T12:00:00Z", approvedAt: "2026-10-01T12:00:00Z", status: "deposit_paid", supersededBy: null, approvedTotalCents: null, totalCents: 40_000 },
        ],
      },
      period,
      now,
    );
    expect(r.jobs).toEqual({ completed: { value: 1, previous: 1 }, scheduled: 3, upcoming: 1, cancelled: 1, noShow: 1 });
    expect(r.quotes.sent).toEqual({ value: 3, previous: 1 });
    expect(r.quotes.won).toBe(1);
    expect(r.quotes.stillOpen).toBe(1);
    expect(r.quotes.winRate).toBeCloseTo(1 / 3);
    expect(r.quotes.previousWinRate).toBe(1);
    expect(r.quotes.approvedCents).toEqual({ value: 130_000, previous: 0 });
    expect(r.quotes.approvedCount).toBe(2);
  });

  it("totals crew hours and labour cost, listing people with no rate instead of costing them at $0", () => {
    const r = computeOverview(
      {
        ...emptyOverviewInputs(),
        timeEntries: [
          { profileId: "p1", bookingId: "b1", startedAt: "2026-10-05T12:00:00Z", endedAt: "2026-10-05T16:30:00Z", breakMinutes: 30 },
          { profileId: "p1", bookingId: "b2", startedAt: "2026-10-06T12:00:00Z", endedAt: "2026-10-06T14:00:00Z", breakMinutes: 0 },
          { profileId: "p2", bookingId: null, startedAt: "2026-10-06T12:00:00Z", endedAt: "2026-10-06T13:00:00Z", breakMinutes: 0 },
          { profileId: "p2", bookingId: null, startedAt: "2026-09-06T12:00:00Z", endedAt: "2026-09-06T13:00:00Z", breakMinutes: 0 },
        ],
        rates: { p1: 3_000, p2: null },
        people: { p1: "Dana", p2: "Lee" },
      },
      period,
      now,
    );
    expect(r.crew.minutes).toEqual({ value: 420, previous: 60 });
    expect(r.crew.people).toEqual([
      { profileId: "p1", name: "Dana", minutes: 360, jobs: 2, costCents: 18_000 },
      { profileId: "p2", name: "Lee", minutes: 60, jobs: 0, costCents: null },
    ]);
    expect(r.crew.labourCostCents).toBe(18_000);
    expect(r.crew.missingRateNames).toEqual(["Lee"]);
  });

  it("is all zeros (and no rates) for an empty business", () => {
    const r = computeOverview(emptyOverviewInputs(), period, now);
    expect(r.money.collected).toEqual({ value: 0, previous: 0 });
    expect(r.money.averageInvoiceCents).toBeNull();
    expect(r.quotes.winRate).toBeNull();
    expect(r.crew.labourCostCents).toBeNull();
    expect(r.currency).toBe("CAD");
  });
});

describe("getBusinessOverview (reads)", () => {
  function seed() {
    return createFakeDb({
      companies: [{ id: CO, organization_id: ORG, timezone: TZ }],
      invoice_payments: [
        { id: "p1", organization_id: ORG, company_id: CO, invoice_id: "i1", amount_cents: 10_000, method: "card", status: "succeeded", received_at: "2026-10-02T15:00:00Z" },
        { id: "p2", organization_id: ORG, company_id: CO, invoice_id: "i1", amount_cents: 5_000, method: "card", status: "refunded", received_at: "2026-10-02T16:00:00Z" },
        { id: "p3", organization_id: ORG, company_id: CO, invoice_id: "i1", amount_cents: 7_000, method: "bank_debit", status: "pending", received_at: "2026-10-02T16:00:00Z" },
        { id: "p4", organization_id: ORG, company_id: OTHER, invoice_id: "i9", amount_cents: 99_000, method: "card", status: "succeeded", received_at: "2026-10-02T16:00:00Z" },
        { id: "p5", organization_id: "org-2", company_id: CO, invoice_id: "i8", amount_cents: 99_000, method: "card", status: "succeeded", received_at: "2026-10-02T16:00:00Z" },
      ],
      invoices: [
        { id: "i1", organization_id: ORG, company_id: CO, contact_id: "c1", status: "partially_paid", issue_date: "2026-10-01", total_cents: 30_000, balance_due_cents: 20_000, pending_payment_cents: 7_000, due_date: "2026-10-15", currency: "CAD" },
        { id: "i2", organization_id: ORG, company_id: CO, contact_id: "c1", status: "draft", issue_date: "2026-10-03", total_cents: 50_000, balance_due_cents: 50_000, pending_payment_cents: 0, due_date: null, currency: "CAD" },
        { id: "i3", organization_id: ORG, company_id: CO, contact_id: "c1", status: "void", issue_date: "2026-10-03", total_cents: 60_000, balance_due_cents: 0, pending_payment_cents: 0, due_date: null, currency: "CAD" },
        { id: "i9", organization_id: ORG, company_id: OTHER, contact_id: "c9", status: "sent", issue_date: "2026-10-03", total_cents: 99_000, balance_due_cents: 99_000, pending_payment_cents: 0, due_date: "2026-10-03", currency: "CAD" },
      ],
      quotes: [
        { id: "q1", organization_id: ORG, company_id: CO, contact_id: "c2", deposit_paid_at: "2026-10-04T12:00:00Z", approved_deposit_cents: 2_500, deposit_cents: 2_000, currency: "CAD", sent_at: "2026-10-01T12:00:00Z", approved_at: "2026-10-02T12:00:00Z", status: "deposit_paid", superseded_by: null, approved_total_cents: 10_000, total_cents: 10_000 },
      ],
      contacts: [
        { id: "c1", organization_id: ORG, company_id: CO, first_name: "Pat", last_name: "Smith", created_at: "2026-10-01T15:00:00Z" },
        { id: "c2", organization_id: ORG, company_id: CO, first_name: "Sam", last_name: null, created_at: "2026-09-12T15:00:00Z" },
      ],
      bookings: [],
      time_entries: [
        { id: "t1", organization_id: ORG, company_id: null, booking_id: null, profile_id: "u1", started_at: "2026-10-05T12:00:00Z", ended_at: "2026-10-05T13:00:00Z", break_minutes: 0 },
        { id: "t2", organization_id: ORG, company_id: OTHER, booking_id: null, profile_id: "u1", started_at: "2026-10-05T14:00:00Z", ended_at: "2026-10-05T15:00:00Z", break_minutes: 0 },
      ],
      member_pay_rates: [{ organization_id: ORG, profile_id: "u1", hourly_cost_cents: 2_400 }],
      profiles: [{ id: "u1", full_name: "Dana", email: "dana@example.com" }],
    });
  }

  it("reads one company's figures, skipping refunds, pending payments, drafts, void and other orgs", async () => {
    const db = seed();
    const r = await getBusinessOverview(fakeTenantContext(db, ORG), { from: "2026-10-01", to: "2026-11-01", companyId: CO }, new Date("2026-10-20T16:00:00Z"));
    expect(r.period.timeZone).toBe(TZ);
    expect(r.money.collected.value).toBe(12_500); // 10,000 card + 2,500 deposit
    expect(r.money.invoiced).toEqual({ value: 30_000, previous: 0 });
    expect(r.receivables.outstandingCents).toBe(20_000);
    expect(r.receivables.inTransitCents).toBe(7_000);
    expect(r.receivables.overdueCents).toBe(20_000);
    expect(r.quotes.sent.value).toBe(1);
    expect(r.quotes.won).toBe(1);
    expect(r.customers.newCustomers).toEqual({ value: 1, previous: 1 });
    expect(r.topCustomers.map((c) => c.name)).toEqual(["Pat Smith", "Sam"]);
    // General time (no company) counts; the other company's time doesn't.
    expect(r.crew.minutes.value).toBe(60);
    expect(r.crew.labourCostCents).toBe(2_400);
  });

  it("covers every company when none is selected", async () => {
    const db = seed();
    const r = await getBusinessOverview(fakeTenantContext(db, ORG), { from: "2026-10-01", to: "2026-11-01" }, new Date("2026-10-20T16:00:00Z"));
    expect(r.money.collected.value).toBe(111_500);
    expect(r.receivables.outstandingCents).toBe(119_000);
    expect(r.crew.minutes.value).toBe(120);
  });

  it("reads past the 1,000-row page limit", async () => {
    const payments = Array.from({ length: 2_345 }, (_, i) => ({
      id: `p${i}`,
      organization_id: ORG,
      company_id: CO,
      invoice_id: "i1",
      amount_cents: 100,
      method: "card",
      status: "succeeded",
      received_at: new Date(Date.parse("2026-10-02T12:00:00Z") + i * 1000).toISOString(),
    }));
    const db = createFakeDb({ companies: [{ id: CO, organization_id: ORG, timezone: TZ }], invoice_payments: payments, invoices: [{ id: "i1", organization_id: ORG, contact_id: null, currency: "CAD" }] });
    const r = await getBusinessOverview(fakeTenantContext(db, ORG), { from: "2026-10-01", to: "2026-11-01", companyId: CO });
    expect(r.money.collected.value).toBe(234_500);
  });

  it("surfaces read errors", async () => {
    const db = seed();
    db.failNext("invoice_payments", { message: "boom" });
    await expect(getBusinessOverview(fakeTenantContext(db, ORG), { from: "2026-10-01", to: "2026-11-01", companyId: CO })).rejects.toMatchObject({ message: "boom" });
  });
});
