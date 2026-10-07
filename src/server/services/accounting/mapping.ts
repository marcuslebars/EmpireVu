/**
 * EmpireVu records → provider-neutral documents (pure, golden-tested).
 *
 * Invoices: one tax rate applies to the whole subtotal in EmpireVu, so the tax is split
 * across the taxed lines in proportion to their amounts (largest-remainder, so the parts
 * add up to the invoice tax exactly). Providers that accept a per-line tax amount (Xero)
 * then match our total to the cent; QuickBooks computes its own and any rounding
 * difference is noted on the link.
 *
 * Deposits (`credit_cents`):
 *   • online-booking deposit — it was its own (tax-free) invoice, already in the books
 *     with its payment, so the job's invoice carries a negative, untaxed "Deposit
 *     received" line. Revenue and tax come out right and nothing is counted twice.
 *   • quote deposit — paid before any invoice existed, so it isn't in the books yet. The
 *     invoice goes over at its full total and the deposit becomes a payment on it.
 */
import { createHash } from "node:crypto";

import { categoryLabel } from "@/server/services/expenses/rules";
import type { CustomerDoc, DocLine, ExpenseDoc, InvoiceDoc, PaymentDoc } from "./types";

export interface InvoiceRowLike {
  id: string;
  status: string;
  invoice_number: string | null;
  title: string | null;
  currency: string;
  line_items: unknown;
  subtotal_cents: number;
  tax_rate_bps: number;
  tax_cents: number;
  total_cents: number;
  credit_cents: number;
  issue_date: string | null;
  due_date: string | null;
  sent_at: string | null;
  created_at: string;
  contact_id: string | null;
  customer_account_id: string | null;
  bill_to: unknown;
}

interface BillTo {
  name?: string | null;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
}

const clean = (v: unknown, max = 200): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s+/g, " ");
  return t ? t.slice(0, max) : null;
};

/** YYYY-MM-DD of an instant in a time zone. */
export function localYmd(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone });
}

export function customerDoc(inv: Pick<InvoiceRowLike, "contact_id" | "customer_account_id" | "bill_to">): CustomerDoc {
  const b = (inv.bill_to && typeof inv.bill_to === "object" ? inv.bill_to : {}) as BillTo;
  const person = clean(b.name);
  const company = clean(b.company);
  const isAccount = Boolean(inv.customer_account_id);
  const key = isAccount ? `account:${inv.customer_account_id}` : `contact:${inv.contact_id}`;
  // QuickBooks DisplayName max 100; Xero Name max 255. Keep both safe.
  const name = ((isAccount ? company || person : person || company) ?? "Customer").slice(0, 90);
  const email = clean(b.email, 100);
  const phone = clean(b.phone, 30);
  const tag = email ?? phone ?? key.slice(-6);
  return { key, name, alternateName: `${name} (${tag})`.slice(0, 100), email, phone, address: clean(b.address, 500) };
}

/**
 * Split `tax` across lines in proportion to their amounts so the parts sum exactly to
 * `tax` (largest remainder). Untaxed lines get 0. Works with negative (discount) lines.
 */
export function allocateTax(amounts: number[], taxable: boolean[], tax: number): number[] {
  const base = amounts.reduce((s, a, i) => s + (taxable[i] ? a : 0), 0);
  if (tax === 0 || base === 0) return amounts.map(() => 0);
  const exact = amounts.map((a, i) => (taxable[i] ? (tax * a) / base : 0));
  const floored = exact.map((x) => Math.floor(x));
  let remainder = tax - floored.reduce((s, x) => s + x, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .filter(({ i }) => taxable[i])
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remainder > 0 && order.length; k++, remainder--) floored[order[k % order.length].i] += 1;
  return floored;
}

interface RawLine {
  label?: unknown;
  description?: unknown;
  quantity?: unknown;
  unitPriceCents?: unknown;
  amountCents?: unknown;
}

/** Memo platform name when the caller doesn't pass the org's brand. */
export const DEFAULT_PRODUCT_NAME = "EmpireVu";

