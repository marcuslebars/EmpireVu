import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

// Service plans routes: Settings (GET members — no customer list / PATCH + POST owners+admins,
// merging ONLY ai_settings.service_plans; house orgs refused) and the public plans pages + the
// sign-up form (slug-scoped, bot checks).
const h = vi.hoisted(() => ({ db: null as FakeDb | null, role: "owner" }));
const sendSms = vi.fn((..._a: unknown[]) => Promise.resolve({ sid: "SM1" }));
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.db?.client }));
vi.mock("@/server/supabase/server", () => ({ createSupabaseServerClient: () => h.db?.client }));
vi.mock("@/server/outbound/sms", () => ({ sendSms: (...a: unknown[]) => sendSms(...a) }));
vi.mock("@/server/outbound/email", () => ({ sendEmail: vi.fn(() => Promise.resolve({ id: "re_1" })) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: vi.fn(), recordAiUsageSafe: vi.fn() }));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({ emitActivityEventAndDispatch: vi.fn(() => Promise.resolve({})) }));
vi.mock("@/server/organizations/context", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/organizations/context")>();
  return {
    ...original,
    requireOrganizationContext: async (_s: unknown, organizationId: string) => ({ organizationId, user: { id: "user-1" }, membership: { role: h.role } }),
  };
});

import { GET, PATCH, POST } from "@/app/api/organizations/[organizationId]/companies/[companyId]/ai-settings/service-plans/route";
import { GET as LIST } from "@/app/s/[slug]/plans/route";
import { GET as PLAN, POST as SIGNUP } from "@/app/s/[slug]/plans/[planId]/route";
import { GET as RENEW } from "@/app/s/[slug]/plans/renew/[token]/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const PLAN_ID = "55555555-5555-4555-8555-555555555551";
const ctx = { params: { organizationId: ORG, companyId: COMPANY } };

