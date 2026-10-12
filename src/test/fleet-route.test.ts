import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

// Fleet settings route: GET (members read), PATCH / POST (owners + admins), merging ONLY
// ai_settings.fleet; every write scoped to the company.
const h = vi.hoisted(() => ({ db: null as FakeDb | null, role: "owner" }));
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.db?.client }));
vi.mock("@/server/supabase/server", () => ({ createSupabaseServerClient: () => h.db?.client }));
vi.mock("@/server/outbound/sms", () => ({ sendSms: vi.fn(() => Promise.resolve({ sid: "SM1" })) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: vi.fn(), recordAiUsageSafe: vi.fn() }));
vi.mock("@/server/organizations/context", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/organizations/context")>();
  return {
    ...original,
    requireOrganizationContext: async (_s: unknown, organizationId: string) => ({ organizationId, user: { id: "user-1" }, membership: { role: h.role } }),
  };
});

import { GET, PATCH, POST } from "@/app/api/organizations/[organizationId]/companies/[companyId]/ai-settings/fleet/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const TRUCK = "a1000000-0000-4000-8000-000000000001";
const ctx = { params: { organizationId: ORG, companyId: COMPANY } };

function seed(): FakeDb {
  return createFakeDb({
    companies: [{ id: COMPANY, organization_id: ORG, name: "Northshore Roofing", timezone: "America/Toronto", stage: "active", ai_settings: { sms_agent: { autonomy: "ask_first" } }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }],
    organizations: [{ id: ORG, platform_brand: "crankleads" }],
    vehicles: [{ id: TRUCK, organization_id: ORG, company_id: COMPANY, name: "Truck 2", year: 2019, make: "Ford", model: "F-150", plate: "ABCD 123", active: true, safety_inspection_required: false, odometer_km: null, odometer_at: null, avg_km_per_day: null, created_at: "2026-01-01T00:00:00Z" }],
    vehicle_service_items: [],
    equipment: [],
    rentals: [],
    fleet_log: [],
    organization_memberships: [],
    profiles: [],
    compliance_documents: [],
  });
}

const json = (res: Response) => res.json() as Promise<{ data?: Record<string, unknown>; error?: string }>;
const req = (method: string, body?: unknown) => new Request("http://x.test/", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  h.db = seed();
  h.role = "owner";
});

describe("fleet settings route", () => {
  it("GET: members read the fleet and the switches", async () => {
    h.role = "member";
    const res = await json(await GET(req("GET"), ctx));
    expect(res.data?.settings).toMatchObject({ enabled: true, reminders: true });
    expect((res.data?.vehicles as Array<Record<string, unknown>>)[0]).toMatchObject({ name: "Truck 2", plate: "ABCD 123", odometerWords: "no odometer reading yet" });
    expect(res.data?.vehicleInsurance).toBeNull(); // Compliance documents are owner/admin-read
    h.role = "owner";
    expect((await json(await GET(req("GET"), ctx))).data?.vehicleInsurance).toEqual([]);
  });

  it("PATCH: owners/admins only, strict, merges only ai_settings.fleet", async () => {
    h.role = "member";
    expect((await PATCH(req("PATCH", { enabled: false }), ctx)).status).toBe(403);
    h.role = "admin";
    expect((await PATCH(req("PATCH", { enabled: false, sneaky: 1 }), ctx)).status).toBe(400);
    const ok = await PATCH(req("PATCH", { reminders: false }), ctx);
    expect(ok.status).toBe(200);
    expect(h.db!.tables.companies[0].ai_settings).toEqual({ sms_agent: { autonomy: "ask_first" }, fleet: { reminders: false } });
  });

  it("POST: vehicles, schedules, rentals (owners/admins), bad input refused", async () => {
    h.role = "member";
    expect((await POST(req("POST", { action: "save_vehicle", vehicle: { name: "Van" } }), ctx)).status).toBe(403);
    h.role = "owner";
    const saved = await json(await POST(req("POST", { action: "save_vehicle", vehicle: { id: TRUCK, odometerKm: 84_200, plateStickerDue: "2027-03-31" } }), ctx));
    expect((saved.data?.vehicles as Array<Record<string, unknown>>)[0]).toMatchObject({ odometerKm: 84_200, plateStickerDue: "2027-03-31" });
    expect(h.db!.tables.fleet_log).toEqual([expect.objectContaining({ vehicle_id: TRUCK, kind: "odometer", reading: 84_200, source: "settings", organization_id: ORG, company_id: COMPANY })]);
    const sched = await json(await POST(req("POST", { action: "save_service_item", vehicleId: TRUCK, item: { label: "Oil change", everyKm: 8000, lastDoneKm: 80_000 } }), ctx));
    expect(((sched.data?.vehicles as Array<{ services: Array<Record<string, unknown>> }>)[0].services[0])).toMatchObject({ label: "Oil change", everyKm: 8000 });
    const rental = await POST(req("POST", { action: "save_rental", rental: { item: "mini-ex", vendor: "Sunbelt", dueBackLocal: "2026-10-15T17:00", rateCentsPerDay: 38_000 } }), ctx);
    expect(rental.status).toBe(200);
    expect(h.db!.tables.rentals[0]).toMatchObject({ due_back_at: "2026-10-15T21:00:00.000Z", created_via: "settings" });
    expect((await POST(req("POST", { action: "save_vehicle", vehicle: { name: "Van", year: 1800 } }), ctx)).status).toBe(400);
    expect((await POST(req("POST", { action: "save_rental", rental: { item: "x", dueBackLocal: "soon" } }), ctx)).status).toBe(400);
    expect((await POST(req("POST", { action: "drop_tables" }), ctx)).status).toBe(400);
    expect((await POST(req("POST", { action: "return_rental", rentalId: "a4000000-0000-4000-8000-000000000009" }), ctx)).status).toBe(400);
    // Fleet off: nothing is added.
    h.db!.tables.companies[0].ai_settings = { fleet: { enabled: false } };
    const off = await POST(req("POST", { action: "save_vehicle", vehicle: { name: "Van" } }), ctx);
    expect(off.status).toBe(400);
    expect(h.db!.tables.vehicles).toHaveLength(1);
  });
});
