/**
 * The customer-facing view of an invoice — one shape shared by the PDF, the
 * emails and the public /i/{token} page, so all three always say the same thing.
 *
 * PURE: built from rows the caller already loaded. It carries no internal ids and
 * no Stripe ids, because the public page returns it as-is to an anonymous browser.
 * Branding comes entirely from the COMPANY; the platform is named nowhere.
 */
import type { CompanyForInvoice, InvoiceRow } from "./common";
import { invoicePublicUrl, readBillTo, todayFor, type BillTo } from "./common";
import { isOverdue, type InvoiceLine } from "./math";
import { parseInvoiceSettings } from "./settings";

export interface InvoiceBrand {
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  replyEmail: string | null;
  replyPhone: string | null;
  websiteUrl: string | null;
  address: string | null;
  taxRegistrationNumber: string | null;
}

export interface InvoicePaymentOptions {
  /** Pay online by card / Apple Pay / Google Pay. */
  card: boolean;
  /** Pay online by Canadian pre-authorized debit. */
  bankDebit: boolean;
  etransfer: { email: string; instructions: string | null } | null;
  cheque: { payableTo: string; mailTo: string | null } | null;
  cash: boolean;
}

export type InvoicePageState = "open" | "overdue" | "partially_paid" | "processing" | "paid" | "void";

export interface InvoiceDocument {
  token: string;
  invoiceNumber: string | null;
  title: string | null;
  status: string;
  state: InvoicePageState;
  currency: string;
  issueDate: string | null;
  dueDate: string | null;
  paymentTermsDays: number;
  billTo: BillTo;
  lines: InvoiceLine[];
  subtotalCents: number;
  taxRateBps: number;
  taxCents: number;
  totalCents: number;
  creditCents: number;
  paidCents: number;
  /** Bank debits started but not cleared yet. */
  pendingCents: number;
  balanceCents: number;
  notes: string | null;
  footerText: string | null;
  paidAt: string | null;
  brand: InvoiceBrand;
  payment: InvoicePaymentOptions;
  publicUrl: string;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function readLines(raw: unknown): InvoiceLine[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((l) => l && typeof l === "object")
    .map((l) => {
      const o = l as Record<string, unknown>;
      return {
        label: str(o.label) ?? "Item",
        description: str(o.description),
        quantity: Number(o.quantity ?? 1),
        unitPriceCents: Number(o.unitPriceCents ?? 0),
        amountCents: Number(o.amountCents ?? 0),
      };
    });
}

export function brandOfCompany(company: CompanyForInvoice | null): InvoiceBrand {
  return {
    name: str(company?.brand_from_name) ?? str(company?.name) ?? "Invoice",
    logoUrl: str(company?.brand_logo_url),
    primaryColor: str(company?.brand_primary_color),
    accentColor: str(company?.brand_accent_color),
    replyEmail: str(company?.brand_reply_email),
    replyPhone: str(company?.brand_reply_phone),
    websiteUrl: str(company?.brand_website_url),
    address: str(company?.business_address),
    taxRegistrationNumber: str(company?.tax_registration_number),
  };
}

export function paymentOptionsFor(company: CompanyForInvoice | null): InvoicePaymentOptions {
  const s = parseInvoiceSettings(company?.invoice_settings ?? null);
  const stripeReady = Boolean(company?.stripe_connected_account_id && company?.stripe_charges_enabled);
  return {
    card: stripeReady && s.acceptCard,
    bankDebit: stripeReady && s.acceptBankDebit,
    etransfer: s.acceptEtransfer && s.etransferEmail ? { email: s.etransferEmail, instructions: s.etransferInstructions } : null,
    cheque: s.acceptCheque ? { payableTo: s.chequePayableTo ?? brandOfCompany(company).name, mailTo: s.chequeMailingAddress ?? str(company?.business_address) } : null,
    cash: s.acceptCash,
  };
}

export function pageStateOf(invoice: Pick<InvoiceRow, "status" | "due_date" | "balance_due_cents" | "pending_payment_cents">, today: string): InvoicePageState {
  if (invoice.status === "void") return "void";
  if (invoice.status === "paid") return "paid";
  if (invoice.pending_payment_cents > 0 && invoice.pending_payment_cents >= invoice.balance_due_cents) return "processing";
  if (isOverdue(invoice, today)) return "overdue";
  if (invoice.status === "partially_paid") return "partially_paid";
  return "open";
}

export function buildInvoiceDocument(invoice: InvoiceRow, company: CompanyForInvoice | null, now: Date = new Date()): InvoiceDocument {
  const settings = parseInvoiceSettings(company?.invoice_settings ?? null);
  return {
    token: invoice.public_token,
    invoiceNumber: invoice.invoice_number,
    title: invoice.title,
    status: invoice.status,
    state: pageStateOf(invoice, todayFor(company, now)),
    currency: invoice.currency,
    issueDate: invoice.issue_date,
    dueDate: invoice.due_date,
    paymentTermsDays: invoice.payment_terms_days,
    billTo: readBillTo(invoice.bill_to),
    lines: readLines(invoice.line_items),
    subtotalCents: invoice.subtotal_cents,
    taxRateBps: invoice.tax_rate_bps,
    taxCents: invoice.tax_cents,
    totalCents: invoice.total_cents,
    creditCents: invoice.credit_cents,
    paidCents: invoice.amount_paid_cents,
    pendingCents: invoice.pending_payment_cents,
    balanceCents: invoice.balance_due_cents,
    notes: invoice.notes,
    footerText: settings.footerText,
    paidAt: invoice.paid_at,
    brand: brandOfCompany(company),
    payment: paymentOptionsFor(company),
    publicUrl: invoicePublicUrl(company, invoice.public_token),
  };
}

// ── Formatting shared by PDF + emails ────────────────────────────────────────

export function formatMoney(cents: number, currency = "CAD"): string {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency }).format(cents / 100);
}

/** "October 30, 2026" from a calendar date, with no time-zone shift. */
export function formatCalendarDate(ymd: string | null): string | null {
  if (!ymd) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function formatTaxRate(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(2).replace(/0$/, "")}%`;
}

export function termsLabel(days: number): string {
  return days <= 0 ? "Due on receipt" : `Net ${days}`;
}
