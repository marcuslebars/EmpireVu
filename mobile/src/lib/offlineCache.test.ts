import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: store.get(key) ?? null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => void store.set(key, value)),
    remove: vi.fn(async ({ key }: { key: string }) => void store.delete(key)),
  },
}));

import {
  clearQueryCache,
  hydrateQueryCache,
  setCacheOwner,
  startQueryCachePersistence,
  trimToBudget,
  usableSnapshot,
  type CacheSnapshot,
} from "@m/lib/offlineCache";

const KEY = "ev.query-cache";
const DAY = 24 * 60 * 60_000;

function query(key: unknown[], data: unknown, dataUpdatedAt: number) {
  return {
    queryKey: key,
    queryHash: JSON.stringify(key),
    state: { data, dataUpdatedAt, status: "success" as const, fetchStatus: "idle" as const },
  };
}

function snapshot(partial: Partial<CacheSnapshot> = {}): string {
  return JSON.stringify({
    schema: 1,
    userId: "user-1",
    savedAt: Date.now(),
    state: { mutations: [], queries: [query(["tasks"], [{ id: "t1" }], Date.now())] },
    ...partial,
  });
}

beforeEach(() => {
  store.clear();
  setCacheOwner(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("what may be restored", () => {
  it("restores this user's recent snapshot", () => {
    const now = Date.now();
    expect(usableSnapshot(snapshot(), { userId: "user-1", now })).not.toBeNull();
  });

  // A shared phone: signing out clears the cache, but a snapshot left by a crash
  // must never be handed to whoever signs in next.
  it("refuses a snapshot belonging to someone else", () => {
    expect(usableSnapshot(snapshot(), { userId: "user-2", now: Date.now() })).toBeNull();
  });

  it("refuses a snapshot older than the window", () => {
    const now = Date.now();
    const old = snapshot({ savedAt: now - 4 * DAY });
    expect(usableSnapshot(old, { userId: "user-1", now })).toBeNull();
    expect(usableSnapshot(snapshot({ savedAt: now - 2 * DAY }), { userId: "user-1", now })).not.toBeNull();
  });

  it("refuses a snapshot written by an older build", () => {
    expect(usableSnapshot(snapshot({ schema: 0 }), { userId: "user-1", now: Date.now() })).toBeNull();
  });

  it("treats unreadable storage as a cache miss", () => {
    for (const raw of [null, "", "{not json", "null", '{"schema":1}']) {
      expect(usableSnapshot(raw, { userId: "user-1", now: Date.now() }), String(raw)).toBeNull();
    }
  });

  it("drops any mutations that were stored", () => {
    const withMutations = JSON.stringify({
      schema: 1,
      userId: "user-1",
      savedAt: Date.now(),
      state: { mutations: [{ mutationKey: ["send"] }], queries: [] },
    });
    expect(usableSnapshot(withMutations, { userId: "user-1", now: Date.now() })?.state.mutations).toEqual([]);
  });
});

describe("staying inside the storage budget", () => {
  it("keeps the newest queries and drops the oldest", () => {
    const now = Date.now();
    const big = "x".repeat(400);
    const state = {
      mutations: [],
      queries: [query(["old"], big, now - 60_000), query(["new"], big, now), query(["mid"], big, now - 30_000)],
    };

    // A budget with room for two of the three, whatever the serialized size works out to.
    const budget = JSON.stringify(state.queries[0]).length * 2 + 10;
    const kept = trimToBudget(state, budget).queries.map((q) => q.queryKey[0]);
    expect(kept).toEqual(["new", "mid"]);
  });

  it("keeps everything when it all fits", () => {
    const now = Date.now();
    const state = { mutations: [], queries: [query(["a"], "1", now), query(["b"], "2", now - 1)] };
    expect(trimToBudget(state, 1_000_000).queries).toHaveLength(2);
  });
});

describe("hydrating a cold start", () => {
  it("puts the stored data back in the cache", async () => {
    store.set(KEY, snapshot());
    const client = new QueryClient();

    expect(await hydrateQueryCache(client, "user-1")).toBe(true);
    expect(client.getQueryData(["tasks"])).toEqual([{ id: "t1" }]);
  });

  it("leaves fresher data alone", async () => {
    const client = new QueryClient();
    client.setQueryData(["tasks"], [{ id: "fetched-just-now" }]);
    store.set(KEY, snapshot({ state: { mutations: [], queries: [query(["tasks"], [{ id: "stale" }], Date.now() - 60_000)] } }));

    await hydrateQueryCache(client, "user-1");
    expect(client.getQueryData(["tasks"])).toEqual([{ id: "fetched-just-now" }]);
  });

  it("deletes a snapshot it refuses to restore", async () => {
    store.set(KEY, snapshot({ userId: "someone-else" }));
    const client = new QueryClient();

    expect(await hydrateQueryCache(client, "user-1")).toBe(false);
    expect(store.has(KEY)).toBe(false);
  });
});

describe("persisting while signed in", () => {
  it("writes successful queries after the debounce", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const stop = startQueryCachePersistence(client);
    setCacheOwner("user-1");

    client.setQueryData(["bookings"], [{ id: "b1" }]);
    await vi.advanceTimersByTimeAsync(2_100);
    stop();

    const written = JSON.parse(store.get(KEY)!) as CacheSnapshot;
    expect(written.userId).toBe("user-1");
    expect(written.state.queries.map((q) => q.queryKey)).toEqual([["bookings"]]);
  });

  it("writes nothing while nobody is signed in", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const stop = startQueryCachePersistence(client);

    client.setQueryData(["bookings"], [{ id: "b1" }]);
    await vi.advanceTimersByTimeAsync(2_100);
    stop();

    expect(store.has(KEY)).toBe(false);
  });

  it("forgets everything on sign-out", async () => {
    store.set(KEY, snapshot());
    await clearQueryCache();
    expect(store.has(KEY)).toBe(false);

    // And the writer stays quiet afterwards, even if a screen unmounts and the
    // cache changes on the way out.
    vi.useFakeTimers();
    const client = new QueryClient();
    const stop = startQueryCachePersistence(client);
    client.setQueryData(["tasks"], [{ id: "t1" }]);
    await vi.advanceTimersByTimeAsync(2_100);
    stop();
    expect(store.has(KEY)).toBe(false);
  });
});
