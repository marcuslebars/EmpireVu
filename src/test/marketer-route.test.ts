import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

// Settings → AI front desk → Marketer: GET for members, PATCH for owners/admins, merging ONLY
// companies.ai_settings.marketing.
const h = vi.hoisted(() => ({ db: null as FakeDb | null, role: "owner" }));
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.db?.client }));
vi.mock("@/server/supabase/server", () => ({ createSupabaseServerClient: () => h.db?.client }));
vi.mock("@/server/organizations/context", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/organizations/context")>();
  return {
    ...original,
    requireOrganizationContext: async (_s: unknown, organizationId: string) => ({ organizationId, user: { id: "user-1" }, membership: { role: h.role } }),
  };
});

import { GET, PATCH } from "@/app/api/organizations/[organizationId]/companies/[companyId]/ai-settings/marketing/route";
import { POST as STOP } from "@/app/api/organizations/[organizationId]/companies/[companyId]/ai-settings/marketing/stop/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const OTHER = "66666666-6666-4666-8666-666666666666";
const ctx = { params: { organizationId: ORG, companyId: COMPANY } };

function seed(brand: string): FakeDb {
  return createFakeDb({
    companies: [
      {
        id: COMPANY, organization_id: ORG, name: "Northshore Roofing", timezone: "America/Toronto", stage: "active", google_place_id: null, google_rating: null, google_review_count: null,
        ai_settings: { sms_agent: { autonomy: "ask_first" } }, updated_at: "2026-10-01T00:00:00Z",
      },
    ],
    organizations: [{ id: ORG, platform_brand: brand }],
    marketing_campaigns: [{ id: "camp-1", organization_id: ORG, company_id: COMPANY, kind: "win_back", status: "sending", created_at: "2026-10-10T00:00:00Z", audience_count: 2, approval_id: null }],
    marketing_campaign_recipients: [
      { id: "r-1", organization_id: ORG, company_id: COMPANY, campaign_id: "camp-1", contact_id: "c-1", status: "sent", sent_at: "2026-10-10T15:00:00Z", created_at: "2026-10-10T00:00:00Z" },
      { id: "r-2", organization_id: ORG, company_id: COMPANY, campaign_id: "camp-1", contact_id: "c-2", status: "queued", created_at: "2026-10-10T00:00:00Z" },
    ],
    google_reviews: [],
    google_post_drafts: [],
  });
}

const patch = (body: unknown, companyId = COMPANY) =>
  PATCH(new Request("http://x/api", { method: "PATCH", body: JSON.stringify(body) }), { params: { organizationId: ORG, companyId } });

beforeEach(() => {
  h.db = seed("crankleads");
  h.role = "owner";
});

describe("/ai-settings/marketing route", () => {
  it("GET: CrankLeads defaults on; house org defaults off", async () => {
    const res = await GET(new Request("http://x/api"), ctx);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({ crankleads: true, canManage: true, settings: { winBack: { enabled: true, monthsMin: 9, monthsMax: 24 }, reviewReplies: { enabled: true }, googlePosts: { enabled: true } }, lastCampaign: { active: true, sent: 1, queued: 1 } });
    h.db = seed("empirevu");
    h.role = "member";
    const house = (await (await GET(new Request("http://x/api"), ctx)).json()).data;
    expect(house).toMatchObject({ crankleads: false, canManage: false, settings: { winBack: { enabled: false }, reviewReplies: { enabled: false }, googlePosts: { enabled: false } } });
  });

  it("PATCH (owner/admin) merges ONLY ai_settings.marketing", async () => {
    const res = await patch({ winBack: { enabled: false, monthsMin: 12 }, googlePosts: { enabled: false } });
    expect(res.status).toBe(200);
    expect((await res.json()).data.settings.winBack).toMatchObject({ enabled: false, monthsMin: 12 });
    expect(h.db!.tables.companies[0].ai_settings).toEqual({
      sms_agent: { autonomy: "ask_first" },
      marketing: { win_back: { enabled: false, months_min: 12 }, google_posts: { enabled: false } },
    });
  });

  it("refuses members, unknown fields, a window past 24 months, and other orgs' companies", async () => {
    h.role = "member";
    expect((await patch({ winBack: { enabled: false } })).status).toBe(403);
    h.role = "admin";
    expect((await patch({ winBack: { perHour: 500 } })).status).toBe(400);
    expect((await patch({ winBack: { monthsMax: 36 } })).status).toBe(400);
    expect((await patch({ winBack: { monthsMin: 12, monthsMax: 10 } })).status).toBe(400);
    expect((await patch({ winBack: { enabled: false } }, OTHER)).status).toBeGreaterThanOrEqual(400);
    expect(h.db!.tables.companies[0].ai_settings).toEqual({ sms_agent: { autonomy: "ask_first" } });
  });

  it("POST /stop (owner/admin): cancels the active campaign and skips what's queued; members can't", async () => {
    h.role = "member";
    expect((await STOP(new Request("http://x/api", { method: "POST" }), ctx)).status).toBe(403);
    expect(h.db!.tables.marketing_campaigns[0].status).toBe("sending");
    h.role = "owner";
    const res = await STOP(new Request("http://x/api", { method: "POST" }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).data.lastCampaign).toMatchObject({ active: false, status: "cancelled", sent: 1, skipped: 1 });
    expect(h.db!.tables.marketing_campaign_recipients.map((r) => r.status)).toEqual(["sent", "skipped"]);
  });
});
