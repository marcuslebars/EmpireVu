/**
 * Billing routes — server-side auth boundary (RLS-in-front proof, same approach as
 * auth-boundary.test.ts). Every billing route rejects an unauthenticated request
 * (401) and an authenticated non-member (403) with no `data`, before any billing
 * work runs. This is how "org A cannot touch org B's billing" is enforced at the
 * API layer (the DB RLS policies are the second line, verified in verify-billing.sql).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

let authState: { user: { id: string } | null; membership: Record<string, unknown> | null } = {
  membership: null,
  user: null,
};

vi.mock("@/server/supabase/server", () => ({
  createSupabaseServerClient: () => ({
    auth: {
      async getUser() {
        return authState.user
          ? { data: { user: authState.user }, error: null }
          : { data: { user: null }, error: { message: "no session" } };
      },
    },
    from() {
      const builder: Record<string, unknown> = {
        eq: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: authState.membership, error: null }),
        order: () => builder,
        select: () => builder,
        single: async () => ({
          data: authState.membership,
          error: authState.membership ? null : { message: "no rows" },
        }),
      };
      return builder;
    },
  }),
}));

import { GET as billingGET } from "@/app/api/organizations/[organizationId]/billing/route";
import { POST as checkoutPOST } from "@/app/api/organizations/[organizationId]/billing/checkout/route";
import { POST as portalPOST } from "@/app/api/organizations/[organizationId]/billing/portal/route";

const ORG = "22222222-2222-2222-2222-222222222222";
const ctx = { params: { organizationId: ORG } };
const getReq = () => new Request(`http://test/api/organizations/${ORG}/billing`);
const postReq = () =>
  new Request(`http://test/api/organizations/${ORG}/billing/x`, {
    body: JSON.stringify({ plan: "launch" }),
    method: "POST",
  });

const routes: Array<[string, () => Promise<Response>]> = [
  ["GET billing", () => billingGET(getReq(), ctx) as unknown as Promise<Response>],
  ["POST checkout", () => checkoutPOST(postReq(), ctx) as unknown as Promise<Response>],
  ["POST portal", () => portalPOST(postReq(), ctx) as unknown as Promise<Response>],
];

afterEach(() => {
  authState = { membership: null, user: null };
});

describe("billing routes — unauthenticated", () => {
  it.each(routes)("%s returns 401 with no data", async (_label, call) => {
    authState = { membership: null, user: null };
    const res = await call();
    expect(res.status).toBe(401);
    expect((await res.json()).data).toBeUndefined();
  });
});

describe("billing routes — authenticated non-member (org A user vs org B)", () => {
  it.each(routes)("%s returns 403 with no data", async (_label, call) => {
    authState = { membership: null, user: { id: "user-not-a-member" } };
    const res = await call();
    expect(res.status).toBe(403);
    expect((await res.json()).data).toBeUndefined();
  });
});