export function invoiceDoc(
  inv: InvoiceRowLike,
  opts: {
    timeZone: string;
    depositAsLine: boolean;
    depositInvoiceNumber?: string | null;
    /** Platform name in memos ("EmpireVu" / "CrankLeads" — the org's platform brand). */
    productName?: string;
  },
): InvoiceDoc {
  let raw = Array.isArray(inv.line_items) ? (inv.line_items as RawLine[]) : [];
  // An invoice with a total but no lines (e.g. imported) still needs a line in the books.
  if (raw.length === 0 && inv.subtotal_cents !== 0) {
    raw = [{ label: inv.title ?? "Services", quantity: 1, unitPriceCents: inv.subtotal_cents, amountCents: inv.subtotal_cents }];
  }
  const taxed = inv.tax_rate_bps > 0 && inv.tax_cents !== 0;
  const base = raw.map((l) => {
    const label = clean(l.label, 300) ?? "Item";
    const desc = clean(l.description, 700);
    const quantity = Number(l.quantity) || 0;
    const unit = Math.round(Number(l.unitPriceCents) || 0);
    const amount = Math.round(Number(l.amountCents ?? quantity * unit) || 0);
    return { description: desc ? `${label} — ${desc}` : label, quantity, unitPriceCents: unit, amountCents: amount };
  });
  const taxes = allocateTax(
    base.map((l) => l.amountCents),
    base.map(() => taxed),
    taxed ? inv.tax_cents : 0,
  );
  const lines: DocLine[] = base.map((l, i) => ({ ...l, taxable: taxed, taxCents: taxes[i] }));
  let total = inv.total_cents;
  if (inv.credit_cents > 0 && opts.depositAsLine) {
    lines.push({
      description: opts.depositInvoiceNumber ? `Deposit received (invoice ${opts.depositInvoiceNumber})` : "Deposit received",
      quantity: 1,
      unitPriceCents: -inv.credit_cents,
      amountCents: -inv.credit_cents,
      taxable: false,
      taxCents: 0,
    });
    total -= inv.credit_cents;
  }
  const issueDate = inv.issue_date ?? localYmd(inv.sent_at ?? inv.created_at, opts.timeZone);
  return {
    localId: inv.id,
    number: inv.invoice_number,
    title: clean(inv.title, 200),
    issueDate,
    dueDate: inv.due_date && inv.due_date >= issueDate ? inv.due_date : issueDate,
    currency: inv.currency || "CAD",
    lines,
    subtotalCents: lines.reduce((s, l) => s + l.amountCents, 0),
    taxCents: taxed ? inv.tax_cents : 0,
    totalCents: total,
    voided: inv.status === "void",
    memo: [`From ${opts.productName ?? DEFAULT_PRODUCT_NAME}`, inv.invoice_number, clean(inv.title, 120)].filter(Boolean).join(" · "),
  };
}

const METHOD_LABELS: Record<string, string> = {
  card: "Card",
  bank_debit: "Bank debit",
  etransfer: "e-Transfer",
  cheque: "Cheque",
  cash: "Cash",
  other: "Other",
};

export function paymentDoc(
  p: { id: string; invoice_id: string; amount_cents: number; method: string; reference: string | null; received_at: string },
  timeZone: string,
  productName: string = DEFAULT_PRODUCT_NAME,
): PaymentDoc {
  const method = METHOD_LABELS[p.method] ?? "Payment";
  return {
    localKey: p.id,
    invoiceLocalId: p.invoice_id,
    amountCents: p.amount_cents,
    date: localYmd(p.received_at, timeZone),
    method: p.method,
    reference: clean(p.reference, 21),
    memo: `${method} via ${productName}${p.reference ? ` (${clean(p.reference, 60)})` : ""}`,
  };
}

/** A quote deposit taken before the invoice existed, booked as a payment on it. */
export function depositPaymentDoc(
  inv: Pick<InvoiceRowLike, "id" | "credit_cents" | "issue_date">,
  paidAt: string | null,
  timeZone: string,
  productName: string = DEFAULT_PRODUCT_NAME,
): PaymentDoc {
  return {
    localKey: `deposit:${inv.id}`,
    invoiceLocalId: inv.id,
    amountCents: inv.credit_cents,
    date: paidAt ? localYmd(paidAt, timeZone) : (inv.issue_date ?? localYmd(new Date().toISOString(), timeZone)),
    method: "card",
    reference: null,
    memo: `Deposit paid on the quote, via ${productName}`,
  };
}

export function expenseDoc(e: {
  id: string;
  spent_on: string;
  vendor: string | null;
  description: string | null;
  category: string;
  amount_cents: number;
  tax_cents: number;
  paid_with: string;
}, productName: string = DEFAULT_PRODUCT_NAME): ExpenseDoc {
  const vendor = clean(e.vendor, 90);
  const description = clean(e.description, 400) ?? vendor ?? categoryLabel(e.category);
  return {
    localId: e.id,
    date: e.spent_on,
    vendorName: vendor,
    description,
    category: e.category,
    netCents: Math.max(0, e.amount_cents - e.tax_cents),
    taxCents: e.tax_cents,
    totalCents: e.amount_cents,
    personal: e.paid_with === "personal",
    memo: `${e.paid_with === "personal" ? "Paid out of pocket" : "Paid by the business"} · from ${productName}`,
  };
}

/** Stable hash of what we'd send, so an unchanged record is never pushed again. */
export function docHash(...parts: unknown[]): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return createHash("sha256").update(JSON.stringify(stable(parts))).digest("hex").slice(0, 32);
}

/** Cents → the decimal a provider API expects. */
export const dollars = (cents: number): number => Math.round(cents) / 100;
/** A provider decimal → cents. */
export const toCents = (amount: unknown): number | null => {
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
