import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, fakeTenantContext, type FakeDb } from "./fake-supabase";

let db: FakeDb;
const notified: Array<{ title: string; body: string; crewIds: string[] }> = [];
const tasks: Array<{ title: string; description: string }> = [];
const activity: string[] = [];
const rescheduled: Array<Record<string, unknown>> = [];

vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => db.client }));
vi.mock("@/server/services/push/notify", () => ({
  notifyVisitChange: vi.fn(async (i: { title: string; body: string; crewIds: string[] }) => {
    notified.push(i);
  }),
}));
vi.mock("@/server/services/tasks", () => ({
  createTask: vi.fn(async (_c: unknown, i: { title: string; description: string }) => {
    tasks.push(i);
    return {};
  }),
}));
vi.mock("@/server/services/activity-events", () => ({
  createActivityEvent: vi.fn(async (_c: unknown, e: { eventType: string }) => {
    activity.push(e.eventType);
    return {};
  }),
}));
// The real booking services are covered elsewhere; here they just write the row.
vi.mock("@/server/services/bookings", () => ({
  rescheduleBooking: vi.fn(async (_c: unknown, i: { bookingId: string; scheduledFor: string; windowKey?: string; by?: string }) => {
    rescheduled.push(i);
    const row = db.tables.bookings.find((b) => b.id === i.bookingId)!;
    row.scheduled_for = i.scheduledFor;
    if (i.windowKey !== undefined) row.window_key = i.windowKey;
    return row;
  }),
  updateBookingStatus: vi.fn(async (_c: unknown, i: { bookingId: string; status: string }) => {
    const row = db.tables.bookings.find((b) => b.id === i.bookingId)!;
    row.status = i.status;
    return row;
  }),
}));

const { DEFAULT_VISIT_SETTINGS, parseVisitSettings, visitActions, visitState } = await import("@/server/services/visits/rules");
const { cancelVisit, confirmVisit, getOpenTimes, getVisit, rescheduleVisit, VisitConflictError, VisitNotFoundError } = await import("@/server/services/visits/public");
const { getVisitSettings, withVisitLink, addLinkToReminders, getVisitLink } = await import("@/server/services/visits/settings");

const ORG = "org-1";
const CO = "11111111-1111-4111-8111-111111111111";
const TOKEN = "a".repeat(32);
const TZ = "America/Toronto";
// Monday Oct 5 2026, 10:00 EDT.
const NOW = new Date("2026-10-05T14:00:00Z");

function seed(over: { booking?: Record<string, unknown>; company?: Record<string, unknown>; others?: Array<Record<string, unknown>> } = {}) {
  db = createFakeDb({
    companies: [
      {
        id: CO,
        organization_id: ORG,
        name: "A1 Marine Care",
        brand_from_name: null,
        brand_reply_phone: "+17055550000",
        quote_public_base_url: "https://quotes.a1marinecare.ca",
        timezone: TZ,
        visit_settings: {},
        booking_policy: null,
        ...over.company,
      },
    ],
    contacts: [{ id: "c1", organization_id: ORG, company_id: CO, first_name: "Pat", last_name: "Smith" }],
    bookings: [
      {
        id: "b1",
        organization_id: ORG,
        company_id: CO,
        contact_id: "c1",
        title: "Shrink wrap",
        status: "pending",
        // Thursday Oct 8, 10:00 EDT.
        scheduled_for: "2026-10-08T14:00:00.000Z",
        duration_minutes: 60,
        window_key: null,
        location: "Dock 4",
        en_route_at: null,
        started_at: null,
        customer_confirmed_at: null,
        manage_token: TOKEN,
        notes: "gate code 1234",
        ...over.booking,
      },
      ...(over.others ?? []),
    ],
    booking_assignments: [{ organization_id: ORG, booking_id: "b1", profile_id: "crew-1" }],
    workflows: [],
  });
}

