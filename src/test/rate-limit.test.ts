import { beforeEach, describe, expect, it, vi } from "vitest";

// A faithful in-memory stand-in for the consume_rate_limit SQL function, so we can
// exercise enforceRateLimit's full "allow N, then 429, then reset" path without a DB.
const h = vi.hoisted(() => {
  const buckets = new Map<string, { windowStart: number; hits: number }>();
  const state = { clock: 1_000_000, forceError: false };
  const rpc = vi.fn((name: string, args: { p_key: string; p_limit: number; p_window_seconds: number }) => {
    if (state.forceError) return Promise.resolve({ data: null, error: { message: "boom" } });
    if (name !== "consume_rate_limit") return Promise.resolve({ data: null, error: null });
    const now = state.clock;
    const existing = buckets.get(args.p_key);
    if (!existing || existing.windowStart <= now - args.p_window_seconds * 1000) {
      buckets.set(args.p_key, { windowStart: now, hits: 1 });
      return Promise.resolve({ data: 1 <= args.p_limit, error: null });
    }
    existing.hits += 1;
    return Promise.resolve({ data: existing.hits <= args.p_limit, error: null });
  });
  return { buckets, state, rpc, admin: { rpc } };
});

vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.admin }));

import { clientIp, enforceRateLimit, enforceWebhookBackstop } from "@/server/services/rate-limit";

function req(ip = "203.0.113.7"): Request {
  return new Request("https://api.empirevu.com/x", { headers: { "x-forwarded-for": `${ip}, 10.0.0.1` } });
}

beforeEach(() => {
  h.buckets.clear();
  h.state.clock = 1_000_000;
  h.state.forceError = false;
  h.rpc.mockClear();
});

describe("enforceRateLimit", () => {
  it("allows up to the limit, then returns a 429", async () => {
    const opts = { scope: "test", limit: 3, windowSeconds: 600, keyParts: ["1.2.3.4"] };

    expect(await enforceRateLimit(req(), opts)).toBeNull();
    expect(await enforceRateLimit(req(), opts)).toBeNull();
    expect(await enforceRateLimit(req(), opts)).toBeNull();

    const blocked = await enforceRateLimit(req(), opts);
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("Retry-After")).toBe("600");
  });

  it("resets once the window elapses", async () => {
    const opts = { scope: "test", limit: 1, windowSeconds: 600, keyParts: ["9.9.9.9"] };

    expect(await enforceRateLimit(req(), opts)).toBeNull(); // hit 1 — ok
    expect((await enforceRateLimit(req(), opts))?.status).toBe(429); // hit 2 — blocked

    h.state.clock += 601 * 1000; // advance past the window
    expect(await enforceRateLimit(req(), opts)).toBeNull(); // window reset — ok again
  });

  it("keys separate resources independently", async () => {
    const base = { scope: "s", limit: 1, windowSeconds: 600 };
    expect(await enforceRateLimit(req(), { ...base, keyParts: ["a"] })).toBeNull();
    // Different key → its own bucket, still allowed.
    expect(await enforceRateLimit(req(), { ...base, keyParts: ["b"] })).toBeNull();
    // Same key as the first → now blocked.
    expect((await enforceRateLimit(req(), { ...base, keyParts: ["a"] }))?.status).toBe(429);
  });

  it("fails OPEN when the limiter errors (never blocks a real caller)", async () => {
    h.state.forceError = true;
    const result = await enforceRateLimit(req(), { scope: "test", limit: 1, windowSeconds: 600, keyParts: ["x"] });
    expect(result).toBeNull();
  });

  it("merges response headers (e.g. CORS) into the 429", async () => {
    const opts = {
      scope: "cors",
      limit: 1,
      windowSeconds: 60,
      keyParts: ["k"],
      responseHeaders: { "Access-Control-Allow-Origin": "https://empirevu.com" },
    };
    await enforceRateLimit(req(), opts);
    const blocked = await enforceRateLimit(req(), opts);
    expect(blocked?.headers.get("Access-Control-Allow-Origin")).toBe("https://empirevu.com");
  });
});

describe("enforceWebhookBackstop", () => {
  it("uses a generous 600/min per-IP bucket keyed on the client IP", async () => {
    // 600 allowed within the minute; the 601st trips.
    let last: Response | null = null;
    for (let i = 0; i < 601; i++) {
      last = await enforceWebhookBackstop(req("198.51.100.5"), "retell_webhook");
    }
    expect(last?.status).toBe(429);
    // Sanity: the RPC was called with the 600/60s parameters.
    expect(h.rpc).toHaveBeenCalledWith(
      "consume_rate_limit",
      expect.objectContaining({ p_limit: 600, p_window_seconds: 60 }),
    );
  });
});

describe("clientIp", () => {
  it("takes the first x-forwarded-for hop", () => {
    expect(clientIp(req("192.0.2.1"))).toBe("192.0.2.1");
  });
  it("returns null when no forwarding header is present", () => {
    expect(clientIp(new Request("https://x/"))).toBeNull();
  });
});
