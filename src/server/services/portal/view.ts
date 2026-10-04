/**
 * The customer portal page model — pure shaping from rows to what the customer sees.
 * Nothing internal leaves here: no ids except public tokens/links, no staff notes,
 * no crew names, no costs.
 */
import { formatCalendarDate } from "@/server/services/invoices/document";
import type { InvoiceBrand } from "@/server/services/invoices/document";

export interface PortalVisit {
  title: string;
  when: string;
  date: string;
  location: string | null;
  status: "upcoming" | "on_the_way" | "in_progress" | "done";
}

export interface PortalQuote {
  number: string | null;
  title: string | null;
  totalCents: number;
  status: "open" | "approved" | "expired";
  validUntil: string | null;
  url: string;
}

export interface PortalInvoice {
  number: string | null;
  title: string | null;
  issueDate: string | null;
  dueDate: string | null;
  totalCents: number;
  balanceCents: number;
  status: "due" | "overdue" | "paid" | "processing";
  url: string;
}

export interface PortalView {
  brand: InvoiceBrand;
  customerName: string;
  currency: string;
  balanceCents: number;
  overdueCents: number;
  upcoming: PortalVisit[];
  past: PortalVisit[];
  quotes: PortalQuote[];
  invoices: PortalInvoice[];
}

export function visitWhen(iso: string, timeZone: string): { when: string; date: string } {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-CA", { timeZone, weekday: "long", month: "long", day: "numeric" });
  const time = d.toLocaleTimeString("en-CA", { timeZone, hour: "numeric", minute: "2-digit" });
  return { when: `${date} at ${time}`, date: d.toLocaleDateString("en-CA", { timeZone }) };
}

export function visitStatus(b: { status: string; en_route_at?: string | null; started_at?: string | null }): PortalVisit["status"] {
  if (b.status === "completed") return "done";
  if (b.started_at) return "in_progress";
  if (b.en_route_at) return "on_the_way";
  return "upcoming";
}

/** Customer-facing quote state; drafts, cancelled and superseded quotes are never shown. */
export function quoteState(q: { status: string; superseded_by?: string | null }): PortalQuote["status"] | null {
  if (q.superseded_by) return null;
  if (q.status === "sent" || q.status === "viewed") return "open";
  if (q.status === "approved" || q.status === "deposit_paid" || q.status === "completed") return "approved";
  if (q.status === "expired") return "expired";
  return null;
}

/** Customer-facing invoice state; drafts and void invoices are never shown. */
export function invoiceState(
  inv: { status: string; balance_due_cents: number; pending_payment_cents: number; due_date: string | null },
  today: string,
): PortalInvoice["status"] | null {
  if (inv.status === "draft" || inv.status === "void") return null;
  if (inv.status === "paid" || inv.balance_due_cents <= 0) return "paid";
  if (inv.pending_payment_cents >= inv.balance_due_cents) return "processing";
  if (inv.due_date && inv.due_date < today) return "overdue";
  return "due";
}

export function dateLabel(ymd: string | null): string | null {
  return formatCalendarDate(ymd);
}
