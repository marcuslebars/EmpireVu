import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

// Email inbox settings route: GET (members read the switches; the address and emails are for
// owners/admins, made on first view) and PATCH (owners/admins, strict, merging ONLY
// ai_settings.email_clerk).
const h = vi.hoisted(() => ({ db: null as FakeDb | null, role: "owner" }));
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.db?.client }));
vi.mock("@/server/supabase/server", () => ({ createSupabaseServerClient: () => h.db?.client }));
vi.mock("@/server/outbound/sms", () => ({ sendSms: vi.fn(() => Promise.resolve({ sid: "SM1" })) }));
vi.mock("@/server/outbound/email", () => ({ sendEmail: vi.fn(() => Promise.resolve({ id: "re_1" })) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: vi.fn(), recordAiUsageSafe: vi.fn() }));
vi.mock("@/server/organizations/context", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/organizations/context")>();
  return {
    ...original,
    requireOrganizationContext: async (_s: unknown, organizationId: string) => ({ organizationId, user: { id: "user-1" }, membership: { role: h.role } }),
  };
});

import { GET, PATCH } from "@/app/api/organizations/[organizationId]/companies/[companyId]/ai-settings/email-clerk/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const ctx = { params: { organizationId: ORG, companyId: COMPANY } };

function seed(): FakeDb {
  return createFakeDb(
    {
      companies: [{ id: COMPANY, organization_id: ORG, name: "Northshore Roofing", slug: "northshore", timezone: "America/Toronto", stage: "active", ai_settings: { sms_agent: { autonomy: "ask_first" } }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }],
      organizations: [{ id: ORG, platform_brand: "crankleads" }],
      email_inboxes: [],
      inbound_emails: [],
    },
    { email_inboxes: [["company_id"], ["address"]] },
  );
}

const json = (res: Response) => res.json() as Promise<{ data?: Record<string, unknown>; error?: string }>;
const req = (method: string, body?: unknown) => new Request("http://x.test/", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  h.db = seed();
  h.role = "owner";
  process.env.INBOUND_EMAIL_DOMAIN = "in.crankleads.test";
  process.env.RESEND_WEBHOOK_SECRET = "whsec_c2VjcmV0";
});

afterEach(() => {
  delete process.env.INBOUND_EMAIL_DOMAIN;
  delete process.env.RESEND_WEBHOOK_SECRET;
});

describe("email inbox settings route", () => {
  it("GET: owners get the address (made once); members don't", async () => {
    h.role = "member";
    const member = await json(await GET(req("GET"), ctx));
    expect(member.data).toMatchObject({ configured: true, inbox: null, recent: null, settings: { enabled: true } });
    expect(h.db!.tables.email_inboxes).toHaveLength(0);
    h.role = "owner";
    const owner = await json(await GET(req("GET"), ctx));
    expect((owner.data?.inbox as { address: string }).address).toMatch(/^northshore-[a-z2-9]{8}@in\.crankleads\.test$/);
    await GET(req("GET"), ctx);
    expect(h.db!.tables.email_inboxes).toHaveLength(1);
  });

  it("GET without the server set up: says so, makes nothing", async () => {
    delete process.env.INBOUND_EMAIL_DOMAIN;
    const res = await json(await GET(req("GET"), ctx));
    expect(res.data).toMatchObject({ configured: false, inbox: null });
    expect(h.db!.tables.email_inboxes).toHaveLength(0);
  });

  it("PATCH: owners/admins only, strict, merges only ai_settings.email_clerk", async () => {
    h.role = "member";
    expect((await PATCH(req("PATCH", { enabled: false }), ctx)).status).toBe(403);
    h.role = "admin";
    expect((await PATCH(req("PATCH", { digestTime: "23:00" }), ctx)).status).toBe(400);
    expect((await PATCH(req("PATCH", { enabled: false, sneaky: 1 }), ctx)).status).toBe(400);
    const ok = await PATCH(req("PATCH", { digest: false, digestTime: "17:30" }), ctx);
    expect(ok.status).toBe(200);
    expect(h.db!.tables.companies[0].ai_settings).toEqual({ sms_agent: { autonomy: "ask_first" }, email_clerk: { digest: false, digest_time: "17:30", any_on: false } });
  });
});
