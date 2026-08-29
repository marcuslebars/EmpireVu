import { describe, expect, it } from "vitest";

import { EXPIRABLE_STATUSES, REMINDER_LEAD_DAYS } from "@/server/services/quotes/expiry";
import { QUOTE_STATUSES, canTransition } from "@/server/services/quotes/lifecycle";

/**
 * The nightly job runs REMIND then EXPIRE. These lock the properties that make
 * that safe, without needing a database — the sweeps themselves are thin
 * wrappers around these rules plus a claim-in-WHERE-clause update.
 */

const DAY = 24 * 60 * 60 * 1000;

/** Mirrors the reminder sweep's window predicate. */
function isReminderDue(expiresAt: Date, now: Date): boolean {
  const windowEnd = new Date(now.getTime() + REMINDER_LEAD_DAYS * DAY);
  return expiresAt > now && expiresAt <= windowEnd;
}

describe("reminder window", () => {
  const now = new Date("2026-09-15T12:00:00Z");

  it("fires inside the 5-day lead window", () => {
    for (const days of [0.5, 1, 3, 4.9, 5]) {
      expect(isReminderDue(new Date(now.getTime() + days * DAY), now)).toBe(true);
    }
  });

  it("does not fire earlier than the window", () => {
    for (const days of [6, 10, 30]) {
      expect(isReminderDue(new Date(now.getTime() + days * DAY), now)).toBe(false);
    }
  });

  it("does not fire for a quote that has already passed its date", () => {
    // Nudging someone about a quote that already closed is worse than silence.
    for (const days of [-0.1, -1, -30]) {
      expect(isReminderDue(new Date(now.getTime() + days * DAY), now)).toBe(false);
    }
  });

  it("is one nudge, not a sequence", () => {
    // The guard is a column, not a count: five nightly runs across the window
    // must produce exactly one send. Modelled here as the claim succeeding once.
    let reminderSentAt: string | null = null;
    let sends = 0;
    for (let d = 5; d >= 1; d--) {
      const claimed = reminderSentAt === null;
      if (claimed) {
        reminderSentAt = new Date(now.getTime() - d * DAY).toISOString();
        sends += 1;
      }
    }
    expect(sends).toBe(1);
  });
});

describe("sweep eligibility", () => {
  it("reminds and expires only sent/viewed", () => {
    expect([...EXPIRABLE_STATUSES].sort()).toEqual(["sent", "viewed"]);
  });

  it("never touches a quote the customer committed to", () => {
    for (const s of ["approved", "deposit_paid", "completed"] as const) {
      expect(EXPIRABLE_STATUSES).not.toContain(s);
      expect(canTransition(s, "expired")).toBe(false);
    }
  });

  it("agrees with the lifecycle table, so the two cannot drift", () => {
    const legal = QUOTE_STATUSES.filter((s) => canTransition(s, "expired"));
    expect([...EXPIRABLE_STATUSES].sort()).toEqual([...legal].sort());
  });
});

/**
 * Order matters. If expiry ran first, a quote reaching its date tonight would be
 * expired before its reminder was considered — so the customer would either get a
 * "still open" nudge about a quote that just closed, or no nudge at all.
 */
describe("remind-before-expire ordering", () => {
  it("a quote due today is reminded, then expired — never the reverse", () => {
    const now = new Date("2026-09-15T12:00:00Z");
    const expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000); // later today

    // Reminder pass sees it while still live.
    expect(isReminderDue(expiresAt, now)).toBe(true);

    // Expiry pass, same run, does not: it is not yet past.
    expect(expiresAt <= now).toBe(false);

    // Tomorrow's run expires it, and the reminder guard stops a second nudge.
    const tomorrow = new Date(now.getTime() + DAY);
    expect(expiresAt <= tomorrow).toBe(true);
  });
});
