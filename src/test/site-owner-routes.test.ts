import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

/**
 * Settings → Your website routes: org membership required, owner/admin to change anything, and
 * the company must belong to the org before any service-role write.
 */
let db: FakeDb;
let user: { id: string } | null = null;

vi.mock("@/server/services/usage", () => ({ recordAiUsageSafe: vi.fn(async () => undefined) }));
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => db.client }));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseServerClient: () => ({
    ...(db.client as unknown as Record<string, unknown>),
    from: (table: string) => (db.client as unknown as { from: (t: string) => unknown }).from(table),
    auth: {
      async getUser() {
        return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: "no session" } };
      },
    },
  }),
}));

import { GET, PATCH, POST } from "@/app/api/organizations/[organizationId]/companies/[companyId]/site/route";
import { GET as PREVIEW } from "@/app/api/organizations/[organizationId]/companies/[companyId]/site/preview/route";
import { snowCompany } from "@/server/services/dfy/__fixtures__/sample-sites";

const ORG = "org-1";
const ctx = (companyId = "c1") => ({ params: { organizationId: ORG, companyId } });
const req = (method: string, body?: unknown) =>
  new Request(`http://test/api/organizations/${ORG}/companies/c1/site`, { method, body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } });

function seed(role: string | null) {
  db = createFakeDb(
    {
      organization_memberships: role ? [{ id: "m1", organization_id: ORG, profile_id: "u1", role }] : [],
      profiles: [{ id: "u1", email: "o@example.com" }],
      organizations: [{ id: ORG, platform_brand: "crankleads", crankleads_tier: "close", subscription_status: "active" }],
      companies: [
        { id: "c1", organization_id: ORG, ...snowCompany.company, industry_pack: null, online_booking_settings: {}, quote_public_base_url: null },
        { id: "other", organization_id: "org-2", ...snowCompany.company, name: "Someone Else" },
      ],
      service_catalog_items: [],
      public_form_keys: [],
      company_sites: [],
    },
    { company_sites: [["slug"], ["company_id"]] },
  );
  user = { id: "u1" };
}

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "");
});

describe("site owner routes", () => {
  it("401 without a session, 403 for a non-member", async () => {
    seed(null);
    user = null;
    expect((await GET(req("GET"), ctx())).status).toBe(401);
    seed(null);
    expect((await GET(req("GET"), ctx())).status).toBe(403);
    expect((await POST(req("POST", { action: "publish" }), ctx())).status).toBe(403);
    expect((await PREVIEW(req("GET"), ctx())).status).toBe(403);
  });

  it("members can view but not change the site", async () => {
    seed("member");
    const view = await GET(req("GET"), ctx());
    expect(view.status).toBe(200);
    expect((await view.json()).data).toMatchObject({ site: null, canManage: false });
    expect((await POST(req("POST", { action: "generate" }), ctx())).status).toBe(403);
    expect((await PATCH(req("PATCH", { headline: "x" }), ctx())).status).toBe(403);
    expect(db.tables.company_sites).toHaveLength(0);
  });

  it("refuses a company from another org", async () => {
    seed("owner");
    const res = await POST(req("POST", { action: "generate" }), ctx("other"));
    expect(res.status).toBe(400);
    expect(db.tables.company_sites).toHaveLength(0);
  });

  it("owners generate, edit, publish (marking the owner as told) and unpublish", async () => {
    seed("owner");
    const gen = await POST(req("POST", { action: "generate" }), ctx());
    expect(gen.status).toBe(200);
    const view = (await gen.json()).data;
    expect(view.site).toMatchObject({ status: "draft", mode: "full", slug: "northshore-snow-and-property" });
    expect(view.site.previewUrl).toBe(`/api/organizations/${ORG}/companies/c1/site/preview`);

    const edit = await PATCH(req("PATCH", { headline: "Plowing done right", showPrices: false }), ctx());
    expect((await edit.json()).data.site).toMatchObject({ headline: "Plowing done right", showPrices: false, edited: { headline: true } });

    const preview = await PREVIEW(req("GET"), ctx());
    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).toContain("Plowing done right");
    expect(html).toContain('name="robots" content="noindex,nofollow"');

    const pub = await POST(req("POST", { action: "publish" }), ctx());
    expect((await pub.json()).data.site.status).toBe("published");
    expect(db.tables.company_sites[0].owner_notified_at).toBeTruthy();

    const unpub = await POST(req("POST", { action: "unpublish" }), ctx());
    expect((await unpub.json()).data.site.status).toBe("unpublished");
  });

  it("rejects unknown fields and actions", async () => {
    seed("admin");
    await POST(req("POST", { action: "generate" }), ctx());
    expect((await PATCH(req("PATCH", { status: "published" }), ctx())).status).toBe(400);
    expect((await POST(req("POST", { action: "delete" }), ctx())).status).toBe(400);
  });
});
