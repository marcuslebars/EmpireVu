import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "./fake-supabase";
import { ensureAccessToken } from "@/server/services/jobber/oauth";
import type { JobberConfig } from "@/server/services/jobber/config";

const ORG = "org-1";
const cfg = {
  enabled: true,
  clientId: "id",
  clientSecret: "secret",
  redirectUri: "https://app.example.com/cb",
  graphqlVersion: "2025-01-20",
  scopes: "read_clients",
  authorizeUrl: "https://jobber.test/authorize",
  tokenUrl: "https://jobber.test/token",
  graphqlUrl: "https://jobber.test/graphql",
  deposit: {},
} as unknown as JobberConfig;

let db: FakeDb;
let tokenCalls: Array<Record<string, string>>;
let tokenResponse: () => Response;
let lockWon: boolean;
let rpcCalls: Array<[string, Record<string, unknown>]>;

const past = () => new Date(Date.now() - 60_000).toISOString();
const future = () => new Date(Date.now() + 3_600_000).toISOString();

function row() {
  return db.tables.jobber_connections[0];
}

beforeEach(() => {
  db = createFakeDb({
    jobber_connections: [
      {
        organization_id: ORG,
        access_token: "old-access",
        refresh_token: "old-refresh",
        token_expires_at: past(),
        refresh_lock_at: null,
        scope: "read_clients",
      },
    ],
  });
  lockWon = true;
  rpcCalls = [];
  (db.client as unknown as { rpc: unknown }).rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push([fn, args]);
    if (fn === "claim_jobber_token_refresh") {
      if (lockWon) row().refresh_lock_at = new Date().toISOString();
      return { data: lockWon, error: null };
    }
    return { data: null, error: { message: `unknown rpc ${fn}` } };
  });
  tokenCalls = [];
  tokenResponse = () =>
    new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }), { status: 200 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      tokenCalls.push(Object.fromEntries(new URLSearchParams(String(init.body))));
      return tokenResponse();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Jobber token refresh", () => {
  it("returns a fresh token without refreshing or locking", async () => {
    row().token_expires_at = future();
    expect(await ensureAccessToken(db.client as never, ORG, cfg)).toBe("old-access");
    expect(rpcCalls).toEqual([]);
    expect(tokenCalls).toEqual([]);
  });

  it("an expired token is refreshed: lock taken in SQL, rotated token saved, lock released", async () => {
    expect(await ensureAccessToken(db.client as never, ORG, cfg)).toBe("new-access");
    expect(rpcCalls).toEqual([["claim_jobber_token_refresh", { p_organization_id: ORG, p_stale_after_seconds: 30 }]]);
    expect(tokenCalls).toEqual([
      { client_id: "id", client_secret: "secret", grant_type: "refresh_token", refresh_token: "old-refresh" },
    ]);
    expect(row()).toMatchObject({ access_token: "new-access", refresh_token: "new-refresh", refresh_lock_at: null });
    expect(new Date(row().token_expires_at as string).getTime()).toBeGreaterThan(Date.now() + 3_000_000);
  });

  it("uses the refresh token as it is under the lock, not the one read before it", async () => {
    // Another worker rotated the token after our first read but its access token is
    // already near expiry — we must refresh with the newest refresh token.
    const rpc = (db.client as unknown as { rpc: (...a: unknown[]) => Promise<unknown> }).rpc;
    (db.client as unknown as { rpc: unknown }).rpc = vi.fn(async (...a: unknown[]) => {
      row().refresh_token = "rotated-by-other";
      return rpc(...a);
    });
    await ensureAccessToken(db.client as never, ORG, cfg);
    expect(tokenCalls[0].refresh_token).toBe("rotated-by-other");
  });

  it("if another worker finished refreshing just before we got the lock, its token is used", async () => {
    const rpc = (db.client as unknown as { rpc: (...a: unknown[]) => Promise<unknown> }).rpc;
    (db.client as unknown as { rpc: unknown }).rpc = vi.fn(async (...a: unknown[]) => {
      Object.assign(row(), { access_token: "other-access", refresh_token: "other-refresh", token_expires_at: future() });
      return rpc(...a);
    });
    expect(await ensureAccessToken(db.client as never, ORG, cfg)).toBe("other-access");
    expect(tokenCalls).toEqual([]);
    expect(row()).toMatchObject({ refresh_token: "other-refresh", refresh_lock_at: null });
  });

  it("when another worker holds the lock, waits for its fresh token instead of refreshing", async () => {
    vi.useFakeTimers();
    lockWon = false;
    const p = ensureAccessToken(db.client as never, ORG, cfg);
    await vi.advanceTimersByTimeAsync(500);
    Object.assign(row(), { access_token: "other-access", token_expires_at: future() });
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toBe("other-access");
    expect(tokenCalls).toEqual([]);
  });

  it("gives up after ~10s if the other refresh never lands", async () => {
    vi.useFakeTimers();
    lockWon = false;
    const p = ensureAccessToken(db.client as never, ORG, cfg);
    const done = expect(p).rejects.toThrow(/Timed out waiting for a concurrent Jobber token refresh/);
    await vi.advanceTimersByTimeAsync(10_500);
    await done;
  });

  it("a failed refresh releases the lock and keeps the old refresh token", async () => {
    tokenResponse = () => new Response("invalid_grant", { status: 400 });
    await expect(ensureAccessToken(db.client as never, ORG, cfg)).rejects.toThrow(/Jobber token endpoint 400: invalid_grant/);
    expect(row()).toMatchObject({ refresh_token: "old-refresh", refresh_lock_at: null });
  });

  it("a lock error is surfaced, not mistaken for a busy lock", async () => {
    (db.client as unknown as { rpc: unknown }).rpc = vi.fn(async () => ({ data: null, error: { message: "function missing" } }));
    await expect(ensureAccessToken(db.client as never, ORG, cfg)).rejects.toMatchObject({ message: "function missing" });
    expect(tokenCalls).toEqual([]);
  });

  it("not connected → clear message", async () => {
    db.tables.jobber_connections = [];
    await expect(ensureAccessToken(db.client as never, ORG, cfg)).rejects.toThrow(/Jobber is not connected/);
  });
});
