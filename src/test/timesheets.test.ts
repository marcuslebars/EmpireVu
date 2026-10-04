import { describe, expect, it } from "vitest";

import { computeJobProfit, csvCell, hoursLabel, labourCents, minutesByDay, weekStart, workedMinutes } from "@/server/services/time/logic";
import { clockIn, clockOut, createManualEntry, getMyClock, jobProfit, profitReport, updateEntry } from "@/server/services/time/service";
import { createFakeDb, fakeTenantContext } from "./fake-supabase";

describe("timesheet maths", () => {
  it("counts worked minutes, minus breaks, and running clocks up to now", () => {
    expect(workedMinutes({ started_at: "2026-10-05T13:00:00Z", ended_at: "2026-10-05T17:30:00Z", break_minutes: 30 })).toBe(240);
    expect(workedMinutes({ started_at: "2026-10-05T13:00:00Z", ended_at: null, break_minutes: 0 }, new Date("2026-10-05T13:45:30Z"))).toBe(45);
    expect(workedMinutes({ started_at: "2026-10-05T13:00:00Z", ended_at: "2026-10-05T13:10:00Z", break_minutes: 30 })).toBe(0);
  });

  it("prices labour to the cent and formats hours", () => {
    expect(labourCents(90, 2850)).toBe(4275); // 1.5h × $28.50
    expect(labourCents(1, 2000)).toBe(33);
    expect(hoursLabel(425)).toBe("7h 05m");
  });

  it("works out job profit, flags people with no rate, and margin", () => {
    const p = computeJobProfit({
      revenueCents: 50000,
      revenueSource: "invoice",
      entries: [
        { profile_id: "a", started_at: "2026-10-05T13:00:00Z", ended_at: "2026-10-05T16:00:00Z", break_minutes: 0 },
        { profile_id: "b", started_at: "2026-10-05T13:00:00Z", ended_at: "2026-10-05T15:00:00Z", break_minutes: 0 },
      ],
      rates: new Map([["a", 3000]]),
      materials: [{ quantity: 2, unit_cost_cents: 4500 }],
    });
    expect(p).toMatchObject({ labourMinutes: 300, labourCents: 9000, materialsCents: 9000, costCents: 18000, profitCents: 32000, marginPct: 64, missingRates: ["b"] });
    expect(computeJobProfit({ revenueCents: 0, revenueSource: "none", entries: [], rates: new Map(), materials: [] }).marginPct).toBeNull();
  });

  it("weeks start on Monday and days follow the brand's zone", () => {
    expect(weekStart("2026-10-04")).toBe("2026-09-28"); // Sunday → previous Monday
    expect(weekStart("2026-10-05")).toBe("2026-10-05");
    const byDay = minutesByDay([{ started_at: "2026-10-06T02:00:00Z", ended_at: "2026-10-06T03:00:00Z", break_minutes: 0 }], "America/Toronto");
    expect([...byDay.entries()]).toEqual([["2026-10-05", 60]]); // 10 p.m. Monday in Toronto
  });

  it("makes CSV cells safe", () => {
    expect(csvCell('He said "hi", ok')).toBe('"He said ""hi"", ok"');
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell(-5)).toBe("-5");
  });
});

const ORG = "org-1";
function seed() {
  return createFakeDb({
    bookings: [
      { id: "b1", organization_id: ORG, company_id: "co-1", title: "Shrink wrap", status: "completed", scheduled_for: "2026-10-05T13:00:00Z", quote_id: "q1", recurring_job_id: null, contact_id: null },
      { id: "b2", organization_id: ORG, company_id: "co-1", title: "Detailing", status: "confirmed", scheduled_for: "2026-10-06T13:00:00Z", quote_id: null, recurring_job_id: null, contact_id: null },
    ],
    profiles: [
      { id: "dana", full_name: "Dana Reid", email: "d@x.test" },
      { id: "lee", full_name: "Lee Park", email: "l@x.test" },
    ],
    time_entries: [],
    job_materials: [],
    member_pay_rates: [{ organization_id: ORG, profile_id: "dana", hourly_cost_cents: 3000 }],
    invoices: [],
    quotes: [{ id: "q1", organization_id: ORG, subtotal_cents: 70000, approved_subtotal_cents: 60000 }],
    recurring_jobs: [],
    contacts: [],
  });
}

