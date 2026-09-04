import { describe, expect, it, vi } from "vitest";

import {
  getCalendarView,
  getCRMContactsView,
  getDashboardActivityFeed,
  getDashboardSummary,
  getTasksListView,
  getWorkflowsListView,
  listAllRows,
} from "@/server/services/live-data";
import type { TenantServiceContext } from "@/server/services/shared";

/**
 * Task 3 read models.
 *
 * (1) The listAllRows tourniquet: PostgREST caps a response at 1,000 rows, so
 *     listAllRows now pages with `.range()` until a short page returns. The detail
 *     views still use it; this proves two pages are merged (no silent truncation).
 * (2) The rewritten list/summary endpoints read purpose-built views/RPCs. These
 *     tests mock the client and assert the call shape + the mapping onto the
 *     unchanged response type (no DB in this environment; the SQL itself is verified
 *     by the owner against seed data — see the PR/handoff).
 */

const ORG = "org-1";
type Row = Record<string, unknown>;

interface SupabaseStub {
  rpc?: Record<string, unknown[]>;
  tables?: Record<string, { rows?: Row[]; count?: number }>;
  onRpc?: (name: string, args: unknown) => void;
  onFrom?: (table: string) => void;
  onFilter?: (method: string, args: unknown[]) => void;
}

function makeSupabase(config: SupabaseStub) {
  return {
    rpc(name: string, args: unknown) {
      config.onRpc?.(name, args);
      return Promise.resolve({ data: config.rpc?.[name] ?? null, error: null });
    },
    from(table: string) {
      config.onFrom?.(table);
      const entry = config.tables?.[table] ?? {};
      const rows = entry.rows ?? [];
      const count = entry.count ?? rows.length;
      const record = (method: string) => (...args: unknown[]) => {
        config.onFilter?.(method, args);
        return chain;
      };
      const chain: Record<string, unknown> = {
        select: record("select"),
        eq: record("eq"),
        neq: record("neq"),
        in: record("in"),
        is: record("is"),
        not: record("not"),
        gte: record("gte"),
        lte: record("lte"),
        gt: record("gt"),
        lt: record("lt"),
        or: record("or"),
        ilike: record("ilike"),
        limit: record("limit"),
        order: record("order"),
        range: (from: number, to: number) =>
          Promise.resolve({ data: rows.slice(from, to + 1), count, error: null }),
        maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
        single: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
        then: (onfulfilled: (value: { data: Row[]; count: number; error: null }) => unknown) =>
          Promise.resolve({ data: rows, count, error: null }).then(onfulfilled),
      };
      return chain;
    },
  } as unknown as TenantServiceContext["supabase"];
}

function ctx(config: SupabaseStub): TenantServiceContext {
  return { organizationId: ORG, actorProfileId: null, supabase: makeSupabase(config) };
}

describe("listAllRows tourniquet — pages are merged", () => {
  it("merges two pages (1,500 rows) rather than truncating at 1,000", async () => {
    const rows: Row[] = Array.from({ length: 1500 }, (_, i) => ({ id: `r-${i}`, organization_id: ORG }));
    const merged = await listAllRows(ctx({ tables: { activity_events: { rows } } }), "activity_events");
    expect(merged.length).toBe(1500);
  });
});

describe("getDashboardSummary — reads ui_dashboard_summary", () => {
  it("calls the RPC scoped to the org and maps the counts", async () => {
    const onRpc = vi.fn();
    const result = await getDashboardSummary(
      ctx({
        rpc: {
          ui_dashboard_summary: [
            {
              active_workflow_count: 2,
              failed_workflow_job_count: 1,
              new_lead_count: 5,
              overdue_task_count: 3,
              revenue_today_cents: 1200,
              revenue_week_cents: 9800,
              today_booking_count: 4,
              upcoming_booking_count: 7,
              urgent_task_count: 2,
            },
          ],
        },
        onRpc,
      }),
      {},
    );
    expect(onRpc).toHaveBeenCalledWith("ui_dashboard_summary", { p_org_id: ORG, p_company_id: undefined });
    expect(result.newLeadCount).toBe(5);
    expect(result.revenueSnapshot).toEqual({ todayCents: 1200, weekCents: 9800 });
    expect(result.upcomingBookingCount).toBe(7);
  });
});

describe("getDashboardActivityFeed — SQL range + count", () => {
  it("returns the page and the total from count, not a JS slice of every row", async () => {
    const rows: Row[] = Array.from({ length: 3 }, (_, i) => ({
      id: `e-${i}`,
      company_id: null,
      entity_id: null,
      entity_type: "contact",
      related_entity_id: null,
      related_entity_type: null,
      event_type: "contact.created",
      metadata_json: {},
      occurred_at: "2026-01-01T00:00:00.000Z",
    }));
    const result = await getDashboardActivityFeed(
      ctx({ tables: { activity_events: { rows, count: 42 } } }),
      { page: 1, pageSize: 3 },
    );
    expect(result.pagination.total).toBe(42);
    expect(result.items).toHaveLength(3);
    expect(result.items[0].eventType).toBe("contact.created");
  });
});

