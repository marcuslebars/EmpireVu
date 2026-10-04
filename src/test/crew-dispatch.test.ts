import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  notify: vi.fn((..._a: unknown[]) => Promise.resolve()),
  activity: vi.fn((..._a: unknown[]) => Promise.resolve({})),
  dispatch: vi.fn((..._a: unknown[]) => Promise.resolve({})),
  updateStatus: vi.fn((..._a: unknown[]) => Promise.resolve({ id: "b1", status: "completed" })),
}));

vi.mock("@/server/services/activity-events", () => ({ createActivityEvent: (...a: unknown[]) => h.activity(...a) }));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({ emitActivityEventAndDispatch: (...a: unknown[]) => h.dispatch(...a) }));
vi.mock("@/server/services/bookings", () => ({ updateBookingStatus: (...a: unknown[]) => h.updateStatus(...a) }));

import {
  checklistProgress,
  cleanChecklistLabels,
  diffCrew,
  formatJobWhen,
  itemsToAdd,
  jobStage,
  MAX_CHECKLIST_ITEMS,
} from "@/server/services/crew/logic";
import { renderAssignmentMessage } from "@/server/services/crew/notify";
import {
  applyChecklistTemplate,
  ChecklistIncompleteError,
  completeJob,
  createTemplate,
  listJobs,
  markEnRoute,
  setCrew,
} from "@/server/services/crew/service";
import type { JobSummary } from "@/lib/jobs-api";
import { groupJobsByDay } from "@/lib/jobs-format";
import { createFakeDb, fakeTenantContext, type FakeDb } from "./fake-supabase";

// renderAssignmentMessage is pure; the module mock above replaces only notifyCrewAssigned.
vi.mock("@/server/services/crew/notify", async (orig) => ({
  ...(await orig<typeof import("@/server/services/crew/notify")>()),
  notifyCrewAssigned: (...a: unknown[]) => h.notify(...a),
}));

const ORG = "org-1";
const booking = (over: Record<string, unknown> = {}) => ({
  id: "b1",
  organization_id: ORG,
  company_id: "co-1",
  contact_id: "ct-1",
  title: "Shrink wrap",
  description: null,
  scheduled_for: "2026-10-06T13:00:00.000Z",
  duration_minutes: 120,
  status: "confirmed",
  quote_id: null,
  location: "Wye Heritage Marina, C14",
  en_route_at: null,
  started_at: null,
  completed_at: null,
  completed_by: null,
  ...over,
});

