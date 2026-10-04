import { describe, expect, it } from "vitest";

import { describeRule, nextOccurrence, occurrencesBetween, type RecurrenceRule } from "@/server/services/recurring/rule";
import {
  clearUntouchedFutureVisits,
  createRecurringJob,
  datesToGenerate,
  generateVisits,
  priceOf,
  readLineItems,
  setRecurringStatus,
  updateRecurringJob,
  type RecurringJobInput,
} from "@/server/services/recurring/service";
import { createFakeDb, fakeTenantContext } from "./fake-supabase";

const rule = (r: Partial<RecurrenceRule>): RecurrenceRule => ({ frequency: "weekly", interval: 1, startDate: "2026-10-06", ...r });

describe("recurrence rules", () => {
  it("weekly defaults to the start date's weekday", () => {
    expect(occurrencesBetween(rule({}), "2026-10-01", "2026-10-31")).toEqual(["2026-10-06", "2026-10-13", "2026-10-20", "2026-10-27"]);
  });

  it("every 2 weeks on Tue & Fri, counted from the start week", () => {
    const dates = occurrencesBetween(rule({ interval: 2, weekdays: [2, 5] }), "2026-10-01", "2026-11-01");
    expect(dates).toEqual(["2026-10-06", "2026-10-09", "2026-10-20", "2026-10-23"]);
  });

  it("weekly skips chosen days before the start date in the first week", () => {
    // Start Wed Oct 7, days Mon+Fri: first visit is Fri Oct 9, not Mon Oct 5.
    expect(occurrencesBetween(rule({ startDate: "2026-10-07", weekdays: [1, 5] }), "2026-10-01", "2026-10-13")).toEqual(["2026-10-09", "2026-10-12"]);
  });

  it("monthly on the 31st falls back to the last day of short months", () => {
    const dates = occurrencesBetween(rule({ frequency: "monthly", startDate: "2026-01-31" }), "2026-01-01", "2026-05-31");
    expect(dates).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
  });

  it("yearly on Feb 29 lands on Feb 28 in other years", () => {
    expect(occurrencesBetween(rule({ frequency: "yearly", startDate: "2028-02-29" }), "2028-01-01", "2031-12-31")).toEqual([
      "2028-02-29",
      "2029-02-28",
      "2030-02-28",
      "2031-02-28",
    ]);
  });

  it("honours the end date and the occurrence cap (counted from the first visit)", () => {
    expect(occurrencesBetween(rule({ endsOn: "2026-10-20" }), "2026-10-01", "2026-12-31")).toHaveLength(3);
    // 4 visits total; asking from Oct 14 only returns the 3rd and 4th.
    expect(occurrencesBetween(rule({ maxOccurrences: 4 }), "2026-10-14", "2026-12-31")).toEqual(["2026-10-20", "2026-10-27"]);
  });

  it("finds the next visit far ahead and says when a series is finished", () => {
    expect(nextOccurrence(rule({ frequency: "yearly", startDate: "2026-05-01" }), "2026-10-04")).toBe("2027-05-01");
    expect(nextOccurrence(rule({ endsOn: "2026-10-06" }), "2026-10-07")).toBeNull();
  });

  it("describes rules in plain words", () => {
    expect(describeRule(rule({}))).toBe("Weekly on Tuesday");
    expect(describeRule(rule({ interval: 2, weekdays: [2, 5] }))).toBe("Every 2 weeks on Tue & Fri");
    expect(describeRule(rule({ frequency: "monthly", startDate: "2026-10-15" }))).toBe("Monthly on the 15th");
    expect(describeRule(rule({ frequency: "yearly", startDate: "2026-05-01", maxOccurrences: 3 }))).toBe("Every year on May 1, 3 times");
  });

  it("always schedules at least the next visit for long intervals", () => {
    const { dates } = datesToGenerate(rule({ frequency: "yearly", startDate: "2026-05-01" }), "2026-10-04");
    expect(dates).toEqual(["2027-05-01"]);
    expect(datesToGenerate(rule({}), "2026-10-04").dates).toHaveLength(9); // ~60 days of Tuesdays
  });

  it("reads and prices line items, dropping junk", () => {
    const lines = readLineItems([{ label: "Pool clean", quantity: 1, unitPriceCents: 9500 }, { label: "", quantity: 1, unitPriceCents: 5 }, "x"]);
    expect(lines).toEqual([{ label: "Pool clean", quantity: 1, unitPriceCents: 9500 }]);
    expect(priceOf([{ label: "a", quantity: 1.5, unitPriceCents: 1000 }, { label: "b", quantity: 2, unitPriceCents: 250 }])).toBe(2000);
  });
});

