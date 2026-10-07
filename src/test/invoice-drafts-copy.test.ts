import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "./fake-supabase";

let db: FakeDb;
const mails: Array<{ to: string; subject: string; body: string; html?: string; attachments?: unknown[] }> = [];
let mailFails: Error | null = null;

vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => db.client }));
vi.mock("@/server/outbound/email", () => ({
  sendEmail: vi.fn(async (m: { to: string; subject: string; body: string; html?: string }) => {
    if (mailFails) throw mailFails;
    mails.push(m);
    return { id: "m1" };
  }),
}));
vi.mock("@/server/services/invoices/pdf", () => ({
  renderInvoicePdf: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
  renderStatementPdf: vi.fn(async () => new Uint8Array([1])),
}));

const { sendBlockers } = await import("@/server/services/invoices/service");
const { parseInvoiceSettings, invoiceSettingsSchema } = await import("@/server/services/invoices/settings");
const { invoiceWriteSchema } = await import("@/server/api/invoice-schemas");
const { sendInvoiceCopyEmail } = await import("@/server/services/invoices/notify");

const ORG = "org-1";
const CO = "co-1";

beforeEach(() => {
  mails.length = 0;
  mailFails = null;
  db = createFakeDb({
    invoices: [
      {
        id: "inv-1",
        organization_id: ORG,
        company_id: CO,
        contact_id: "c1",
        customer_account_id: null,
        invoice_number: "A1C-2026-0009",
        public_token: "t".repeat(32),
        status: "sent",
        currency: "CAD",
        title: "Spring launch",
        line_items: [{ label: "Launch", description: null, quantity: 1, unitPriceCents: 50000, amountCents: 50000 }],
        subtotal_cents: 50000,
        tax_rate_bps: 1300,
        tax_cents: 6500,
        total_cents: 56500,
        credit_cents: 0,
        amount_paid_cents: 0,
        pending_payment_cents: 0,
        balance_due_cents: 56500,
        issue_date: "2026-10-06",
        due_date: "2026-10-06",
        payment_terms_days: 0,
        bill_to: { name: "Pat Smith", email: "pat@example.com" },
      },
    ],
    companies: [{ id: CO, organization_id: ORG, name: "A1 Marine Care", invoice_settings: {} }],
    contacts: [{ id: "c1", organization_id: ORG, first_name: "Pat", email: "pat@example.com", phone: null }],
    organization_memberships: [
      { organization_id: ORG, profile_id: "admin-1", role: "admin", created_at: "2026-01-01" },
      { organization_id: ORG, profile_id: "owner-1", role: "owner", created_at: "2026-02-01" },
    ],
    profiles: [
      { id: "owner-1", email: "marcus@a1marine.ca" },
      { id: "admin-1", email: "admin@a1marine.ca" },
    ],
    invoice_events: [],
  });
});

describe("half-finished drafts", () => {
  const full = { contact_id: "c1", customer_account_id: null, line_items: [{ label: "Launch" }], total_cents: 56500, credit_cents: 0 };

  it("a complete invoice is ready to send", () => {
    expect(sendBlockers(full)).toEqual([]);
  });

  it("says exactly what's missing before sending", () => {
    expect(sendBlockers({ ...full, contact_id: null })).toEqual(["choose who it's for"]);
    expect(sendBlockers({ ...full, customer_account_id: "a1", contact_id: null })).toEqual([]);
    expect(sendBlockers({ ...full, line_items: [], total_cents: 0 })).toEqual(["add at least one line"]);
    expect(sendBlockers({ ...full, line_items: [{ label: "Launch" }, { label: "  " }, { label: "" }] })).toEqual(["give lines 2, 3 a description"]);
    expect(sendBlockers({ ...full, line_items: [{ label: "" }] })).toEqual(["give line 1 a description"]);
    expect(sendBlockers({ ...full, total_cents: 0 })).toEqual(["add a price (it totals $0)"]);
    expect(sendBlockers({ ...full, credit_cents: 60000 })).toEqual(["the deposit / credit is more than the total"]);
    expect(sendBlockers({ contact_id: null, customer_account_id: null, line_items: [], total_cents: 0, credit_cents: 0 })).toEqual([
      "choose who it's for",
      "add at least one line",
    ]);
  });

  it("the API accepts a draft with no lines, blank descriptions and no customer", () => {
    expect(invoiceWriteSchema.safeParse({ lines: [] }).success).toBe(true);
    expect(invoiceWriteSchema.safeParse({ lines: [{ label: "", quantity: 1, unitPriceCents: 0 }], contactId: null, customerAccountId: null }).success).toBe(true);
    // Numbers still have to make sense.
    expect(invoiceWriteSchema.safeParse({ lines: [{ label: "x", quantity: 0, unitPriceCents: 0 }] }).success).toBe(false);
  });
});

