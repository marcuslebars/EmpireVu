/**
 * /api/health — the Railway probe. Proves the 200 shape with a reachable DB and
 * mocked worker stats, and a 503 when the DB reachability probe errors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Anon DB probe: `.from("organizations").select("id").limit(1)` -> { error }.
const anonLimit = vi.fn();
// Admin worker stats: two shapes off `.from(table)`:
//   queued  -> `.select(...).eq("status","pending")` awaited      -> { count }
//   claimed -> `.select(...).not(...).order(...).limit(1).maybeSingle()` -> { data }
const adminFrom = vi.fn();

vi.mock("@/server/supabase/server", () => ({
  createSupabaseServerClient: () => ({
    from: () => ({ select: () => ({ limit: (...a: unknown[]) => anonLimit(...a) }) }),
  }),
}));
vi.mock("@/server/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ from: (...a: unknown[]) => adminFrom(...a) }),
}));

import { GET } from "@/app/api/health/route";

function jobBuilder(claimed: { locked_at: string | null } | null, count: number) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    not: () => builder,
    order: () => builder,
    limit: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: claimed, error: null }),
    // thenable: the queued query awaits the builder directly after `.eq(...)`.
    then: (resolve: (v: { count: number; error: null }) => void) => resolve({ count, error: null }),
  };
  return builder;
}

beforeEach(() => {
  anonLimit.mockReset();
  anonLimit.mockResolvedValue({ data: [], error: null });
  adminFrom.mockReset();
  adminFrom.mockImplementation((table: string) => {
    const per: Record<string, [{ locked_at: string | null } | null, number]> = {
      workflow_event_jobs: [{ locked_at: "2026-09-01T10:00:00.000Z" }, 2],
      billing_event_jobs: [{ locked_at: null }, 0],
    };
    const [claimed, count] = per[table] ?? [null, 0];
    return jobBuilder(claimed, count);
  });
  delete process.env.RAILWAY_GIT_COMMIT_SHA;
});
afterEach(() => {
  delete process.env.RAILWAY_GIT_COMMIT_SHA;
});

describe("GET /api/health", () => {
  it("returns 200 with the full shape when the DB is reachable", async () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = "abc123";
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.db).toBe("ok");
    expect(body.version).toBe("abc123");
    expect(body.workers.workflow_events).toEqual({
      last_claimed_at: "2026-09-01T10:00:00.000Z",
      queued: 2,
    });
    expect(body.workers.billing_events).toEqual({ last_claimed_at: null, queued: 0 });
    expect(Object.keys(body.workers).sort()).toEqual(["billing_events", "inbound_webhooks", "workflow_events"]);
  });

  it("defaults version to 'unknown' when unset", async () => {
    const res = await GET();
    expect((await res.json()).version).toBe("unknown");
  });

  it("returns 503 when the DB reachability probe errors", async () => {
    anonLimit.mockResolvedValue({ data: null, error: { message: "connection refused" } });
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.db).toBe("error");
    expect(body.workers).toBeNull();
  });

  it("stays 200 with null workers if the DB is up but worker stats fail", async () => {
    adminFrom.mockImplementation(() => {
      throw new Error("stats blew up");
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.db).toBe("ok");
    expect(body.workers).toBeNull();
  });
});