describe("getCRMContactsView — reads ui_contact_list_v with trigram search", () => {
  it("maps a view row and issues an ilike on search_text", async () => {
    const onFilter = vi.fn();
    const viewRow: Row = {
      bookings_count: 2,
      company_id: "co-1",
      company_name: "A1",
      company_stage: "active",
      email: "a@b.com",
      id: "c-1",
      last_activity_at: "2026-01-02T00:00:00.000Z",
      last_activity_event_type: "contact.created",
      name: "Ada Lovelace",
      next_action_detail: "Call back",
      next_action_due_at: null,
      next_action_label: "Advance open task",
      next_action_type: "action",
      organization_id: ORG,
      owner_email: "owner@x.com",
      owner_full_name: "Owner One",
      owner_id: "u-1",
      owner_profile_id: "u-1",
      phone: "555",
      pipeline_value_cents: 5000,
      realized_revenue_cents: 12000,
      search_text: "ada lovelace",
      stage: "active",
      upcoming_bookings_count: 1,
    };
    const result = await getCRMContactsView(
      ctx({ tables: { ui_contact_list_v: { rows: [viewRow] } }, onFilter }),
      { page: 1, pageSize: 25, search: "ada" },
    );
    const ilikeCall = onFilter.mock.calls.find(([method]) => method === "ilike");
    expect(ilikeCall?.[1]).toEqual(["search_text", "%ada%"]);
    const row = result.rows.items[0];
    expect(row.name).toBe("Ada Lovelace");
    expect(row.company).toEqual({ id: "co-1", name: "A1", stage: "active" });
    expect(row.owner).toEqual({ id: "u-1", initials: "OO", name: "Owner One" });
    expect(row.realizedRevenueCents).toBe(12000);
    expect(row.nextAction.type).toBe("action");
    expect(result.pipelineSummary.find((s) => s.stage === "active")).toEqual({
      count: 1,
      stage: "active",
      valueCents: 5000,
    });
  });
});

describe("getTasksListView — reads ui_task_list_v", () => {
  it("maps a view row and derives the status summary", async () => {
    const viewRow: Row = {
      assigned_to_profile_id: "u-1",
      assignee_email: "u@x.com",
      assignee_full_name: "Tess Task",
      assignee_id: "u-1",
      booking_id: null,
      booking_title: null,
      comments_count: 3,
      company_id: "co-1",
      company_name: "A1",
      company_stage: "active",
      contact_company_id: null,
      contact_company_name: null,
      contact_company_stage: null,
      contact_email: null,
      contact_first_name: null,
      contact_last_name: null,
      contact_id: null,
      contact_phone: null,
      contact_stage: null,
      created_at: "2026-01-01T00:00:00.000Z",
      description: null,
      due_at: null,
      id: "t-1",
      is_overdue: true,
      organization_id: ORG,
      priority: "high",
      search_text: "fix",
      status: "in_progress",
      title: "Fix it",
      workflow_id: null,
      workflow_name: null,
    };
    const result = await getTasksListView(ctx({ tables: { ui_task_list_v: { rows: [viewRow] } } }), {
      page: 1,
      pageSize: 25,
    });
    expect(result.rows.items[0].title).toBe("Fix it");
    expect(result.rows.items[0].assignee).toEqual({ id: "u-1", initials: "TT", name: "Tess Task" });
    expect(result.rows.items[0].commentsCount).toBe(3);
    expect(result.summary.inProgressCount).toBe(1);
    expect(result.summary.overdueCount).toBe(1);
  });
});

describe("getWorkflowsListView — reads ui_workflow_list_v", () => {
  it("maps a view row with its run metrics", async () => {
    const viewRow: Row = {
      company_id: null,
      company_name: null,
      company_stage: null,
      created_at: "2026-01-01T00:00:00.000Z",
      description: "desc",
      failed_runs: 1,
      id: "w-1",
      last_run_at: "2026-01-02T00:00:00.000Z",
      last_run_status: "completed",
      name: "Welcome flow",
      organization_id: ORG,
      recent_runs_count: 4,
      status: "active",
      successful_runs: 3,
      total_runs: 4,
      trigger_type: "contact.created",
    };
    const result = await getWorkflowsListView(ctx({ tables: { ui_workflow_list_v: { rows: [viewRow] } } }), {
      page: 1,
      pageSize: 25,
    });
    const row = result.rows.items[0];
    expect(row.name).toBe("Welcome flow");
    expect(row.metrics).toEqual({ failedRuns: 1, successRate: 75, successfulRuns: 3, totalRuns: 4 });
    expect(row.recentRunSummary.recentRunsCount).toBe(4);
  });
});

describe("getCalendarView — reads ui_calendar_bookings", () => {
  it("calls the RPC with the window and maps a booking row", async () => {
    const onRpc = vi.fn();
    const result = await getCalendarView(
      ctx({
        rpc: {
          ui_calendar_bookings: [
            {
              id: "b-1",
              scheduled_for: "2026-06-01T10:00:00.000Z",
              duration_minutes: 60,
              status: "confirmed",
              title: "Haul out",
              description: null,
              company_id: "co-1",
              company_name: "A1",
              company_stage: "active",
              contact_id: "c-1",
              contact_name: "Ada",
              contact_email: null,
              contact_phone: null,
              contact_stage: "active",
              contact_company_id: null,
              contact_company_name: null,
              contact_company_stage: null,
              task_count: 0,
              highest_priority: null,
              assigned_profile_ids: [],
              revenue_cents: 25000,
            },
          ],
        },
        onRpc,
      }),
      { page: 1, pageSize: 25, start: "2026-06-01T00:00:00.000Z", end: "2026-06-30T00:00:00.000Z" },
    );
    expect(onRpc).toHaveBeenCalledWith("ui_calendar_bookings", {
      p_org_id: ORG,
      p_company_id: undefined,
      p_from_ts: "2026-06-01T00:00:00.000Z",
      p_to_ts: "2026-06-30T00:00:00.000Z",
    });
    const booking = result.bookings.items[0];
    expect(booking.title).toBe("Haul out");
    expect(booking.revenueCents).toBe(25000);
    expect(booking.company).toEqual({ id: "co-1", name: "A1", stage: "active" });
  });
});