describe("send me a copy", () => {
  it("is off by default; the address is optional and normalised", () => {
    expect(parseInvoiceSettings({})).toMatchObject({ sendCopy: false, copyEmail: null });
    expect(parseInvoiceSettings({ sendCopy: true, copyEmail: " Books@A1Marine.ca " })).toMatchObject({ sendCopy: true, copyEmail: "books@a1marine.ca" });
    expect(parseInvoiceSettings({ sendCopy: true, copyEmail: "" })).toMatchObject({ sendCopy: true, copyEmail: null });
    expect(invoiceSettingsSchema.safeParse({ copyEmail: "not-an-email" }).success).toBe(false);
    // A bad address on its own doesn't knock out the other settings.
    expect(parseInvoiceSettings({ sendCopy: true, copyEmail: "nope", numberPrefix: "A1C" })).toMatchObject({ sendCopy: true, copyEmail: null, numberPrefix: "A1C" });
  });

  it("emails the same invoice + PDF to the address, saying who it went to", async () => {
    const out = await sendInvoiceCopyEmail("inv-1", "books@a1marine.ca", { email: { delivered: true, reason: null, to: "pat@example.com" }, sms: null });
    expect(out).toEqual({ delivered: true, reason: null, to: "books@a1marine.ca" });
    expect(mails).toHaveLength(1);
    const m = mails[0];
    expect(m.to).toBe("books@a1marine.ca");
    expect(m.subject).toMatch(/^Copy: Invoice A1C-2026-0009 from A1 Marine Care/);
    expect(m.body.startsWith("Your copy: this invoice was emailed to pat@example.com (Pat Smith).")).toBe(true);
    expect(m.html).toContain("Your copy: this invoice was emailed to pat@example.com (Pat Smith).");
    expect(m.attachments).toEqual([{ filename: "A1C-2026-0009.pdf", content: Buffer.from([37, 80, 68, 70]).toString("base64") }]);
    expect(db.tables.invoice_events.at(-1)).toMatchObject({ invoice_id: "inv-1", event_type: "copy_sent", metadata: { to: "books@a1marine.ca" } });
  });

  it("falls back to the owner's email, and says when the customer wasn't reached", async () => {
    const out = await sendInvoiceCopyEmail("inv-1", null, { email: { delivered: false, reason: "No email address on file", to: null }, sms: { delivered: true, reason: null, to: "+15555550100" } });
    expect(out.to).toBe("marcus@a1marine.ca");
    expect(mails[0].body).toMatch(/^Your copy: this invoice was texted \(Pat Smith\)\./);
    mails.length = 0;
    await sendInvoiceCopyEmail("inv-1", null, { email: { delivered: false, reason: "No email address on file", to: null }, sms: null });
    expect(mails[0].body).toMatch(/^Your copy: this invoice was issued to Pat Smith, but it wasn't emailed or texted \(No email address on file\)\./);
  });

  it("never throws: a mail failure is reported and logged", async () => {
    mailFails = new Error("resend down");
    const out = await sendInvoiceCopyEmail("inv-1", "books@a1marine.ca", { email: null, sms: null });
    expect(out).toEqual({ delivered: false, reason: "resend down" });
    expect(db.tables.invoice_events.at(-1)).toMatchObject({ event_type: "copy_failed" });
    db.tables.organization_memberships = [];
    expect(await sendInvoiceCopyEmail("inv-1", null, { email: null, sms: null })).toMatchObject({ delivered: false, reason: expect.stringMatching(/No address for the copy/) });
  });
});
