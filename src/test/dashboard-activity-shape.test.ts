import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchDashboardActivity } from "@/lib/api-client";

// Regression guard for the dashboard white-screen: the /ui/dashboard/activity
// endpoint returns a paginated envelope ({ items, pagination }), but the client
// treated it as a bare array and called .slice() on the object → "m.slice is not
// a function". fetchDashboardActivity must unwrap items and always return an array.
describe("fetchDashboardActivity unwraps the paginated envelope", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const mockJson = (payload: unknown) => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) } as Response),
    ) as never;
  };

  it("returns the items array, not the { items, pagination } object", async () => {
    const items = [
      {
        id: "evt-1",
        eventType: "contact_created",
        company: null,
        entity: null,
        metadata: {},
        occurredAt: "2026-07-10T00:00:00.000Z",
        relatedEntity: null,
      },
    ];
    mockJson({ data: { items, pagination: { page: 1, pageSize: 10, total: 1, totalPages: 1 } } });

    const result = await fetchDashboardActivity("org-1", { limit: 10 });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(items);
  });

  it("returns [] when the envelope carries no items", async () => {
    mockJson({ data: {} });
    const result = await fetchDashboardActivity("org-1");
    expect(result).toEqual([]);
  });
});
