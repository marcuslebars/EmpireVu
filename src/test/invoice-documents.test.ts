import { describe, expect, it } from "vitest";

import type { CompanyForInvoice, InvoiceRow } from "@/server/services/invoices/common";
import { readBillTo } from "@/server/services/invoices/common";
import { buildInvoiceDocument, pageStateOf } from "@/server/services/invoices/document";
import { renderInvoiceReminder, renderInvoiceSent, renderPaymentReceipt, renderStatement } from "@/server/services/invoices/emails";
import { pdfSafe, renderInvoicePdf, renderStatementPdf } from "@/server/services/invoices/pdf";
import { parseInvoiceSettings } from "@/server/services/invoices/settings";

const company: CompanyForInvoice = {
  id: "c1",
  organization_id: "o1",
  name: "A1 Marine Care",
  timezone: "America/Toronto",
  brand_logo_url: null,
  brand_primary_color: "#0b5cab",
  brand_accent_color: null,
  brand_from_name: null,
  brand_reply_email: "hello@a1marinecare.ca",
  brand_reply_phone: "705-555-0100",
  brand_website_url: "https://a1marinecare.ca",
  tax_registration_number: "123456789 RT0001",
  business_address: "1 Harbour Rd\nMidland ON",
  invoice_settings: {
    acceptEtransfer: true,
    etransferEmail: "pay@a1marinecare.ca",
    acceptCheque: true,
    chequePayableTo: "A1 Marine Care Inc.",
    footerText: "Thank you for your business.",
  },
  quote_public_base_url: "https://quotes.a1marinecare.ca",
  stripe_connected_account_id: "acct_123",
  stripe_charges_enabled: true,
  stripe_acss_debit_enabled: false,
};

function invoice(over: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: "i1",
    organization_id: "o1",
    company_id: "c1",
    contact_id: "ct1",
    customer_account_id: null,
    quote_id: null,
    booking_id: null,
    invoice_number: "INV-2026-0007",
    public_token: "a".repeat(32),
    status: "sent",
    currency: "CAD",
    title: "Shrink wrap — 24 ft",
    line_items: [{ label: "Shrink wrap", description: "Includes vents", quantity: 1, unitPriceCents: 52000, amountCents: 52000 }],
    subtotal_cents: 52000,
    tax_rate_bps: 1300,
    tax_cents: 6760,
    total_cents: 58760,
    credit_cents: 25000,
    amount_paid_cents: 0,
    pending_payment_cents: 0,
    balance_due_cents: 33760,
    issue_date: "2026-10-03",
    due_date: "2026-10-03",
    payment_terms_days: 0,
    bill_to: { name: "Pat Smith", email: "pat@example.com", address: null },
    notes: null,
    internal_notes: "do not show",
    sent_at: "2026-10-03T14:00:00Z",
    first_viewed_at: null,
    paid_at: null,
    paid_notified_at: null,
    voided_at: null,
    void_reason: null,
    last_reminder_at: null,
    reminder_count: 0,
    stripe_checkout_session_id: "cs_secret",
    created_by: null,
    created_at: "2026-10-03T13:00:00Z",
    updated_at: "2026-10-03T13:00:00Z",
    ...over,
  };
}

describe("invoice document", () => {
  it("is on the brand's own domain and exposes no internal or Stripe ids", () => {
    const doc = buildInvoiceDocument(invoice(), company, new Date("2026-10-03T15:00:00Z"));
    expect(doc.publicUrl).toBe(`https://quotes.a1marinecare.ca/i/${"a".repeat(32)}`);
    const json = JSON.stringify(doc);
    for (const secret of ["cs_secret", "acct_123", "do not show", '"o1"', '"c1"', '"ct1"']) {
      expect(json).not.toContain(secret);
    }
  });

  it("offers only the methods the brand set up, and online only when Stripe can charge", () => {
    const doc = buildInvoiceDocument(invoice(), company);
    expect(doc.payment.card).toBe(true);
    expect(doc.payment.bankDebit).toBe(false); // off by default
    expect(doc.payment.etransfer?.email).toBe("pay@a1marinecare.ca");
    expect(doc.payment.cheque?.payableTo).toBe("A1 Marine Care Inc.");
    const noStripe = buildInvoiceDocument(invoice(), { ...company, stripe_charges_enabled: false });
    expect(noStripe.payment.card).toBe(false);
  });

  describe("bank debit needs Stripe's ACSS capability, not just card readiness", () => {
    const wantsDebit = { ...company, invoice_settings: { ...(company.invoice_settings as object), acceptBankDebit: true } };

    it("is hidden while the capability isn't active, even with the setting on and cards working", () => {
      const doc = buildInvoiceDocument(invoice(), { ...wantsDebit, stripe_acss_debit_enabled: false });
      expect(doc.payment.card).toBe(true);
      expect(doc.payment.bankDebit).toBe(false);
    });

    it("is offered once the capability is active and the setting is on", () => {
      expect(buildInvoiceDocument(invoice(), { ...wantsDebit, stripe_acss_debit_enabled: true }).payment.bankDebit).toBe(true);
    });

    it("stays off when the brand turned it off, capability or not", () => {
      expect(buildInvoiceDocument(invoice(), { ...company, stripe_acss_debit_enabled: true }).payment.bankDebit).toBe(false);
    });

    it("is off when the account can't charge at all", () => {
      const doc = buildInvoiceDocument(invoice(), { ...wantsDebit, stripe_acss_debit_enabled: true, stripe_charges_enabled: false });
      expect(doc.payment.bankDebit).toBe(false);
    });
  });

  it("derives the page state", () => {
    const today = "2026-10-10";
    expect(pageStateOf(invoice({ due_date: "2026-10-20" }), today)).toBe("open");
    expect(pageStateOf(invoice({ due_date: "2026-10-05" }), today)).toBe("overdue");
    expect(pageStateOf(invoice({ status: "partially_paid", due_date: "2026-10-20" }), today)).toBe("partially_paid");
    expect(pageStateOf(invoice({ pending_payment_cents: 33760 }), today)).toBe("processing");
    expect(pageStateOf(invoice({ status: "paid" }), today)).toBe("paid");
    expect(pageStateOf(invoice({ status: "void" }), today)).toBe("void");
  });

  it("reads a damaged bill_to safely", () => {
    expect(readBillTo(null).name).toBe("Customer");
    expect(readBillTo({ name: "  ", email: "x@y.z" })).toMatchObject({ name: "Customer", email: "x@y.z" });
  });
});

