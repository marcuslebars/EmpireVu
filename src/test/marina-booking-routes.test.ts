import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  runAvailability: vi.fn(),
  runBook: vi.fn(),
  runDepositLink: vi.fn(),
}));

vi.mock("@/server/services/retell/config", () => ({
  getRetellConfig: () => ({ enabled: true, outboundEnabled: false, apiKey: "k", toleranceMs: 300_000, sourceSite: "x", leadSource: "y" }),
}));
vi.mock("@/server/services/retell/tools/booking", () => h);

import { POST as availability } from "@/app/api/retell/functions/availability/route";
import { POST as book } from "@/app/api/retell/functions/book/route";
import { POST as depositLink } from "@/app/api/retell/functions/deposit-link/route";

const SECRET = "s3cret-s3cret-s3cret";
const post = (body: unknown, secret?: string) =>
  new Request("https://x/api/retell/functions/t", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(secret ? { "x-empirevu-retell-secret": secret } : {}) },
  });

beforeEach(() => {
  process.env.RETELL_FUNCTION_SECRET = SECRET;
  for (const f of Object.values(h)) f.mockReset();
});

describe.each([
  ["availability", availability, h.runAvailability],
  ["book", book, h.runBook],
  ["deposit-link", depositLink, h.runDepositLink],
] as const)("POST /api/retell/functions/%s", (_name, route, tool) => {
  it("rejects a call without the shared secret", async () => {
    const res = await route(post({ args: {} }));
    expect(res.status).toBe(401);
    expect(tool).not.toHaveBeenCalled();
  });

  it("passes the parsed call through and returns the tool's answer", async () => {
    tool.mockResolvedValue({ ok: true, say: "done" });
    const res = await route(post({ args: { quote_id: "q" }, call: { call_id: "c1", to_number: "+17059961010" } }, SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, say: "done" });
    expect(tool.mock.calls[0][0]).toMatchObject({ args: { quote_id: "q" }, call: { callId: "c1", toNumber: "+17059961010" } });
  });

  it("answers with a line to say if the tool throws", async () => {
    tool.mockRejectedValue(new Error("boom"));
    const res = await route(post({ args: {} }, SECRET));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, say: expect.any(String) });
  });
});