beforeEach(() => {
  notified.length = 0;
  tasks.length = 0;
  activity.length = 0;
  rescheduled.length = 0;
});

describe("rules", () => {
  const base = { status: "confirmed", scheduledFor: "2026-10-08T14:00:00Z", durationMinutes: 60, enRouteAt: null, startedAt: null, customerConfirmedAt: null };

  it("defaults settings", () => {
    expect(parseVisitSettings(null)).toEqual(DEFAULT_VISIT_SETTINGS);
    expect(parseVisitSettings({ cutoffHours: 999, allowCancel: false })).toEqual({ ...DEFAULT_VISIT_SETTINGS, allowCancel: false });
  });

  it("names the visit's state", () => {
    const now = NOW.getTime();
    expect(visitState(base, now)).toBe("scheduled");
    expect(visitState({ ...base, customerConfirmedAt: "x" }, now)).toBe("confirmed");
    expect(visitState({ ...base, enRouteAt: "x" }, now)).toBe("on_the_way");
    expect(visitState({ ...base, startedAt: "x" }, now)).toBe("in_progress");
    expect(visitState({ ...base, status: "completed" }, now)).toBe("done");
    expect(visitState({ ...base, status: "cancelled" }, now)).toBe("cancelled");
    expect(visitState({ ...base, scheduledFor: "2026-10-01T14:00:00Z" }, now)).toBe("past");
  });

  it("locks changes inside the cutoff but still allows confirming", () => {
    const soon = { ...base, scheduledFor: new Date(NOW.getTime() + 5 * 3_600_000).toISOString() };
    expect(visitActions(soon, DEFAULT_VISIT_SETTINGS, NOW.getTime())).toEqual({
      canConfirm: true,
      canReschedule: false,
      canCancel: false,
      lockedReason: "Changes within 24 hours of the visit need a quick call or text.",
    });
    expect(visitActions(base, DEFAULT_VISIT_SETTINGS, NOW.getTime())).toMatchObject({ canConfirm: true, canReschedule: true, canCancel: true, lockedReason: null });
    expect(visitActions(base, { ...DEFAULT_VISIT_SETTINGS, allowReschedule: false, allowCancel: false }, NOW.getTime())).toMatchObject({ canReschedule: false, canCancel: false, lockedReason: null });
    expect(visitActions({ ...base, startedAt: "x" }, DEFAULT_VISIT_SETTINGS, NOW.getTime())).toMatchObject({ canConfirm: false, canReschedule: false, canCancel: false });
  });
});

describe("the visit page", () => {
  it("shows the visit without internal details", async () => {
    seed();
    const v = await getVisit(TOKEN, NOW);
    expect(v).toMatchObject({ customerName: "Pat", title: "Shrink wrap", date: "Thursday, October 8", time: "10:00 a.m.", location: "Dock 4", state: "scheduled", canConfirm: true, canReschedule: true, canCancel: true });
    expect(v.brand.name).toBe("A1 Marine Care");
    const json = JSON.stringify(v);
    expect(json).not.toMatch(/gate code|b1|c1|org-1|crew-1/);
  });

  it("refuses unknown and malformed tokens", async () => {
    seed();
    await expect(getVisit("b".repeat(32), NOW)).rejects.toBeInstanceOf(VisitNotFoundError);
    await expect(getVisit("nope", NOW)).rejects.toBeInstanceOf(VisitNotFoundError);
  });

  it("confirms once, moving a pending visit to confirmed", async () => {
    seed();
    const v = await confirmVisit(TOKEN, NOW);
    expect(v.state).toBe("confirmed");
    expect(db.tables.bookings[0]).toMatchObject({ status: "confirmed", customer_confirmed_at: NOW.toISOString() });
    expect(activity).toEqual(["booking.customer_confirmed"]);
    await confirmVisit(TOKEN, NOW);
    expect(activity).toHaveLength(1);
  });

  it("won't confirm a cancelled visit", async () => {
    seed({ booking: { status: "cancelled" } });
    await expect(confirmVisit(TOKEN, NOW)).rejects.toBeInstanceOf(VisitConflictError);
  });
});

