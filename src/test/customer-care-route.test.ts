import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

// Customer care: the Settings route (GET members — open cases only for owners/admins; PATCH / POST
// owners+admins, merging ONLY ai_settings.customer_care) and job done → invoice (a callback /
// warranty visit is never invoiced; A1's jobs are invoiced exactly as before).
const h = vi.hoisted(() => ({ db: null as FakeDb | null, role: "owner" }));
const createInvoiceFromBooking = vi.fn();
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
vi.mock("@/server/services/invoices/common", () => ({ loadCompanyForInvoice: async () => ({ id: "c1", invoice_settings: { autoInvoiceOnComplete: "draft" } }) }));
vi.mock("@/server/services/invoices/service", () => ({ createInvoiceFromBooking: (...a: unknown[]) => createInvoiceFromBooking(...a), sendInvoice: vi.fn() }));
vi.mock("@/server/services/tasks", () => ({ createTask: vi.fn(async () => ({ id: "t1" })) }));

import { GET, PATCH, POST } from "@/app/api/organizations/[organizationId]/companies/[companyId]/ai-settings/customer-care/route";
import { autoInvoiceCompletedBooking } from "@/server/services/invoices/auto";
import { isCareVisitBooking } from "@/server/services/staff/customer-care/care-visit";

const ORG = "11111111-1111-4111-8111-111111111111";
const HOUSE_ORG = "33333333-3333-4333-8333-333333333333";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const ITEM = "c0000000-0000-4000-8000-000000000001";
const CASE = "d0000000-0000-4000-8000-000000000001";
const ctx = { params: { organizationId: ORG, companyId: COMPANY } };

function seed(): FakeDb {
  return createFakeDb(
    {
      companies: [{ id: COMPANY, organization_id: ORG, name: "Northshore Roofing", timezone: "America/Toronto", stage: "active", ai_settings: { sms_agent: { autonomy: "standard" } }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }],
      organizations: [{ id: ORG, platform_brand: "crankleads" }],
      contacts: [{ id: "ct-1", organization_id: ORG, company_id: COMPANY, first_name: "Dana", last_name: "Jones", phone: "+17055550123", phone_last10: "7055550123" }],
      service_catalog_items: [{ id: ITEM, organization_id: ORG, company_id: COMPANY, service_key: "roof", label: "Roof replacement", active: true, sort_order: 1 }],
      care_cases: [{ id: CASE, organization_id: ORG, company_id: COMPANY, contact_id: "ct-1", kind: "complaint", status: "open", rating: 2, summary: "still leaking", opened_via: "checkin", approval_ids: [], created_at: "2026-10-12T14:00:00Z" }],
      care_checkins: [],
      care_case_bookings: [{ id: "ccb-1", organization_id: ORG, company_id: COMPANY, case_id: CASE, booking_id: "b-callback", kind: "callback" }],
      warranty_terms: [],
      installed_equipment: [],
      owner_approvals: [],
    },
    { warranty_terms: [["company_id", "service_catalog_item_id"]] },
  );
}

const json = (res: Response) => res.json() as Promise<{ data?: Record<string, unknown>; error?: string }>;
const req = (method: string, body?: unknown) => new Request("http://x.test/", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  h.db = seed();
  h.role = "owner";
  createInvoiceFromBooking.mockReset();
  createInvoiceFromBooking.mockResolvedValue({ id: "i1", total_cents: 9500, line_items: [] });
});

