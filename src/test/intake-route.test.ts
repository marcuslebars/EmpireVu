/**
 * Intake route — HMAC gate (extends the auth-boundary suite to the public intake route).
 * Proves: bad/missing signature -> 401 and NO write (handler not invoked); missing
 * secret -> 503; valid signature -> 200 with a write-only {ok, leadId} response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signIntakeBody } from "@/server/services/lead-intake/hmac";

const handleLeadIntake = vi.fn();
vi.mock("@/server/services/lead-intake/intake", () => ({
  handleLeadIntake: (...args: unknown[]) => handleLeadIntake(...args),
}));

import { POST } from "@/app/api/intake/route";

const SECRET = "test-secret";
const req = (body: string, sig?: string) =>
  new Request("http://test/api/intake", {
    method: "POST",
    headers: sig ? { "x-empirevu-signature": sig } : {},
    body,
  });

beforeEach(() => {
  handleLeadIntake.mockReset();
  handleLeadIntake.mockResolvedValue({ ok: true, leadId: "lead_test" });
  process.env.LEAD_INTAKE_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.LEAD_INTAKE_SECRET;
});

describe("intake route HMAC gate", () => {
  it("503 when the secret is not configured, and no write", async () => {
    delete process.env.LEAD_INTAKE_SECRET;
    const res = await POST(req(JSON.stringify({ a: 1 }), "sha256=x"));
    expect(res.status).toBe(503);
    expect(handleLeadIntake).not.toHaveBeenCalled();
  });

  it("401 on a bad signature, and no write", async () => {
    const res = await POST(req(JSON.stringify({ a: 1 }), "sha256=deadbeef"));
    expect(res.status).toBe(401);
    expect(handleLeadIntake).not.toHaveBeenCalled();
  });

  it("401 when the signature header is missing, and no write", async () => {
    const res = await POST(req(JSON.stringify({ a: 1 })));
    expect(res.status).toBe(401);
    expect(handleLeadIntake).not.toHaveBeenCalled();
  });

  it("200 with only {ok, leadId} on a valid signature", async () => {
    const body = JSON.stringify({ a: 1 });
    const res = await POST(req(body, signIntakeBody(body, SECRET)));
    expect(res.status).toBe(200);
    expect(handleLeadIntake).toHaveBeenCalledTimes(1);
    const json = await res.json();
    expect(Object.keys(json).sort()).toEqual(["leadId", "ok"]);
  });
});