const ORG = "org-1";
function seed() {
  return createFakeDb({
    companies: [{ id: "co-1", organization_id: ORG, name: "Sparkle Pools", timezone: "America/Toronto" }],
    contacts: [{ id: "ct-1", organization_id: ORG, first_name: "Pat", last_name: "Smith" }],
    organization_memberships: [
      { organization_id: ORG, profile_id: "owner" },
      { organization_id: ORG, profile_id: "tech-1" },
    ],
    profiles: [{ id: "tech-1", full_name: "Dana Reid", email: "dana@x.test" }],
    checklist_templates: [{ id: "tpl", organization_id: ORG, company_id: "co-1", name: "Pool", items: ["Skim", "Test water"] }],
    recurring_jobs: [],
    bookings: [],
    booking_assignments: [],
    booking_checklist_items: [],
  });
}
const input = (over: Partial<RecurringJobInput> = {}): RecurringJobInput => ({
  companyId: "co-1",
  contactId: "ct-1",
  title: "Weekly pool clean",
  durationMinutes: 60,
  frequency: "weekly",
  interval: 1,
  startDate: "2026-10-06",
  timeOfDay: "09:00",
  crewProfileIds: ["tech-1"],
  checklistTemplateId: "tpl",
  lineItems: [{ label: "Pool clean", quantity: 1, unitPriceCents: 9500 }],
  ...over,
});
const NOW = new Date("2026-10-04T16:00:00Z"); // Sun Oct 4, noon in Toronto

describe("generating visits", () => {
  it("creates ~60 days of visits at 9:00 local with crew and checklist", async () => {
    const db = seed();
    const ctx = fakeTenantContext(db, ORG, "owner");
    const { visitsCreated } = await createRecurringJob(ctx, input(), NOW);
    expect(visitsCreated).toBe(9);
    const first = db.tables.bookings.sort((a, b) => String(a.scheduled_for).localeCompare(String(b.scheduled_for)))[0];
    expect(first).toMatchObject({ occurrence_date: "2026-10-06", scheduled_for: "2026-10-06T13:00:00.000Z", status: "confirmed", source: "recurring", contact_id: "ct-1" });
    expect(db.tables.booking_assignments).toHaveLength(9);
    expect(db.tables.booking_checklist_items).toHaveLength(18);
  });

  it("is idempotent — running again adds nothing", async () => {
    const db = seed();
    const ctx = fakeTenantContext(db, ORG, "owner");
    const { series } = await createRecurringJob(ctx, input(), NOW);
    expect(await generateVisits(ctx, { ...series, status: "active" }, NOW)).toEqual([]);
    expect(db.tables.bookings).toHaveLength(9);
  });

  it("uses the local wall clock across the DST change", async () => {
    const db = seed();
    const ctx = fakeTenantContext(db, ORG, "owner");
    await createRecurringJob(ctx, input({ startDate: "2026-10-27" }), NOW);
    const nov3 = db.tables.bookings.find((b) => b.occurrence_date === "2026-11-03");
    expect(nov3?.scheduled_for).toBe("2026-11-03T14:00:00.000Z"); // 9:00 EST
  });

  it("refuses crew who aren't on the team and another company's checklist", async () => {
    const db = seed();
    const ctx = fakeTenantContext(db, ORG, "owner");
    await expect(createRecurringJob(ctx, input({ crewProfileIds: ["stranger"] }), NOW)).rejects.toThrow(/team/);
    db.tables.checklist_templates[0].company_id = "co-2";
    await expect(createRecurringJob(ctx, input(), NOW)).rejects.toThrow(/another company/);
  });

  it("editing re-lays untouched visits but keeps ones moved by hand, started, or cancelled", async () => {
    const db = seed();
    const ctx = fakeTenantContext(db, ORG, "owner");
    const { series } = await createRecurringJob(ctx, input(), NOW);
    const byDate = (d: string) => db.tables.bookings.find((b) => b.occurrence_date === d)!;
    byDate("2026-10-13").recurrence_exception = true;
    byDate("2026-10-20").status = "cancelled";
    byDate("2026-10-06").started_at = "2026-10-06T13:05:00Z";

    const res = await updateRecurringJob(ctx, series.id, input({ timeOfDay: "14:00" }), NOW);
    expect(res.visitsRemoved).toBe(6);
    expect(byDate("2026-10-13").recurrence_exception).toBe(true);
    expect(byDate("2026-10-20").status).toBe("cancelled");
    expect(byDate("2026-10-06").scheduled_for).toBe("2026-10-06T13:00:00.000Z");
    expect(byDate("2026-10-27").scheduled_for).toBe("2026-10-27T18:00:00.000Z"); // re-laid at 14:00
  });

  it("pausing takes untouched visits off; resuming puts them back", async () => {
    const db = seed();
    const ctx = fakeTenantContext(db, ORG, "owner");
    const { series } = await createRecurringJob(ctx, input(), NOW);
    const paused = await setRecurringStatus(ctx, series.id, "paused", NOW);
    expect(paused.visitsRemoved).toBe(9);
    expect(db.tables.bookings).toHaveLength(0);
    const resumed = await setRecurringStatus(ctx, series.id, "active", NOW);
    expect(resumed.visitsCreated).toBe(9);
    await setRecurringStatus(ctx, series.id, "ended", NOW);
    await expect(setRecurringStatus(ctx, series.id, "active", NOW)).rejects.toThrow(/ended/);
  });

  it("never clears past or in-progress visits", async () => {
    const db = seed();
    const ctx = fakeTenantContext(db, ORG, "owner");
    const { series } = await createRecurringJob(ctx, input(), NOW);
    const later = new Date("2026-10-21T00:00:00Z");
    expect(await clearUntouchedFutureVisits(ctx, series.id, later)).toBe(6); // Oct 6/13/20 are in the past
  });
});