describe("invoice settings", () => {
  it("defaults to card only, due on receipt, HST 13%, reminders 1/7/14", () => {
    const s = parseInvoiceSettings({});
    expect(s).toMatchObject({ acceptCard: true, acceptBankDebit: false, acceptEtransfer: false, paymentTermsDays: 0, numberPrefix: "INV", remindersEnabled: true });
    expect(s.reminderDays).toEqual([1, 7, 14]);
  });

  it("won't offer e-Transfer without an address", () => {
    expect(parseInvoiceSettings({ acceptEtransfer: true }).acceptEtransfer).toBe(false);
  });

  it("keeps the valid fields when one is junk", () => {
    const s = parseInvoiceSettings({ paymentTermsDays: 30, taxRateBps: "lots", reminderDays: [14, 1, 1] });
    expect(s.paymentTermsDays).toBe(30);
    expect(s.taxRateBps).toBe(1300);
    expect(s.reminderDays).toEqual([1, 14]);
  });
});

describe("invoice emails", () => {
  const doc = buildInvoiceDocument(invoice(), company);

  it("names the brand, never the platform, and escapes customer text", () => {
    const mail = renderInvoiceSent(buildInvoiceDocument(invoice({ title: "<script>x</script>" }), company), { firstName: "Pat" });
    for (const part of [mail.subject, mail.html, mail.text]) expect(part.toLowerCase()).not.toContain("empirevu");
    expect(mail.html).not.toContain("<script>x</script>");
    expect(mail.fromName).toBe("A1 Marine Care");
    expect(mail.replyTo).toBe("hello@a1marinecare.ca");
    expect(mail.subject).toContain("INV-2026-0007");
    expect(mail.text).toContain("$337.60");
    expect(mail.text).toContain("pay@a1marinecare.ca");
  });

  it("receipts say paid in full only when nothing is left", () => {
    const paid = buildInvoiceDocument(invoice({ status: "paid", balance_due_cents: 0, amount_paid_cents: 33760 }), company);
    expect(renderPaymentReceipt(paid, { amountCents: 33760, method: "card", receivedAt: "" }, { firstName: null }).text).toContain("paid in full");
    expect(renderPaymentReceipt(doc, { amountCents: 10000, method: "etransfer", receivedAt: "" }, { firstName: null }).text).toContain("Remaining balance");
    expect(renderPaymentReceipt(doc, { amountCents: 33760, method: "bank_debit", receivedAt: "", pending: true }, { firstName: null }).subject).toContain("processing");
  });

  it("reminders get plainer, not threatening", () => {
    const first = renderInvoiceReminder(doc, { firstName: "Pat", daysOverdue: 1, index: 0 });
    const later = renderInvoiceReminder(doc, { firstName: "Pat", daysOverdue: 14, index: 2 });
    expect(first.subject).toMatch(/^Reminder/);
    expect(later.text).toContain("14 days past due");
    expect(later.text.toLowerCase()).not.toMatch(/collections|legal action/);
  });
});

describe("PDFs", () => {
  it("renders an invoice PDF, even with characters the standard fonts can't draw", async () => {
    const doc = buildInvoiceDocument(invoice({ bill_to: { name: "Zoë 🚤 Lévesque — 李" } }), company);
    const bytes = await renderInvoicePdf(doc);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
  });

  it("paginates a long invoice", async () => {
    const lines = Array.from({ length: 80 }, (_, i) => ({ label: `Item ${i}`, description: "x ".repeat(60), quantity: 1, unitPriceCents: 100, amountCents: 100 }));
    const bytes = await renderInvoicePdf(buildInvoiceDocument(invoice({ line_items: lines }), company));
    const { PDFDocument } = await import("pdf-lib");
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(1);
  });

  it("renders a statement PDF and email", async () => {
    const st = {
      brand: buildInvoiceDocument(invoice(), company).brand,
      payment: buildInvoiceDocument(invoice(), company).payment,
      currency: "CAD",
      statementDate: "2026-10-31",
      customer: { name: "Wye Heritage Marina", attention: null, address: "Midland ON", email: "ap@marina.example" },
      lines: [
        { invoiceNumber: "INV-2026-0001", title: null, issueDate: "2026-09-01", dueDate: "2026-10-01", totalCents: 100000, paidCents: 0, balanceCents: 100000, overdue: true, publicUrl: "https://x/i/1" },
      ],
      aging: { current: 0, d1_30: 100000, d31_60: 0, d61_90: 0, over90: 0 },
      totalDueCents: 100000,
      footerText: null,
    };
    const bytes = await renderStatementPdf(st);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    const mail = renderStatement(st, { firstName: null });
    expect(mail.text).toContain("INV-2026-0001");
    expect(mail.text).toContain("$1,000.00");
  });

  it("pdfSafe keeps Latin-1 accents and replaces the rest", () => {
    expect(pdfSafe("Café — “Zoë” 🚤")).toBe('Café - "Zoë" ?');
  });
});
