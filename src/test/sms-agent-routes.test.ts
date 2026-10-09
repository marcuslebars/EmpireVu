/**
 * Settings → AI front desk (PATCH merges only ai_settings.sms_agent; owners/admins only) and
 * the inbox "Take over" / "Let AI handle it" route.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

const ORG = "11111111-1111-1111-1111-111111111111";
const CO = "22222222-2222-2222-2222-222222222222";
const CONTACT = "33333333-3333-3333-3333-333333333333";

const h = vi.hoisted(() => ({ db: null as FakeDb | null, userId: "u-admin" }));

vi.mock("@/server/supabase/server", () => ({
  createSupabaseServerClient: () => {
    const client = h.db!.client as unknown as Record<string, unknown>;
    return { ...client, from: (t: string) => (client.from as (t: string) => unknown)(t), auth: { getUser: async () => ({ data: { user: { id: h.userId } }, error: null }) } };
  },
}));
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.db!.client }));

import { PATCH, GET } from "@/app/api/organizations/[organizationId]/companies/[companyId]/ai-settings/sms-agent/route";
import { POST as assistantPOST } from "@/app/api/organizations/[organizationId]/inbox/[contactId]/assistant/route";

function request(body: unknown, method = "PATCH") {
  return new Request("http://localhost/x", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

beforeEach(() => {
  h.userId = "u-admin";
  h.db = createFakeDb({
    organizations: [{ id: ORG, platform_brand: "crankleads" }],
    companies: [{ id: CO, organization_id: ORG, name: "Northshore", ai_settings: { call_answering: { mode: "ai" } } }],
    organization_memberships: [
      { organization_id: ORG, profile_id: "u-admin", role: "admin" },
      { organization_id: ORG, profile_id: "u-member", role: "member" },
    ],
    profiles: [{ id: "u-admin" }, { id: "u-member" }],
    contacts: [{ id: CONTACT, organization_id: ORG, company_id: CO, first_name: "Jane", phone: "+17055550123", sms_opt_out_at: null }],
    sms_conversations: [],
    message_log: [],
    owner_approvals: [],
  });
});

const params = { params: { organizationId: ORG, companyId: CO } };

describe("ai-settings/sms-agent", () => {
  it("GET shows the CrankLeads default (on, standard)", async () => {
    const res = await GET(new Request("http://localhost/x"), params);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({ enabled: true, autonomy: "standard", enabledIsDefault: true, defaultEnabled: true });
  });

  it("PATCH (admin) merges only the sms_agent section", async () => {
    const res = await PATCH(request({ enabled: false, autonomy: "ask_first" }), params);
    expect(res.status).toBe(200);
    expect(h.db!.tables.companies[0].ai_settings).toEqual({ call_answering: { mode: "ai" }, sms_agent: { enabled: false, autonomy: "ask_first" } });
  });

  it("PATCH is refused for a plain member and for unknown fields", async () => {
    h.userId = "u-member";
    expect((await PATCH(request({ enabled: false }), params)).status).toBe(403);
    h.userId = "u-admin";
    expect((await PATCH(request({ enabled: false, model: "x" }), params)).status).toBe(400);
    expect(h.db!.tables.companies[0].ai_settings).toEqual({ call_answering: { mode: "ai" } });
  });
});

describe("inbox assistant toggle", () => {
  it("Take over → owner; Let AI handle it → ai", async () => {
    const p = { params: { organizationId: ORG, contactId: CONTACT } };
    process.env.ANTHROPIC_API_KEY = "k";
    let res = await assistantPOST(request({ ai: false }, "POST"), p);
    expect((await res.json()).data).toMatchObject({ agentActive: true, state: "owner" });
    res = await assistantPOST(request({ ai: true }, "POST"), p);
    expect((await res.json()).data).toMatchObject({ state: "ai" });
  });
});
