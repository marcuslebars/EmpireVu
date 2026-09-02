import { describe, expect, it } from "vitest";

import { getDashboardActivityFeed, getDashboardSummary } from "@/server/services/live-data";
import type { TenantServiceContext } from "@/server/services/shared";

/**
 * Task 3, step 1 — the listAllRows tourniquet.
 *
 * PostgREST caps a single response at 1,000 rows. listAllRows used to issue one
 * un-paged select, so any org with >1,000 rows in a table had its dashboard counts
 * and joins silently computed from only the first 1,000 rows. listAllRows now pages
 * with `.range()` until a short page returns. These tests prove the pages are merged:
 * with 1,500 rows the counts are exact, not clamped at 1,000.
 */

const ORG = "org-1";
const PAGE = 1000;

// A chainable stand-in for the Supabase query builder. Filters are no-ops (each test
// controls the row set per table); `.range(from, to)` slices, and awaiting without a
// range yields the whole set — enough to exercise listAllRows' paging and the
// incidental company/entity lookups the feed makes.
function fakeSupabase(rowsByTable: Record<string, Record<string, unknown>[]>) {
  const from = (table: string) => {
    const rows = rowsByTable[table] ?? [];
    const result = (data: unknown) => Promise.resolve({ data, error: null });
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      neq: () => chain,
      in: () => chain,
      is: () => chain,
      not: () => chain,
      gte: () => chain,
      lte: () => chain,
      gt: () => chain,
      lt: () => chain,
      order: () => chain,
      limit: () => chain,
      range: (start: number, end: number) => result(rows.slice(start, end + 1)),
      maybeSingle: () => result(rows[0] ?? null),
      single: () => result(rows[0] ?? null),
      // Awaited directly (no .range()): resolve to the full set.
      then: (onfulfilled: (value: { data: unknown; error: null }) => unknown) =>
        result(rows).then(onfulfilled),
    };
    return chain;
  };
  return { from } as unknown as TenantServiceContext["supabase"];
}

function ctx(rowsByTable: Record<string, Record<string, unknown>[]>): TenantServiceContext {
  return { organizationId: ORG, actorProfileId: null, supabase: fakeSupabase(rowsByTable) };
}

function activityEvents(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `evt-${i}`,
    organization_id: ORG,
    company_id: null,
    actor_user_id: null,
    entity_type: "contact",
    entity_id: null,
    related_entity_type: null,
    related_entity_id: null,
    event_type: "contact.created",
    metadata_json: {},
    occurred_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    created_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    updated_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
  }));
}

function leadContacts(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `c-${i}`,
    organization_id: ORG,
    company_id: null,
    first_name: `Lead ${i}`,
    last_name: null,
    email: null,
    phone: null,
    stage: "lead",
    owner_profile_id: null,
    metadata: {},
    notes: null,
    created_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    updated_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
  }));
}

describe("listAllRows tourniquet — pages are merged (no 1,000-row truncation)", () => {
  it("merges two pages of activity events (1,500) into the feed total", async () => {
    const events = activityEvents(1500);
    expect(events.length).toBeGreaterThan(PAGE); // spans two pages

    const result = await getDashboardActivityFeed(ctx({ activity_events: events }), {
      page: 1,
      pageSize: 25,
    });

    // Exact, not clamped to 1,000: pagination.total counts every merged row.
    expect(result.pagination.total).toBe(1500);
  });

  it("computes an exact dashboard count from 1,500 rows spanning two pages", async () => {
    const summary = await getDashboardSummary(ctx({ contacts: leadContacts(1500) }));
    expect(summary.newLeadCount).toBe(1500);
  });
});
