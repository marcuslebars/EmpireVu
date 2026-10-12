import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

// Profit advisor settings route: GET (members — switches only; owners/admins also the money) and
// PATCH (owners/admins, strict, merging ONLY ai_settings.profit_advisor).
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

import { GET, PATCH } from "@/app/api/organizations/[organizationId]/companies/[companyId]/ai-settings/profit-advisor/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const OTHER_COMPANY = "55555555-5555-4555-8555-555555555555";
const ctx = { params: { organizationId: ORG, companyId: COMPANY } };

function seed(): FakeDb {
  return createFakeDb({
    companies: [
      { id: COMPANY, organization_id: ORG, name: "Northshore Roofing", timezone: "America/Toronto", stage: "active", ai_settings: { sms_agent: { autonomy: "ask_first" } }, owner_phone_e164: "+17055559999", owner_phone_verified_at: "2026-10-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" },
      { id: OTHER_COMPANY, organization_id: "99999999-9999-4999-8999-999999999999", name: "Elsewhere", timezone: "America/Toronto", ai_settings: {}, updated_at: "2026-10-01T00:00:00Z" },
    ],
    organizations: [{ id: ORG, platform_brand: "crankleads" }],
    invoices: [{ id: "inv-1", organization_id: ORG, company_id: COMPANY, contact_id: null, invoice_number: "INV-1", status: "sent", balance_due_cents: 500_000, due_date: "2026-10-20", issue_date: "2026-10-06" }],
    service_catalog_items: [],
    bookings: [],
    quotes: [],
    profit_advisor_runs: [],
    price_changes: [],
  });
}

const json = (res: Response) => res.json() as Promise<{ data?: Record<string, unknown>; error?: string }>;
const req = (method: string, body?: unknown) => new Request("http://x.test/", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  h.db = seed();
  h.role = "owner";
});

describe("profit advisor settings route", () => {
  it("GET: owners see the forecast; members only the switches", async () => {
    const owner = await json(await GET(req("GET"), ctx));
    expect(owner.data).toMatchObject({ manager: true, settings: { enabled: true, weekly: { enabled: true, day: 5, time: "15:00" } }, disclaimer: "Estimates from your app data - not financial advice." });
    expect((owner.data?.forecast as Record<string, unknown>).windows).toHaveLength(3);
    h.role = "member";
    const member = await json(await GET(req("GET"), ctx));
    expect(member.data).toMatchObject({ manager: false, forecast: null, pricing: null, lastWeekly: null });
  });

  it("PATCH: owners/admins only, strict, merges only ai_settings.profit_advisor", async () => {
    h.role = "member";
    expect((await PATCH(req("PATCH", { enabled: false }), ctx)).status).toBe(403);
    h.role = "admin";
    expect((await PATCH(req("PATCH", { weekly: { day: 7 } }), ctx)).status).toBe(400);
    expect((await PATCH(req("PATCH", { weekly: { time: "03:00" } }), ctx)).status).toBe(400);
    expect((await PATCH(req("PATCH", { tightCushionCents: -1 }), ctx)).status).toBe(400);
    expect((await PATCH(req("PATCH", { enabled: false, sneaky: 1 }), ctx)).status).toBe(400);
    const ok = await PATCH(req("PATCH", { weekly: { day: 1, time: "07:30" }, pricingCheck: { enabled: false }, tightCushionCents: 250_000 }), ctx);
    expect(ok.status).toBe(200);
    expect(h.db!.tables.companies[0].ai_settings).toEqual({
      sms_agent: { autonomy: "ask_first" },
      profit_advisor: { weekly: { day: 1, time: "07:30" }, pricing_check: { enabled: false }, tight_cushion_cents: 250_000, any_on: false },
    });
  });

  it("another org's company is refused", async () => {
    const res = await GET(req("GET"), { params: { organizationId: ORG, companyId: OTHER_COMPANY } });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
