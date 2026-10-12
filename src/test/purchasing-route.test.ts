import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

// Purchasing routes: Settings (GET members — suppliers only for owners/admins; PATCH / POST
// owners+admins, merging ONLY ai_settings.purchasing) and the job sheet's read-only materials block.
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

import { GET, PATCH, POST } from "@/app/api/organizations/[organizationId]/companies/[companyId]/ai-settings/purchasing/route";
import { GET as JOB_ORDERS } from "@/app/api/organizations/[organizationId]/jobs/[bookingId]/materials-orders/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const ITEM = "c0000000-0000-4000-8000-000000000001";
const ctx = { params: { organizationId: ORG, companyId: COMPANY } };

function seed(): FakeDb {
  return createFakeDb({
    companies: [{ id: COMPANY, organization_id: ORG, name: "Northshore Roofing", timezone: "America/Toronto", stage: "active", ai_settings: { sms_agent: { autonomy: "ask_first" } }, owner_email: "dana@x.test", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }],
    organizations: [{ id: ORG, platform_brand: "crankleads" }],
    suppliers: [{ id: "s-1", organization_id: ORG, company_id: COMPANY, name: "Home Depot Pro", branch: null, email: "o@hd.test", phone: null, account_number: "12345", preferred: true, active: true, created_at: "2026-09-01T00:00:00Z" }],
    service_catalog_items: [{ id: ITEM, organization_id: ORG, company_id: COMPANY, service_key: "shingle_roof", label: "Shingle roof", unit_label: "square", active: true, sort_order: 1 }],
    material_recipes: [],
    purchase_orders: [
      { id: "po-1", organization_id: ORG, company_id: COMPANY, booking_id: "b-1", supplier_name: "Home Depot Pro", status: "sent", po_number: "PO-1", po_seq: 1, needed_by: "2026-10-14", fulfilment: "pickup", lines: [{ label: "shingles", qty: 22, unit: "bundles", estUnitCostCents: 3850, source: "recipe" }], est_total_cents: 84_700, created_at: "2026-10-12T00:00:00Z" },
      { id: "po-2", organization_id: ORG, company_id: COMPANY, booking_id: "b-1", supplier_name: "Kent", status: "draft", po_number: "PO-2", po_seq: 2, needed_by: "2026-10-14", fulfilment: "pickup", lines: [], est_total_cents: 0, created_at: "2026-10-12T01:00:00Z" },
    ],
    bookings: [],
    contacts: [],
  });
}

const json = (res: Response) => res.json() as Promise<{ data?: Record<string, unknown>; error?: string }>;
const req = (method: string, body?: unknown) => new Request("http://x.test/", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  h.db = seed();
  h.role = "owner";
});

describe("purchasing settings route", () => {
  it("GET: owners see suppliers with account numbers; members don't", async () => {
    const owner = await json(await GET(req("GET"), ctx));
    expect((owner.data?.suppliers as Array<Record<string, unknown>>)[0]).toMatchObject({ name: "Home Depot Pro", accountNumber: "12345" });
    h.role = "member";
    const member = await json(await GET(req("GET"), ctx));
    expect(member.data?.suppliers).toBeNull();
    expect(member.data?.settings).toMatchObject({ enabled: true, leadDays: 2 });
  });

  it("PATCH: owners/admins only, strict, merges only ai_settings.purchasing", async () => {
    h.role = "member";
    expect((await PATCH(req("PATCH", { enabled: false }), ctx)).status).toBe(403);
    h.role = "admin";
    expect((await PATCH(req("PATCH", { leadDays: 30 }), ctx)).status).toBe(400);
    expect((await PATCH(req("PATCH", { enabled: false, sneaky: 1 }), ctx)).status).toBe(400);
    const ok = await PATCH(req("PATCH", { leadDays: 3, defaultFulfilment: "delivery" }), ctx);
    expect(ok.status).toBe(200);
    expect(h.db!.tables.companies[0].ai_settings).toEqual({ sms_agent: { autonomy: "ask_first" }, purchasing: { lead_days: 3, default_fulfilment: "delivery", any_on: false } });
  });

  it("POST: suppliers and recipes (owners/admins), bad input refused", async () => {
    h.role = "member";
    expect((await POST(req("POST", { action: "save_supplier", supplier: { name: "Kent" } }), ctx)).status).toBe(403);
    h.role = "owner";
    const added = await json(await POST(req("POST", { action: "save_supplier", supplier: { name: "Kent", branch: "Midland", email: "orders@kent.test", preferred: true } }), ctx));
    expect((added.data?.suppliers as Array<Record<string, unknown>>).map((s) => [s.name, s.preferred])).toEqual([["Home Depot Pro", false], ["Kent", true]]);
    expect((await POST(req("POST", { action: "save_supplier", supplier: { name: "X", email: "nope" } }), ctx)).status).toBe(400);
    const recipe = await json(await POST(req("POST", { action: "save_recipe", catalogItemId: ITEM, lines: [{ label: "shingles", qtyPerUnit: 3, unit: "bundles", estUnitCostCents: 3850 }] }), ctx));
    expect((recipe.data?.catalog as Array<{ recipe: unknown[] }>)[0].recipe).toEqual([{ label: "shingles", qtyPerUnit: 3, unit: "bundles", estUnitCostCents: 3850, supplierId: null }]);
    expect((await POST(req("POST", { action: "save_recipe", catalogItemId: "c0000000-0000-4000-8000-000000000009", lines: [] }), ctx)).status).toBe(400);
    expect((await POST(req("POST", { action: "remove_supplier", supplierId: "d0000000-0000-4000-8000-000000000009" }), ctx)).status).toBe(404);
  });
});

describe("job sheet materials block", () => {
  it("any member: ordered lists, no drafts, no prices", async () => {
    h.role = "member";
    const res = await json(await JOB_ORDERS(req("GET"), { params: { organizationId: ORG, bookingId: "b-1" } }));
    expect(res.data).toEqual([{ poNumber: "PO-1", status: "sent", statusLabel: "Ordered", supplier: "Home Depot Pro", fulfilment: "pickup", neededBy: "2026-10-14", estimate: false, items: ["22 bundles shingles"] }]);
    expect(JSON.stringify(res.data)).not.toMatch(/3850|84700|12345/);
  });
});
