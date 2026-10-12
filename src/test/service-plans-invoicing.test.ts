import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

// Job done → invoice with service plans in play (invoices/auto.ts + staff/service-plans/prepaid.ts):
// a visit inside a started annual term is skipped (paid up front); everything else — next term's
// visits booked before the renewal is paid, and A1's recurring visits — is invoiced as before.
const h = vi.hoisted(() => ({ db: null as FakeDb | null }));
const createInvoiceFromBooking = vi.fn();
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.db?.client }));
vi.mock("@/server/services/invoices/common", () => ({ loadCompanyForInvoice: async () => ({ id: "c1", invoice_settings: { autoInvoiceOnComplete: "draft" } }) }));
vi.mock("@/server/services/invoices/service", () => ({ createInvoiceFromBooking: (...a: unknown[]) => createInvoiceFromBooking(...a), sendInvoice: vi.fn() }));
vi.mock("@/server/services/tasks", () => ({ createTask: vi.fn(async () => ({ id: "t1" })) }));

import { autoInvoiceCompletedBooking } from "@/server/services/invoices/auto";

const ORG = "11111111-1111-4111-8111-111111111111";
const HOUSE_ORG = "33333333-3333-4333-8333-333333333333";
const PLAN_SERIES = "77777777-7777-4777-8777-777777777772";
const A1_SERIES = "77777777-7777-4777-8777-777777777771";

beforeEach(() => {
  createInvoiceFromBooking.mockReset();
  createInvoiceFromBooking.mockResolvedValue({ id: "i1", total_cents: 9500, line_items: [] });
  h.db = createFakeDb({
    service_agreements: [
      { id: "a1", organization_id: ORG, recurring_job_id: PLAN_SERIES, billing: "annual", status: "renewal_due", term_start: "2025-11-01", term_end: "2026-10-31", activated_at: "2025-11-01T14:00:00Z" },
    ],
  });
});

const ctx = (org: string) => ({ organizationId: org, actorProfileId: null, supabase: {} }) as never;
const visit = (series: string, date: string) => ({ id: `b-${date}`, company_id: "c1", contact_id: "ct1", title: "Spring visit", recurring_job_id: series, occurrence_date: date, scheduled_for: `${date}T13:00:00Z` });

describe("job done → invoice for plan visits", () => {
  it("a visit inside the paid term is skipped", async () => {
    expect(await autoInvoiceCompletedBooking(ctx(ORG), visit(PLAN_SERIES, "2026-05-05"))).toEqual({ action: "skipped", reason: "covered by a prepaid service plan" });
    expect(createInvoiceFromBooking).not.toHaveBeenCalled();
  });

  it("next term's visit, booked before the renewal was paid, is invoiced", async () => {
    expect((await autoInvoiceCompletedBooking(ctx(ORG), visit(PLAN_SERIES, "2027-05-04"))).action).not.toBe("skipped");
    expect(createInvoiceFromBooking).toHaveBeenCalledTimes(1);
  });

  it("A1's recurring visits are still invoiced", async () => {
    expect(await autoInvoiceCompletedBooking(ctx(HOUSE_ORG), visit(A1_SERIES, "2026-10-20"))).toEqual({ action: "drafted", invoiceId: "i1" });
    expect(createInvoiceFromBooking).toHaveBeenCalledTimes(1);
  });
});