describe("moving a visit", () => {
  it("offers hourly open times past the cutoff, skipping busy ones", async () => {
    // Another job Friday 10–11.
    seed({ others: [{ id: "b2", organization_id: ORG, company_id: CO, status: "confirmed", scheduled_for: "2026-10-09T14:00:00.000Z", duration_minutes: 60, window_key: null }] });
    const times = await getOpenTimes(TOKEN, NOW);
    expect(times.length).toBeGreaterThan(20);
    expect(times.every((t) => Date.parse(t.startsAt) >= NOW.getTime() + 24 * 3_600_000)).toBe(true);
    expect(times.some((t) => t.startsAt === "2026-10-09T14:00:00.000Z")).toBe(false);
    expect(times.some((t) => t.startsAt === "2026-10-08T14:00:00.000Z")).toBe(false); // its own time
    expect(times.find((t) => t.startsAt === "2026-10-09T13:00:00.000Z")).toMatchObject({ day: "2026-10-09", dayLabel: "Friday, October 9", label: "9:00 a.m.", windowKey: null });
  });

  it("offers the brand's booking windows when it books by window", async () => {
    seed({
      company: { booking_policy: { mode: "windows", capacityPerWindow: 1, leadTimeHours: 24, horizonDays: 7, workingDays: [1, 2, 3, 4, 5] } },
      booking: { window_key: "morning", scheduled_for: "2026-10-08T13:00:00.000Z" },
      others: [{ id: "b2", organization_id: ORG, company_id: CO, status: "confirmed", scheduled_for: "2026-10-07T13:00:00.000Z", duration_minutes: 180, window_key: "morning" }],
    });
    const times = await getOpenTimes(TOKEN, NOW);
    // Tue morning is inside the 24h cutoff, so Tue afternoon is first; Wed morning is full.
    expect(times[0]).toMatchObject({ day: "2026-10-06", label: "Afternoon", windowKey: "afternoon" });
    expect(times.some((t) => t.day === "2026-10-07" && t.windowKey === "morning")).toBe(false);
    expect(times.some((t) => t.day === "2026-10-07" && t.windowKey === "afternoon")).toBe(true);
    expect(times.some((t) => t.day === "2026-10-08" && t.windowKey === "morning")).toBe(false); // where it already is
    expect(times.some((t) => t.day === "2026-10-10")).toBe(false); // Saturday isn't a working day
  });

  it("moves to an offered time, confirms it, and tells the owner and crew", async () => {
    seed();
    const v = await rescheduleVisit(TOKEN, { startsAt: "2026-10-09T17:00:00.000Z" }, NOW);
    expect(rescheduled[0]).toMatchObject({ bookingId: "b1", scheduledFor: "2026-10-09T17:00:00.000Z", by: "customer" });
    expect(v).toMatchObject({ date: "Friday, October 9", time: "1:00 p.m.", state: "confirmed" });
    expect(notified[0]).toMatchObject({ title: "Pat Smith moved their visit", crewIds: ["crew-1"] });
    expect(notified[0].body).toBe("Shrink wrap: Thursday, October 8 10:00 a.m. → Friday, October 9, 1:00 p.m.");
  });

  it("rejects a time it didn't offer", async () => {
    seed();
    await expect(rescheduleVisit(TOKEN, { startsAt: "2026-10-11T14:00:00.000Z" }, NOW)).rejects.toThrow(/just taken/); // Sunday
    await expect(rescheduleVisit(TOKEN, { startsAt: "2026-10-06T13:00:00.000Z" }, NOW)).rejects.toThrow(/just taken/); // 9am Tue: inside the 24h cutoff
    expect(rescheduled).toHaveLength(0);
  });

  it("refuses inside the cutoff, or when the brand doesn't allow it", async () => {
    seed({ booking: { scheduled_for: "2026-10-05T20:00:00.000Z" } });
    await expect(rescheduleVisit(TOKEN, { startsAt: "2026-10-09T17:00:00.000Z" }, NOW)).rejects.toThrow(/can't be moved/);
    expect(await getOpenTimes(TOKEN, NOW)).toEqual([]);
    seed({ company: { visit_settings: { allowReschedule: false } } });
    await expect(rescheduleVisit(TOKEN, { startsAt: "2026-10-09T17:00:00.000Z" }, NOW)).rejects.toThrow(/can't be moved/);
  });
});

describe("cancelling", () => {
  it("cancels, leaves a follow-up task with the reason, and tells the owner and crew", async () => {
    seed();
    const v = await cancelVisit(TOKEN, { reason: "Boat sold" }, NOW);
    expect(v.state).toBe("cancelled");
    expect(db.tables.bookings[0].status).toBe("cancelled");
    expect(activity).toContain("booking.customer_cancelled");
    expect(tasks[0].title).toBe('Pat Smith cancelled "Shrink wrap" — follow up');
    expect(tasks[0].description).toMatch(/Boat sold/);
    expect(notified[0]).toMatchObject({ title: "Pat Smith cancelled their visit", crewIds: ["crew-1"] });
  });

  it("refuses when the brand doesn't allow it", async () => {
    seed({ company: { visit_settings: { allowCancel: false } } });
    await expect(cancelVisit(TOKEN, {}, NOW)).rejects.toBeInstanceOf(VisitConflictError);
    expect(db.tables.bookings[0].status).toBe("pending");
  });
});

describe("staff side", () => {
  it("adds the visit link to a reminder's first customer text", () => {
    const def = { version: 1, actions: [{ type: "send_sms", to: "contact", body: "Hi! See you Tuesday. Reply if you need to change it." }, { type: "wait", until: "x" }, { type: "send_sms", to: "contact", body: "Soon!" }] };
    const out = withVisitLink(def);
    expect(out.changed).toBe(true);
    expect((out.definition as typeof def).actions[0].body).toBe("Hi! See you Tuesday. Confirm or change it here: {{booking.manage_url}}");
    expect((out.definition as typeof def).actions[2].body).toBe("Soon!");
    expect(withVisitLink(out.definition).changed).toBe(false);
    const plain = withVisitLink({ actions: [{ type: "send_sms", body: "See you soon." }] });
    expect((plain.definition as { actions: Array<{ body: string }> }).actions[0].body).toBe("See you soon. Confirm or change it here: {{booking.manage_url}}");
    expect(withVisitLink({ actions: [{ type: "send_sms", to: "owner", body: "x" }] }).changed).toBe(false);
  });

  it("lists reminders, adds the link to them, and gives staff the job's link", async () => {
    seed();
    db.tables.workflows.push(
      { id: "w1", organization_id: ORG, company_id: CO, name: "Booking reminders", status: "active", trigger_event: "booking.upcoming", definition: { actions: [{ type: "send_sms", to: "contact", body: "Reminder. Reply if you need to change it." }] } },
      { id: "w2", organization_id: ORG, company_id: CO, name: "Old", status: "archived", trigger_event: "booking.upcoming", definition: { actions: [] } },
    );
    const ctx = fakeTenantContext(db, ORG);
    const before = await getVisitSettings(ctx, CO);
    expect(before).toMatchObject({ settings: DEFAULT_VISIT_SETTINGS, linkBase: "https://quotes.a1marinecare.ca/v/", reminders: [{ id: "w1", hasLink: false }] });
    const after = await addLinkToReminders(ctx, CO);
    expect(after.reminders[0].hasLink).toBe(true);
    expect(await getVisitLink(ctx, "b1")).toEqual({ url: `https://quotes.a1marinecare.ca/v/${TOKEN}`, customerConfirmedAt: null, depositCents: null, depositPaidAt: null, holdExpiresAt: null });
  });
});