describe("clock in / out", () => {
  it("clocking in to another job stops the running clock first", async () => {
    const db = seed();
    const ctx = fakeTenantContext(db, ORG, "dana");
    await clockIn(ctx, { bookingId: "b1" }, new Date("2026-10-05T13:00:00Z"));
    const second = await clockIn(ctx, { bookingId: "b2" }, new Date("2026-10-05T15:00:00Z"));
    expect(second.jobTitle).toBe("Detailing");
    const [first] = db.tables.time_entries.filter((e) => e.booking_id === "b1");
    expect(first.ended_at).toBe("2026-10-05T15:00:00.000Z");
    expect((await getMyClock(ctx))?.bookingId).toBe("b2");
  });

  it("clocking in to the job you're already on is a no-op", async () => {
    const db = seed();
    const ctx = fakeTenantContext(db, ORG, "dana");
    await clockIn(ctx, { bookingId: "b1" }, new Date("2026-10-05T13:00:00Z"));
    await clockIn(ctx, { bookingId: "b1" }, new Date("2026-10-05T13:30:00Z"));
    expect(db.tables.time_entries).toHaveLength(1);
  });

  it("a forgotten clock is capped at 24 hours on clock-out", async () => {
    const db = seed();
    const ctx = fakeTenantContext(db, ORG, "dana");
    await clockIn(ctx, {}, new Date("2026-10-05T13:00:00Z"));
    const out = await clockOut(ctx, new Date("2026-10-08T13:00:00Z"));
    expect(out?.endedAt).toBe("2026-10-06T13:00:00.000Z");
    expect(await clockOut(ctx)).toBeNull();
  });

  it("validates hand edits", async () => {
    const db = seed();
    const ctx = fakeTenantContext(db, ORG, "dana");
    const e = await createManualEntry(ctx, { startedAt: "2026-10-05T13:00:00Z", endedAt: "2026-10-05T17:00:00Z", breakMinutes: 30, bookingId: "b1" });
    expect(e.minutes).toBe(210);
    await expect(updateEntry(ctx, e.id, { endedAt: "2026-10-05T12:00:00Z" })).rejects.toThrow(/after the start/);
    await expect(updateEntry(ctx, e.id, { endedAt: "2026-10-07T13:00:00Z" })).rejects.toThrow(/24 hours/);
  });
});

describe("job costing", () => {
  it("uses the invoice when there is one, else the approved quote", async () => {
    const db = seed();
    const ctx = fakeTenantContext(db, ORG, "owner");
    db.tables.time_entries.push(
      { id: "t1", organization_id: ORG, booking_id: "b1", profile_id: "dana", started_at: "2026-10-05T13:00:00Z", ended_at: "2026-10-05T17:00:00Z", break_minutes: 0 },
      { id: "t2", organization_id: ORG, booking_id: "b1", profile_id: "lee", started_at: "2026-10-05T13:00:00Z", ended_at: "2026-10-05T15:00:00Z", break_minutes: 0 },
    );
    db.tables.job_materials.push({ id: "m1", organization_id: ORG, booking_id: "b1", quantity: 1, unit_cost_cents: 15000 });

    let p = await jobProfit(ctx, "b1");
    expect(p).toMatchObject({ revenueCents: 60000, revenueSource: "estimate", labourCents: 12000, materialsCents: 15000, profitCents: 33000, missingRateNames: ["Lee Park"] });

    db.tables.invoices.push({ id: "i1", organization_id: ORG, booking_id: "b1", subtotal_cents: 65000, status: "sent" });
    p = await jobProfit(ctx, "b1");
    expect(p).toMatchObject({ revenueCents: 65000, revenueSource: "invoice", profitCents: 38000 });

    db.tables.invoices[0].status = "void";
    expect((await jobProfit(ctx, "b1")).revenueSource).toBe("estimate");
  });

  it("reports finished jobs in the window with totals", async () => {
    const db = seed();
    const ctx = fakeTenantContext(db, ORG, "owner");
    db.tables.time_entries.push({ id: "t1", organization_id: ORG, booking_id: "b1", profile_id: "dana", started_at: "2026-10-05T13:00:00Z", ended_at: "2026-10-05T15:00:00Z", break_minutes: 0 });
    const r = await profitReport(ctx, { from: "2026-10-01T00:00:00Z", to: "2026-10-31T00:00:00Z" });
    expect(r.rows.map((x) => x.bookingId)).toEqual(["b1"]); // b2 isn't finished
    expect(r.totals).toEqual({ revenueCents: 60000, costCents: 6000, profitCents: 54000, labourMinutes: 120 });
  });
});