function seed(extra: Record<string, Array<Record<string, unknown>>> = {}): FakeDb {
  return createFakeDb({
    bookings: [booking()],
    organization_memberships: [
      { organization_id: ORG, profile_id: "owner" },
      { organization_id: ORG, profile_id: "tech-1" },
      { organization_id: ORG, profile_id: "tech-2" },
    ],
    profiles: [
      { id: "owner", full_name: "Marcus", email: "m@x.test" },
      { id: "tech-1", full_name: "Dana Reid", email: "dana@x.test" },
      { id: "tech-2", full_name: "Lee Park", email: "lee@x.test" },
    ],
    companies: [{ id: "co-1", organization_id: ORG, name: "A1 Marine Care", timezone: "America/Toronto" }],
    contacts: [{ id: "ct-1", organization_id: ORG, first_name: "Pat", last_name: "Smith", phone: "+17055550123", email: "pat@x.test" }],
    booking_assignments: [],
    booking_checklist_items: [],
    checklist_templates: [],
    tasks: [],
    invoices: [],
    ...extra,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("crew rules", () => {
  it("diffs the crew", () => {
    expect(diffCrew(["a", "b"], ["b", "c"])).toEqual({ add: ["c"], remove: ["a"] });
    expect(diffCrew([], [])).toEqual({ add: [], remove: [] });
  });

  it("cleans checklist labels: trims, collapses spaces, drops blanks and duplicates, caps the count", () => {
    expect(cleanChecklistLabels(["  Check  bilge ", "", "check bilge", 7, "Photos"])).toEqual(["Check bilge", "Photos"]);
    expect(cleanChecklistLabels(Array.from({ length: 80 }, (_, i) => `Step ${i}`))).toHaveLength(MAX_CHECKLIST_ITEMS);
  });

  it("applying a template twice adds nothing new", () => {
    expect(itemsToAdd(["Wrap", "Vents"], ["wrap", "Vents ", "Photos"])).toEqual(["Photos"]);
  });

  it("derives the field stage", () => {
    const b = { status: "confirmed", en_route_at: null, started_at: null };
    expect(jobStage(b)).toBe("scheduled");
    expect(jobStage({ ...b, en_route_at: "x" })).toBe("en_route");
    expect(jobStage({ ...b, en_route_at: "x", started_at: "y" })).toBe("in_progress");
    expect(jobStage({ ...b, status: "completed" })).toBe("done");
    expect(jobStage({ ...b, status: "no_show" })).toBe("cancelled");
    expect(checklistProgress([{ done_at: "x" }, { done_at: null }])).toEqual({ done: 1, total: 2 });
  });

  it("formats the time in the brand's zone", () => {
    expect(formatJobWhen("2026-10-06T13:00:00.000Z", "America/Toronto")).toMatch(/Tue, Oct\.? 6 · 9:00/);
  });

  it("writes a plain assignment message with the job link", () => {
    const m = renderAssignmentMessage({
      title: "Shrink wrap",
      when: "Tue, Oct 6 · 9:00 a.m.",
      location: "Wye Heritage Marina",
      customer: "Pat Smith",
      companyName: "A1 Marine Care",
      assignedBy: "Marcus",
      link: "https://app.test/jobs/b1",
    });
    expect(m.subject).toBe("New job: Shrink wrap — Tue, Oct 6 · 9:00 a.m.");
    expect(m.pushBody).toContain("Wye Heritage Marina");
    expect(m.text).toContain("https://app.test/jobs/b1");
    expect(m.text).toContain("Customer: Pat Smith");
  });
});

describe("setCrew", () => {
  it("adds and removes, and notifies only the people just added (not yourself)", async () => {
    const db = seed({ booking_assignments: [{ id: "a1", organization_id: ORG, booking_id: "b1", profile_id: "tech-2", created_at: "2026-10-01" }] });
    const crew = await setCrew(fakeTenantContext(db, ORG, "owner"), "b1", ["owner", "tech-1"]);
    expect(crew.map((c) => c.profileId).sort()).toEqual(["owner", "tech-1"]);
    expect(db.tables.booking_assignments.map((r) => r.profile_id).sort()).toEqual(["owner", "tech-1"]);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0][2]).toEqual(["tech-1"]);
    expect(h.activity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "booking.crew_changed" }));
  });

  it("refuses someone who isn't on the team", async () => {
    const db = seed();
    await expect(setCrew(fakeTenantContext(db, ORG, "owner"), "b1", ["stranger"])).rejects.toThrow(/on your team/);
    expect(db.tables.booking_assignments).toHaveLength(0);
  });

  it("doesn't notify for a finished job", async () => {
    const db = seed({ bookings: [booking({ status: "completed" })] });
    await setCrew(fakeTenantContext(db, ORG, "owner"), "b1", ["tech-1"]);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("a job in another org is not found", async () => {
    const db = seed({ bookings: [booking({ organization_id: "org-2" })] });
    await expect(setCrew(fakeTenantContext(db, ORG, "owner"), "b1", [])).rejects.toThrow(/not found/i);
  });
});

describe("My Jobs", () => {
  it("lists jobs I'm on — directly or through a task — and not others", async () => {
    const db = seed({
      bookings: [booking(), booking({ id: "b2", title: "Winterize" }), booking({ id: "b3", title: "Detailing" })],
      booking_assignments: [{ id: "a1", organization_id: ORG, booking_id: "b1", profile_id: "tech-1", created_at: "2026-10-01" }],
      tasks: [{ id: "t1", organization_id: ORG, booking_id: "b2", assigned_to_profile_id: "tech-1" }],
    });
    const jobs = await listJobs(fakeTenantContext(db, ORG, "tech-1"), { scope: "mine", from: "2026-10-01T00:00:00.000Z", to: "2026-10-30T00:00:00.000Z" });
    expect(jobs.map((j) => j.id).sort()).toEqual(["b1", "b2"]);
    expect(jobs.every((j) => j.assignedToMe)).toBe(true);
    expect(jobs.find((j) => j.id === "b1")).toMatchObject({ contactName: "Pat Smith", companyName: "A1 Marine Care", location: "Wye Heritage Marina, C14" });
  });

  it("everyone view shows unassigned jobs with an empty crew", async () => {
    const db = seed();
    const [job] = await listJobs(fakeTenantContext(db, ORG, "owner"), { scope: "all", from: "2026-10-01T00:00:00.000Z", to: "2026-10-30T00:00:00.000Z" });
    expect(job.crew).toEqual([]);
    expect(job.assignedToMe).toBe(false);
  });
});

describe("field steps", () => {
  it("'On my way' fires booking.en_route once", async () => {
    const db = seed();
    const ctx = fakeTenantContext(db, ORG, "tech-1");
    await markEnRoute(ctx, "b1");
    await markEnRoute(ctx, "b1");
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.dispatch.mock.calls[0][1]).toMatchObject({ eventType: "booking.en_route", entityType: "booking", entityId: "b1" });
    expect(db.tables.bookings[0].en_route_at).toBeTruthy();
  });

  it("won't mark done with open checklist items unless forced", async () => {
    const db = seed({
      booking_checklist_items: [
        { id: "i1", organization_id: ORG, booking_id: "b1", label: "Wrap", position: 0, done_at: "2026-10-06T14:00:00Z", done_by: "tech-1" },
        { id: "i2", organization_id: ORG, booking_id: "b1", label: "Photos", position: 1, done_at: null, done_by: null },
      ],
    });
    const ctx = fakeTenantContext(db, ORG, "tech-1");
    await expect(completeJob(ctx, "b1")).rejects.toBeInstanceOf(ChecklistIncompleteError);
    expect(h.updateStatus).not.toHaveBeenCalled();

    await completeJob(ctx, "b1", { force: true });
    expect(db.tables.bookings[0]).toMatchObject({ completed_by: "tech-1" });
    expect(db.tables.bookings[0].started_at).toBeTruthy();
    expect(h.updateStatus).toHaveBeenCalledWith(ctx, { bookingId: "b1", status: "completed" });
  });

  it("can't start or finish a cancelled job", async () => {
    const db = seed({ bookings: [booking({ status: "cancelled" })] });
    await expect(completeJob(fakeTenantContext(db, ORG, "tech-1"), "b1")).rejects.toThrow(/cancelled/);
    await expect(markEnRoute(fakeTenantContext(db, ORG, "tech-1"), "b1")).rejects.toThrow(/cancelled/);
  });
});

