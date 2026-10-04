import { beforeEach, describe, expect, it, vi } from "vitest";

const loadCompanyForInvoice = vi.fn();
const createInvoiceFromBooking = vi.fn();
const sendInvoice = vi.fn();
const createTask = vi.fn();

vi.mock("@/server/services/invoices/common", () => ({
  loadCompanyForInvoice: (...a: unknown[]) => loadCompanyForInvoice(...a),
}));
vi.mock("@/server/services/invoices/service", () => ({
  createInvoiceFromBooking: (...a: unknown[]) => createInvoiceFromBooking(...a),
  sendInvoice: (...a: unknown[]) => sendInvoice(...a),
}));
vi.mock("@/server/services/tasks", () => ({
  createTask: (...a: unknown[]) => createTask(...a),
}));

import { autoInvoiceCompletedBooking } from "@/server/services/invoices/auto";
import { InvoiceConflictError } from "@/server/services/invoices/errors";
import { parseInvoiceSettings } from "@/server/services/invoices/settings";

const ctx = { organizationId: "o1", actorProfileId: "p1", supabase: {} } as never;
const booking = { id: "b1", company_id: "c1", contact_id: "ct1", title: "Shrink wrap" };
const withMode = (mode: string | undefined) =>
  loadCompanyForInvoice.mockResolvedValue({ id: "c1", invoice_settings: mode ? { autoInvoiceOnComplete: mode } : {} });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  createTask.mockResolvedValue({ id: "t1" });
  sendInvoice.mockResolvedValue({ invoice: { id: "i1" }, email: { delivered: true } });
});

describe("job done → invoice", () => {
  it("is off by default — nothing is created", async () => {
    expect(parseInvoiceSettings({}).autoInvoiceOnComplete).toBe("off");
    withMode(undefined);
    expect(await autoInvoiceCompletedBooking(ctx, booking)).toMatchObject({ action: "skipped" });
    expect(createInvoiceFromBooking).not.toHaveBeenCalled();
  });

  it("rejects junk modes back to off", () => {
    expect(parseInvoiceSettings({ autoInvoiceOnComplete: "always" }).autoInvoiceOnComplete).toBe("off");
  });

  it("skips a booking with no customer or company", async () => {
    withMode("send");
    expect((await autoInvoiceCompletedBooking(ctx, { ...booking, contact_id: null })).action).toBe("skipped");
    expect((await autoInvoiceCompletedBooking(ctx, { ...booking, company_id: null })).action).toBe("skipped");
    expect(createInvoiceFromBooking).not.toHaveBeenCalled();
  });

  it("draft mode creates the invoice and does not send it", async () => {
    withMode("draft");
    createInvoiceFromBooking.mockResolvedValue({ id: "i1", total_cents: 58760 });
    expect(await autoInvoiceCompletedBooking(ctx, booking)).toEqual({ action: "drafted", invoiceId: "i1" });
    expect(sendInvoice).not.toHaveBeenCalled();
  });

  it("send mode creates and emails it", async () => {
    withMode("send");
    createInvoiceFromBooking.mockResolvedValue({ id: "i1", total_cents: 58760 });
    expect(await autoInvoiceCompletedBooking(ctx, booking)).toEqual({ action: "sent", invoiceId: "i1", emailed: true });
    expect(sendInvoice).toHaveBeenCalledWith(ctx, "i1", { email: true });
  });

  it("never sends an unpriced invoice — it becomes a task instead", async () => {
    withMode("send");
    createInvoiceFromBooking.mockResolvedValue({ id: "i1", total_cents: 0 });
    expect(await autoInvoiceCompletedBooking(ctx, booking)).toEqual({ action: "needs_price", invoiceId: "i1" });
    expect(sendInvoice).not.toHaveBeenCalled();
    expect(createTask).toHaveBeenCalledWith(ctx, expect.objectContaining({ bookingId: "b1", contactId: "ct1" }));
  });

  it("an already-invoiced job is left alone", async () => {
    withMode("send");
    createInvoiceFromBooking.mockRejectedValue(new InvoiceConflictError("already invoiced"));
    expect(await autoInvoiceCompletedBooking(ctx, booking)).toMatchObject({ action: "skipped", reason: "already invoiced" });
  });

  it("never throws — completing the job can't fail because invoicing did", async () => {
    withMode("send");
    createInvoiceFromBooking.mockResolvedValue({ id: "i1", total_cents: 100 });
    sendInvoice.mockRejectedValue(new Error("smtp down"));
    await expect(autoInvoiceCompletedBooking(ctx, booking)).resolves.toMatchObject({ action: "skipped", reason: "smtp down" });
  });
});