describe("customer care settings route", () => {
  it("GET: owners see the open cases; members see the numbers but not the cases", async () => {
    const owner = await json(await GET(req("GET"), ctx));
    expect((owner.data?.cases as Array<Record<string, unknown>>)[0]).toMatchObject({ customer: "Dana Jones", kind: "complaint", rating: 2 });
    expect(owner.data?.settings).toMatchObject({ enabled: true, warranty: { months: 12 } });
    h.role = "member";
    const member = await json(await GET(req("GET"), ctx));
    expect(member.data?.cases).toBeNull();
    expect(member.data?.stats).toMatchObject({ openCases: 1 });
  });

  it("PATCH: owners/admins only, strict, check-in time inside 09:00-19:00, merges only customer_care", async () => {
    h.role = "member";
    expect((await PATCH(req("PATCH", { enabled: false }), ctx)).status).toBe(403);
    h.role = "admin";
    expect((await PATCH(req("PATCH", { checkins: { time: "21:00" } }), ctx)).status).toBe(400);
    expect((await PATCH(req("PATCH", { enabled: false, sneaky: 1 }), ctx)).status).toBe(400);
    const ok = await PATCH(req("PATCH", { checkins: { time: "09:30", delayDays: 2 }, warranty: { months: 24 } }), ctx);
    expect(ok.status).toBe(200);
    expect(h.db!.tables.companies[0].ai_settings).toEqual({ sms_agent: { autonomy: "standard" }, customer_care: { checkins: { time: "09:30", delay_days: 2 }, warranty: { months: 24 }, any_on: false } });
  });

  it("POST: warranty terms, equipment, resolving a case (owners/admins)", async () => {
    h.role = "member";
    expect((await POST(req("POST", { action: "resolve_case", caseId: CASE, outcome: "resolved" }), ctx)).status).toBe(403);
    h.role = "owner";
    const term = await json(await POST(req("POST", { action: "save_term", catalogItemId: ITEM, months: 60 }), ctx));
    expect((term.data?.catalog as Array<Record<string, unknown>>)[0]).toMatchObject({ months: 60 });
    const cleared = await json(await POST(req("POST", { action: "save_term", catalogItemId: ITEM, months: null }), ctx));
    expect((cleared.data?.catalog as Array<Record<string, unknown>>)[0]).toMatchObject({ months: null });
    const gear = await json(await POST(req("POST", { action: "save_equipment", equipment: { customer: "Dana Jones", make: "Lennox", warrantyEnds: "2035-11-02" } }), ctx));
    expect((gear.data?.equipment as Array<Record<string, unknown>>)[0]).toMatchObject({ name: "Lennox", customer: "Dana Jones", warrantyEnds: "2035-11-02" });
    expect((await POST(req("POST", { action: "save_equipment", equipment: { customer: "Dana Jones", warrantyEnds: "Nov 2" } }), ctx)).status).toBe(400);
    const resolved = await json(await POST(req("POST", { action: "resolve_case", caseId: CASE, outcome: "resolved" }), ctx));
    expect(resolved.data?.cases).toEqual([]);
    expect((await POST(req("POST", { action: "resolve_case", caseId: CASE, outcome: "resolved" }), ctx)).status).toBe(404);
  });
});

describe("job done → invoice with care visits", () => {
  const tenant = (org: string) => ({ organizationId: org, actorProfileId: null, supabase: {} }) as never;
  const job = (id: string) => ({ id, company_id: "c1", contact_id: "ct-1", title: "Callback: Roof replacement (Dana Jones)", recurring_job_id: null, occurrence_date: null, scheduled_for: "2026-10-15T13:00:00Z" });

  it("a callback / warranty visit is never invoiced", async () => {
    expect(await autoInvoiceCompletedBooking(tenant(ORG), job("b-callback"))).toEqual({ action: "skipped", reason: "a no-charge callback / warranty visit" });
    expect(createInvoiceFromBooking).not.toHaveBeenCalled();
  });

  it("every other job — and A1's — is invoiced exactly as before", async () => {
    expect(await autoInvoiceCompletedBooking(tenant(ORG), job("b-normal"))).toEqual({ action: "drafted", invoiceId: "i1" });
    expect(await autoInvoiceCompletedBooking(tenant(HOUSE_ORG), job("b-callback"))).toEqual({ action: "drafted", invoiceId: "i1" });
    expect(createInvoiceFromBooking).toHaveBeenCalledTimes(2);
  });

  it("the check is tolerant: any error → false (invoiced as before)", async () => {
    h.db!.failNext("care_case_bookings", "select");
    expect(await isCareVisitBooking(ORG, "b-callback")).toBe(false);
    expect(await isCareVisitBooking(ORG, null)).toBe(false);
  });
});
