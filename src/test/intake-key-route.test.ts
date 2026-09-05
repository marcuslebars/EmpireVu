/**
 * Intake route — key mode (Task 7). Proves the tenant is pinned by the KEY (the payload
 * can't override it), a revoked/unknown key → 401, a bad key-mode signature → 401, and
 * legacy mode still works unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signIntakeBody } from "@/server/services/lead-intake/hmac";

const handleLeadIntake = vi.fn();
vi.mock("@/server/services/lead-intake/intake", () => ({
  handleLeadIntake: (...args: unknown[]) => handleLeadIntake(...args),
}));

const resolveIntakeKey = vi.fn();
vi.mock("@/server/services/lead-intake/intake-keys", () => ({
  resolveIntakeKey: (...args: unknown[]) => resolveIntakeKey(...args),
}));

import { POST } from "@/app/api/intake/route";

const KEY = "evk_testkey123";
const SECRET = "legacy-secret";

function req(body: string, headers: Record<string, string>): Request {
  return new Request("http://test/api/intake", { method: "POST", headers, body });
}

beforeEach(() => {
  handleLeadIntake.mockReset().mockResolvedValue({ ok: true, leadId: "lead_test" });
  resolveIntakeKey.mockReset();
});
afterEach(() => {
  delete process.env.LEAD_INTAKE_SECRET;
});

describe("intake route — key mode", () => {
  it("pins the tenant from the KEY; the payload cannot choose org/company", async () => {
    resolveIntakeKey.mockResolvedValue({ id: "k1", organizationId: "org-K", companyId: "co-K" });
    // The payload tries to claim a different brand — it must be ignored for routing.
    const body = JSON.stringify({ sourceSite: "attacker-brand", contact: { email: "a@b.com" } });
    const res = await POST(
      req(body, { "x-empirevu-key": KEY, "x-empirevu-signature": signIntakeBody(body, KEY) }),
    );

    expect(res.status).toBe(200);
    expect(handleLeadIntake).toHaveBeenCalledTimes(1);
    // Third arg carries the pinned target — from the key, NOT the payload.
    expect(handleLeadIntake.mock.calls[0][2]).toEqual({
      target: { organizationId: "org-K", companyId: "co-K" },
    });
  });

  it("401 on a revoked/unknown key, and no write", async () => {
    resolveIntakeKey.mockResolvedValue(null);
    const body = JSON.stringify({ contact: {} });
    const res = await POST(
      req(body, { "x-empirevu-key": KEY, "x-empirevu-signature": signIntakeBody(body, KEY) }),
    );
    expect(res.status).toBe(401);
    expect(handleLeadIntake).not.toHaveBeenCalled();
  });

  it("401 when the key-mode signature doesn't match the key, and no write", async () => {
    resolveIntakeKey.mockResolvedValue({ id: "k1", organizationId: "org-K", companyId: "co-K" });
    const body = JSON.stringify({ contact: {} });
    // Signed with the wrong secret.
    const res = await POST(
      req(body, { "x-empirevu-key": KEY, "x-empirevu-signature": signIntakeBody(body, "not-the-key") }),
    );
    expect(res.status).toBe(401);
    expect(handleLeadIntake).not.toHaveBeenCalled();
  });

  it("legacy mode (no key header) still routes via LEAD_INTAKE_SECRET with no pinned target", async () => {
    process.env.LEAD_INTAKE_SECRET = SECRET;
    const body = JSON.stringify({ sourceSite: "a1marinestorage", contact: {} });
    const res = await POST(req(body, { "x-empirevu-signature": signIntakeBody(body, SECRET) }));

    expect(res.status).toBe(200);
    expect(handleLeadIntake).toHaveBeenCalledTimes(1);
    // No pinned target in legacy mode → sourceSite resolution (unchanged behavior).
    expect(handleLeadIntake.mock.calls[0][2]).toBeUndefined();
    expect(resolveIntakeKey).not.toHaveBeenCalled();
  });
});
