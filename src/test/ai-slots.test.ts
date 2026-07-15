/**
 * sanitizeProposedSlots — the server-side safety net over Claude's booking proposals.
 * The model is told the busy list, but double-booking a customer is a real-world
 * mess, so conflicts and past times are filtered here rather than trusted.
 */
import { describe, expect, it } from "vitest";

import { sanitizeProposedSlots, type SchedulingContext } from "@/server/ai/claude";

const NOW = "2026-07-15T12:00:00.000Z";

function scheduling(busy: SchedulingContext["busy"] = []): SchedulingContext {
  return { busy, nowIso: NOW, timezone: "America/Toronto" };
}

function slot(startsAt: string, durationMinutes = 60) {
  return { startsAt, durationMinutes, reason: "because" };
}

describe("sanitizeProposedSlots", () => {
  it("keeps a future slot with a free calendar", () => {
    const slots = [slot("2026-07-16T14:00:00.000Z")];
    expect(sanitizeProposedSlots(slots, scheduling())).toEqual(slots);
  });

  it("drops slots in the past", () => {
    const result = sanitizeProposedSlots([slot("2026-07-14T14:00:00.000Z")], scheduling());
    expect(result).toEqual([]);
  });

  it("drops a slot starting exactly now", () => {
    expect(sanitizeProposedSlots([slot(NOW)], scheduling())).toEqual([]);
  });

  it("drops slots with an unparseable timestamp", () => {
    expect(sanitizeProposedSlots([slot("next tuesday-ish")], scheduling())).toEqual([]);
  });

  it("drops a slot that overlaps an existing booking", () => {
    const busy = [{ startsAt: "2026-07-16T14:00:00.000Z", durationMinutes: 60, title: "Hull clean" }];
    // Proposed 14:30-15:30 straddles the 14:00-15:00 job.
    const result = sanitizeProposedSlots([slot("2026-07-16T14:30:00.000Z")], scheduling(busy));
    expect(result).toEqual([]);
  });

  it("drops a slot that fully contains an existing booking", () => {
    const busy = [{ startsAt: "2026-07-16T14:00:00.000Z", durationMinutes: 30, title: "Quick wax" }];
    const result = sanitizeProposedSlots([slot("2026-07-16T13:00:00.000Z", 180)], scheduling(busy));
    expect(result).toEqual([]);
  });

  it("keeps a slot that starts exactly when a booking ends (touching is not overlapping)", () => {
    const busy = [{ startsAt: "2026-07-16T14:00:00.000Z", durationMinutes: 60, title: "Hull clean" }];
    const proposed = [slot("2026-07-16T15:00:00.000Z")];
    expect(sanitizeProposedSlots(proposed, scheduling(busy))).toEqual(proposed);
  });

  it("keeps a slot that ends exactly when a booking starts", () => {
    const busy = [{ startsAt: "2026-07-16T15:00:00.000Z", durationMinutes: 60, title: "Hull clean" }];
    const proposed = [slot("2026-07-16T14:00:00.000Z")];
    expect(sanitizeProposedSlots(proposed, scheduling(busy))).toEqual(proposed);
  });

  it("filters only the conflicting slots and keeps the rest", () => {
    const busy = [{ startsAt: "2026-07-16T14:00:00.000Z", durationMinutes: 60, title: "Hull clean" }];
    const good = slot("2026-07-17T14:00:00.000Z");
    const result = sanitizeProposedSlots([slot("2026-07-16T14:15:00.000Z"), good], scheduling(busy));
    expect(result).toEqual([good]);
  });

  it("ignores busy entries with an unparseable start rather than dropping everything", () => {
    const busy = [{ startsAt: "whenever", durationMinutes: 60, title: "Mystery job" }];
    const proposed = [slot("2026-07-16T14:00:00.000Z")];
    expect(sanitizeProposedSlots(proposed, scheduling(busy))).toEqual(proposed);
  });
});
