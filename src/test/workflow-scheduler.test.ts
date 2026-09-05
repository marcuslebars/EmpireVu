import { describe, expect, it } from "vitest";

import { materializeDailyTicks } from "@/server/services/workflow-engine/scheduler";

/**
 * The once-per-slot guarantee is a DB unique(workflow_id, scheduled_for) + ON CONFLICT DO
 * NOTHING. This fake table enforces that constraint so we can prove the app half: the same
 * local day always resolves to the same slot, so a restart re-upserts the same row (no dup).
 */
function fakeAdmin(opts: { workflows: unknown[]; companyTz: string | null }) {
  const tickKeys = new Set<string>();
  const upsertRows: Array<Record<string, unknown>> = [];
  const admin = {
    from(table: string) {
      if (table === "workflows") {
        const api = {
          select: () => api,
          eq: () => api,
          in: () => Promise.resolve({ data: opts.workflows, error: null }),
        };
        return api;
      }
      if (table === "companies") {
        const api = {
          select: () => api,
          eq: () => api,
          maybeSingle: () =>
            Promise.resolve({ data: opts.companyTz ? { timezone: opts.companyTz } : null, error: null }),
        };
        return api;
      }
      if (table === "workflow_schedule_ticks") {
        return {
          upsert: (row: Record<string, unknown>) => {
            upsertRows.push(row);
            const key = `${row.workflow_id}|${row.scheduled_for}`;
            if (!tickKeys.has(key)) tickKeys.add(key); // ON CONFLICT DO NOTHING
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { admin: admin as never, tickKeys, upsertRows };
}

const dailyWorkflow = {
  id: "wf-1",
  organization_id: "org-1",
  company_id: "co-1",
  trigger_event: "schedule.daily",
  definition: { schedule: { daily_time: "08:00" } },
};

describe("materializeDailyTicks (schedule.daily)", () => {
  it("creates exactly one tick per slot across a restart on the same local day", async () => {
    const { admin, tickKeys, upsertRows } = fakeAdmin({ workflows: [dailyWorkflow], companyTz: "America/Toronto" });

    // First pass at 14:00 EDT, second pass at 15:00 EDT (as if the worker restarted).
    await materializeDailyTicks(admin, Date.parse("2026-07-15T18:00:00Z"));
    await materializeDailyTicks(admin, Date.parse("2026-07-15T19:00:00Z"));

    expect(tickKeys.size).toBe(1);
    expect(upsertRows).toHaveLength(2); // both passes attempt the upsert…
    // …but at the identical slot (08:00 America/Toronto = 12:00Z in summer), so it dedups.
    expect(new Set(upsertRows.map((r) => r.scheduled_for))).toEqual(new Set(["2026-07-15T12:00:00.000Z"]));
  });

  it("does not create a tick before the day's slot has arrived", async () => {
    const { admin, upsertRows } = fakeAdmin({ workflows: [dailyWorkflow], companyTz: "America/Toronto" });

    // 06:00 EDT — the 08:00 slot is still in the future.
    await materializeDailyTicks(admin, Date.parse("2026-07-15T10:00:00Z"));

    expect(upsertRows).toHaveLength(0);
  });

  it("falls back to the business timezone when the company has none", async () => {
    const { admin, upsertRows } = fakeAdmin({ workflows: [dailyWorkflow], companyTz: null });

    await materializeDailyTicks(admin, Date.parse("2026-07-15T23:00:00Z"));

    // Default BUSINESS_TIMEZONE is America/Toronto → 08:00 local = 12:00Z that day.
    expect(upsertRows[0]?.scheduled_for).toBe("2026-07-15T12:00:00.000Z");
  });
});
