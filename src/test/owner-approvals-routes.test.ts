/** /api/organizations/:org/approvals (members read) and …/:id/decide (owners/admins only). */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ role: "owner", list: vi.fn(), decide: vi.fn() }));

vi.mock("@/server/supabase/server", () => ({ createSupabaseServerClient: () => ({}) }));
vi.mock("@/server/organizations/context", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/organizations/context")>();
  return {
    ...original,
    requireOrganizationContext: async (_s: unknown, organizationId: string) => ({ organizationId, user: { id: "user-1" }, membership: { role: h.role } }),
  };
});
vi.mock("@/server/services/owner-channel/app", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/services/owner-channel/app")>();
  return { ...original, listApprovalsForOrg: (...a: unknown[]) => h.list(...a), decideApprovalFromApp: (...a: unknown[]) => h.decide(...a) };
});

import { GET } from "@/app/api/organizations/[organizationId]/approvals/route";
import { POST } from "@/app/api/organizations/[organizationId]/approvals/[approvalId]/decide/route";

const ORG = "org-1";
const ID = "33333333-3333-4333-8333-333333333333";

function post(body: unknown, approvalId = ID) {
  return POST(new Request(`http://x/api/organizations/${ORG}/approvals/${approvalId}/decide`, { method: "POST", body: JSON.stringify(body) }), {
    params: { organizationId: ORG, approvalId },
  });
}

beforeEach(() => {
  h.role = "owner";
  h.list.mockReset().mockResolvedValue({ pending: [], recent: [] });
  h.decide.mockReset().mockResolvedValue({ outcome: "done", message: "Sent.", approval: null });
});

describe("approvals routes", () => {
  it("any member can list", async () => {
    h.role = "member";
    const res = await GET(new Request(`http://x/api/organizations/${ORG}/approvals`), { params: { organizationId: ORG } });
    expect(res.status).toBe(200);
    expect(h.list).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG }), { companyId: null });
  });

  it("owners/admins decide through the shared path", async () => {
    const res = await post({ decision: "approve" });
    expect(res.status).toBe(200);
    expect(h.decide).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG, actorProfileId: "user-1" }), ID, { decision: "approve" });
  });

  it("members can't decide", async () => {
    h.role = "member";
    const res = await post({ decision: "approve" });
    expect(res.status).toBe(403);
    expect(h.decide).not.toHaveBeenCalled();
  });

  it("validates the body and id; a foreign id is 404", async () => {
    expect((await post({ decision: "maybe" })).status).toBe(400);
    expect((await post({ decision: "skip" }, "not-a-uuid")).status).toBe(400);
    h.decide.mockResolvedValueOnce({ outcome: "not_found", message: "x", approval: null });
    expect((await post({ decision: "skip" })).status).toBe(404);
  });
});