function seed(brand = "crankleads"): FakeDb {
  const db = createFakeDb({
    companies: [{ id: COMPANY, organization_id: ORG, name: "Northshore Lawn", timezone: "America/Toronto", stage: "active", ai_settings: { sms_agent: { autonomy: "ask_first" } }, owner_phone_e164: "+17055559999", owner_phone_verified_at: "2026-10-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }],
    organizations: [{ id: ORG, platform_brand: brand }],
    service_plans: [{ id: PLAN_ID, organization_id: ORG, company_id: COMPANY, name: "Spring + Fall Lawn Care", description: null, price_cents: 9500, billing: "per_visit", visit_months: [5, 10], weekday: 2, week_of_month: 1, time_of_day: "09:00", duration_minutes: 60, included: [], active: true, created_at: "2026-09-01T00:00:00Z" }],
    service_agreements: [],
    service_plan_messages: [],
    contacts: [],
    owner_approvals: [],
    message_log: [],
    company_sites: [{ id: "s1", organization_id: ORG, company_id: COMPANY, slug: "northshore", status: "published", content: { version: 1, mode: "full", facts: { name: "Northshore Lawn", brand, tradeId: "landscaping" }, copy: { faqs: [], serviceBlurbs: {} } } }],
    voice_numbers: [{ organization_id: ORG, company_id: COMPANY, provider: "twilio", active: true, phone_e164: "+17055550111", mode: "missed_call_catcher" }],
    platform_sms_opt_outs: [],
  });
  db.onRpc(() => ({ data: true, error: null })); // rate limits: allowed
  return db;
}

const patch = (body: unknown) => PATCH(new Request("http://x/api", { method: "PATCH", body: JSON.stringify(body) }), ctx);
const post = (body: unknown) => POST(new Request("http://x/api", { method: "POST", body: JSON.stringify(body) }), ctx);

function signupRequest(fields: Record<string, string> = {}): Request {
  return new Request(`http://x/s/northshore/plans/${PLAN_ID}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.9" },
    body: new URLSearchParams({ name: "Dana Jones", phone: "705-555-0123", address: "12 Bay St, Midland", smsConsent: "1", t: String(Date.now() - 60_000), ...fields }).toString(),
  });
}

beforeEach(() => {
  h.db = seed();
  h.role = "owner";
  sendSms.mockClear();
});

describe("/ai-settings/service-plans", () => {
  it("members read the plans but not the customer list", async () => {
    h.role = "member";
    const res = await GET(new Request("http://x/api"), ctx);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { available: boolean; plans: Array<{ name: string }>; agreements: unknown } };
    expect(data.available).toBe(true);
    expect(data.plans.map((p) => p.name)).toEqual(["Spring + Fall Lawn Care"]);
    expect(data.agreements).toBeNull();
    expect((await patch({ enabled: false })).status).toBe(403);
    expect((await post({ action: "create_plan", plan: { name: "X Plan", priceCents: 1000, billing: "annual", months: [5] } })).status).toBe(403);
  });

  it("owners PATCH (strict, only service_plans merged) and create plans (validated)", async () => {
    const res = await patch({ renewals: { enabled: false } });
    expect(res.status).toBe(200);
    expect(h.db!.tables.companies[0].ai_settings).toEqual({ sms_agent: { autonomy: "ask_first" }, service_plans: { renewals: { enabled: false } } });
    expect((await patch({ bogus: true })).status).toBe(400);
    expect((await post({ action: "create_plan", plan: { name: "X", priceCents: 1000, billing: "annual", months: [5] } })).status).toBe(400);
    expect((await post({ action: "create_plan", plan: { name: "Gutter Care http://spam", priceCents: 1000, billing: "annual", months: [5] } })).status).toBe(400);
    const ok = await post({ action: "create_plan", plan: { name: "Gutter Care", priceCents: 18000, billing: "annual", months: [4, 11], included: ["Clean the gutters"] } });
    expect(ok.status).toBe(200);
    expect(h.db!.tables.service_plans).toHaveLength(2);
  });

  it("house orgs can't set anything up", async () => {
    h.db = seed("empirevu");
    const res = await GET(new Request("http://x/api"), ctx);
    expect(((await res.json()) as { data: { available: boolean } }).data.available).toBe(false);
    expect((await patch({ enabled: true })).status).toBe(403);
    expect((await post({ action: "create_plan", plan: { name: "Dock Plan", priceCents: 1000, billing: "annual", months: [5] } })).status).toBe(403);
  });
});

describe("public plans pages", () => {
  it("list, plan page, sign-up → the owner is asked; bot checks; renewal 404", async () => {
    const list = await LIST(new Request("http://x/s/northshore/plans"), { params: { slug: "northshore" } });
    expect(list.status).toBe(200);
    expect(await list.text()).toContain("Spring + Fall Lawn Care");
    const page = await PLAN(new Request("http://x"), { params: { slug: "northshore", planId: PLAN_ID } });
    expect(page.status).toBe(200);

    // Honeypot filled → the generic error, nothing saved.
    const bot = await SIGNUP(signupRequest({ website: "http://spam" }), { params: { slug: "northshore", planId: PLAN_ID } });
    expect(bot.status).toBe(400);
    expect(h.db!.tables.service_agreements).toHaveLength(0);

    const res = await SIGNUP(signupRequest(), { params: { slug: "northshore", planId: PLAN_ID } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("will confirm it");
    expect(h.db!.tables.service_agreements[0]).toMatchObject({ status: "pending_owner", customer_phone: "+17055550123" });
    expect(h.db!.tables.owner_approvals[0]).toMatchObject({ kind: "plan_signup" });

    const renew = await RENEW(new Request("http://x"), { params: { slug: "northshore", token: "f".repeat(32) } });
    expect(renew.status).toBe(404);
    // A house org's site never shows plans.
    h.db = seed("empirevu");
    expect((await LIST(new Request("http://x"), { params: { slug: "northshore" } })).status).toBe(404);
  });
});
