/**
 * Server-side auth boundary test.
 *
 * Since the consolidation reduced the middleware to session-refresh only (no
 * server-side redirects), the SPA's client-side ProtectedRoute is cosmetic — the
 * REAL access boundary is the API layer. This proves it: every data-bearing route
 * rejects an unauthenticated request (401) and an authenticated non-member request
 * (403), returning no `data`, entirely server-side.
 *
 * The Supabase server client is mocked so `auth.getUser()` and the
 * organization_memberships lookup are the only I/O; on the reject paths the route's
 * data services are never reached (requireOrganizationContext throws first).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

let authState: { user: { id: string } | null; membership: Record<string, unknown> | null } = {
  user: null,
  membership: null,
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
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        in: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: authState.membership, error: null }),
        single: async () => ({
          data: authState.membership,
          error: authState.membership ? null : { message: "no rows" },
        }),
        then: (onF: (v: { data: unknown[]; error: null }) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(onF),
      };
      return builder;
    },
  }),
}));

// Route handlers are imported AFTER the mock is registered.
import { GET as sessionContextGET } from "@/app/api/session/context/route";
import { GET as crmContactsGET } from "@/app/api/organizations/[organizationId]/ui/crm/contacts/route";
import { GET as tasksGET } from "@/app/api/organizations/[organizationId]/ui/tasks/route";
import { GET as dashboardSummaryGET } from "@/app/api/organizations/[organizationId]/ui/dashboard/summary/route";
import { GET as bareContactsGET } from "@/app/api/organizations/[organizationId]/contacts/route";

const ORG = "11111111-1111-1111-1111-111111111111";
const ctx = { params: { organizationId: ORG } };
const req = () => new Request(`http://test/api/organizations/${ORG}/x`);

// Org-scoped, data-bearing GET routes guarded by requireOrganizationContext.
const orgScopedRoutes: Array<[string, () => Promise<Response>]> = [
  ["ui/crm/contacts", () => crmContactsGET(req(), ctx) as unknown as Promise<Response>],
  ["ui/tasks", () => tasksGET(req(), ctx) as unknown as Promise<Response>],
  ["ui/dashboard/summary", () => dashboardSummaryGET(req(), ctx) as unknown as Promise<Response>],
  ["contacts (bare)", () => bareContactsGET(req(), ctx) as unknown as Promise<Response>],
];

afterEach(() => {
  authState = { user: null, membership: null };
});

describe("API auth boundary — unauthenticated (no session)", () => {
  it("session/context returns 401 with no data", async () => {
    authState = { user: null, membership: null };
    const res = (await sessionContextGET()) as unknown as Response;
    expect(res.status).toBe(401);
    expect((await res.json()).data).toBeUndefined();
  });

  it.each(orgScopedRoutes)("%s returns 401 with no data", async (_label, call) => {
    authState = { user: null, membership: null };
    const res = await call();
    expect(res.status).toBe(401);
    expect((await res.json()).data).toBeUndefined();
  });
});

describe("API auth boundary — authenticated non-member", () => {
  it.each(orgScopedRoutes)("%s returns 403 with no data", async (_label, call) => {
    authState = { user: { id: "user-not-a-member" }, membership: null };
    const res = await call();
    expect(res.status).toBe(403);
    expect((await res.json()).data).toBeUndefined();
  });
});