describe("checklists", () => {
  it("applies a saved checklist without duplicating items already there", async () => {
    const db = seed({
      booking_checklist_items: [{ id: "i1", organization_id: ORG, booking_id: "b1", label: "Wrap", position: 0, done_at: null, done_by: null }],
      checklist_templates: [{ id: "tpl", organization_id: ORG, company_id: "co-1", name: "Shrink wrap", items: ["Wrap", "Install vents", "Photos"] }],
    });
    const items = await applyChecklistTemplate(fakeTenantContext(db, ORG, "owner"), "b1", "tpl");
    expect(items.map((i) => i.label)).toEqual(["Wrap", "Install vents", "Photos"]);
    expect(items.map((i) => i.position)).toEqual([0, 1, 2]);
  });

  it("won't apply another company's checklist", async () => {
    const db = seed({ checklist_templates: [{ id: "tpl", organization_id: ORG, company_id: "co-2", name: "X", items: ["A"] }] });
    await expect(applyChecklistTemplate(fakeTenantContext(db, ORG, "owner"), "b1", "tpl")).rejects.toThrow(/not found/i);
  });

  it("a saved checklist needs at least one real item", async () => {
    const db = seed();
    await expect(createTemplate(fakeTenantContext(db, ORG, "owner"), { companyId: "co-1", name: "Empty", items: ["  ", ""] })).rejects.toThrow(/at least one/);
  });
});

describe("My Jobs grouping", () => {
  const job = (id: string, scheduledFor: string, stage: JobSummary["stage"] = "scheduled") =>
    ({ id, scheduledFor, stage, timeZone: "America/Toronto" }) as JobSummary;
  const now = new Date("2026-10-06T14:00:00.000Z"); // 10 a.m. Tue in Toronto

  it("puts unfinished past work first, then today, tomorrow and later days", () => {
    const groups = groupJobsByDay(
      [
        job("late", "2026-10-05T13:00:00.000Z"),
        job("doneYesterday", "2026-10-05T15:00:00.000Z", "done"),
        job("today", "2026-10-06T18:00:00.000Z"),
        job("tonightUtcTomorrow", "2026-10-07T02:00:00.000Z"), // 10 p.m. Tue Toronto
        job("tomorrow", "2026-10-07T13:00:00.000Z"),
        job("thu", "2026-10-08T13:00:00.000Z"),
      ],
      now,
    );
    expect(groups.map((g) => g.label.split(",")[0])).toEqual(["Earlier — not done", "Today", "Tomorrow", "Thursday"]);
    expect(groups[1].jobs.map((j) => j.id)).toEqual(["today", "tonightUtcTomorrow"]);
    expect(groups.flatMap((g) => g.jobs).some((j) => j.id === "doneYesterday")).toBe(false);
  });
});
