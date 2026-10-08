/**
 * /api/public/forward/:token — rate limits: per IP (first, so malformed / guessed tokens count
 * too) and per token. A limited request never reaches the database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const enforceRateLimit = vi.fn();
vi.mock("@/server/services/rate-limit", () => ({
  clientIp: () => "203.0.113.9",
  trustedClientIp: () => "203.0.113.9",
  enforceRateLimit: (...args: unknown[]) => enforceRateLimit(...args),
}));
const pollForwardPage = vi.fn();
const recordForwardAction = vi.fn();
vi.mock("@/server/services/dfy/forwarding", () => ({
  pollForwardPage: (...a: unknown[]) => pollForwardPage(...a),
  recordForwardAction: (...a: unknown[]) => recordForwardAction(...a),
}));
vi.mock("@/server/services/dfy/orchestrator", () => ({ forwardingHelpHandler: () => async () => undefined }));
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => ({}) }));

import { GET, POST } from "@/app/api/public/forward/[token]/route";

const TOKEN = "A".repeat(32);
const ctx = (token = TOKEN) => ({ params: { token } });

beforeEach(() => {
  enforceRateLimit.mockReset();
  pollForwardPage.mockReset();
  recordForwardAction.mockReset();
  enforceRateLimit.mockResolvedValue(null);
  pollForwardPage.mockResolvedValue({ status: "ready" });
  recordForwardAction.mockResolvedValue({ status: "ready" });
});

describe("forward page rate limits", () => {
  it("GET: per-IP limit first (even for a malformed token), then per token", async () => {
    await GET(new Request(`https://app.test/api/public/forward/nope`), ctx("nope"));
    expect(enforceRateLimit.mock.calls.map((c) => (c[1] as { scope: string }).scope)).toEqual(["dfy_forward_view_ip"]);
    enforceRateLimit.mockClear();
    await GET(new Request(`https://app.test/api/public/forward/${TOKEN}`), ctx());
    expect(enforceRateLimit.mock.calls.map((c) => (c[1] as { scope: string; keyParts: string[] }).scope)).toEqual(["dfy_forward_view_ip", "dfy_forward_view"]);
    expect((enforceRateLimit.mock.calls[0][1] as { keyParts: string[] }).keyParts).toEqual(["203.0.113.9"]);
  });

  it("an IP over the limit is refused before any lookup", async () => {
    enforceRateLimit.mockResolvedValueOnce(NextResponse.json({ error: "slow down" }, { status: 429 }));
    const res = await POST(
      new Request(`https://app.test/api/public/forward/${TOKEN}`, { method: "POST", body: JSON.stringify({ action: "tapped" }), headers: { "content-type": "application/json" } }),
      ctx(),
    );
    expect(res.status).toBe(429);
    expect((enforceRateLimit.mock.calls[0][1] as { scope: string }).scope).toBe("dfy_forward_action_ip");
    expect(recordForwardAction).not.toHaveBeenCalled();
  });
});
