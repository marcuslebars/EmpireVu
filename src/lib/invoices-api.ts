/**
 * Client API for invoices, business (customer) accounts and invoice settings.
 * Mirrors src/app/api/organizations/[organizationId]/{invoices,customer-accounts,invoice-settings}.
 */
import { ApiError, apiAuthHeaders, apiFetch, resolveApiUrl } from "@/lib/api-client";

// ─── Types ───────────────────────────────────────────────────────────────────

export type InvoiceStatus = "draft" | "sent" | "viewed" | "partially_paid" | "paid" | "void";
export type InvoiceFilter = "all" | "draft" | "open" | "overdue" | "paid" | "void";
export type PaymentMethod = "card" | "bank_debit" | "etransfer" | "cheque" | "cash" | "other";

export interface InvoiceLine {
  label: string;
  description: string | null;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
}

export interface BillTo {
  name: string;
  attention: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  taxNumber: string | null;
}

export interface Invoice {
  id: string;
  organization_id: string;
  company_id: string;
  contact_id: string | null;
  customer_account_id: string | null;
  quote_id: string | null;
  booking_id: string | null;
  invoice_number: string | null;
  public_token: string;
  status: InvoiceStatus;
  currency: string;
  title: string | null;
  line_items: InvoiceLine[];
  subtotal_cents: number;
  tax_rate_bps: number;
  tax_cents: number;
  total_cents: number;
  credit_cents: number;
  amount_paid_cents: number;
  pending_payment_cents: number;
  balance_due_cents: number;
  issue_date: string | null;
  due_date: string | null;
  payment_terms_days: number;
  bill_to: BillTo;
  notes: string | null;
  internal_notes: string | null;
  sent_at: string | null;
  first_viewed_at: string | null;
  paid_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  reminder_count: number;
  created_at: string;
  updated_at: string;
  /** List + detail only. */
  overdue?: boolean;
  bill_to_name?: string;
}

export interface InvoicePayment {
  id: string;
  invoice_id: string;
  amount_cents: number;
  method: PaymentMethod;
  status: "pending" | "succeeded" | "failed" | "refunded";
  reference: string | null;
  received_at: string;
  notes: string | null;
  stripe_payment_intent_id: string | null;
  failure_reason: string | null;
  created_at: string;
}

export interface InvoiceEvent {
  id: string;
  event_type: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface InvoiceDetail {
  invoice: Invoice & { overdue: boolean };
  payments: InvoicePayment[];
  events: InvoiceEvent[];
  publicUrl: string;
  online: { card: boolean; bankDebit: boolean; stripeReady: boolean };
}

export interface InvoiceListSummary {
  outstandingCents: number;
  overdueCents: number;
  overdueCount: number;
  clearingCents: number;
}

export interface InvoiceLineInput {
  label: string;
  description?: string | null;
  quantity: number;
  unitPriceCents: number;
}

export interface InvoiceWritePayload {
  contactId?: string | null;
  customerAccountId?: string | null;
  title?: string | null;
  lines: InvoiceLineInput[];
  taxRateBps?: number | null;
  creditCents?: number | null;
  dueDate?: string | null;
  paymentTermsDays?: number | null;
  notes?: string | null;
  internalNotes?: string | null;
  billToAddress?: string | null;
}

export interface DeliveryOutcome {
  delivered: boolean;
  reason: string | null;
  to?: string | null;
}

export interface CustomerAccount {
  id: string;
  name: string;
  billing_email: string | null;
  billing_phone: string | null;
  billing_address: string | null;
  tax_number: string | null;
  payment_terms_days: number | null;
  notes: string | null;
  archived_at: string | null;
  created_at: string;
  contact_count?: number;
  open_balance_cents?: number;
  overdue_count?: number;
}

export interface CustomerAccountPayload {
  name: string;
  billingEmail?: string | null;
  billingPhone?: string | null;
  billingAddress?: string | null;
  taxNumber?: string | null;
  paymentTermsDays?: number | null;
  notes?: string | null;
}

export interface CustomerAccountDetail {
  account: CustomerAccount;
  contacts: Array<{ id: string; first_name: string; last_name: string | null; email: string | null; phone: string | null }>;
}

export interface InvoiceSettingsValues {
  numberPrefix: string;
  paymentTermsDays: number;
  taxRateBps: number;
  footerText: string | null;
  acceptCard: boolean;
  acceptBankDebit: boolean;
  acceptEtransfer: boolean;
  etransferEmail: string | null;
  etransferInstructions: string | null;
  acceptCheque: boolean;
  chequePayableTo: string | null;
  chequeMailingAddress: string | null;
  acceptCash: boolean;
  remindersEnabled: boolean;
  reminderDays: number[];
}

export interface CompanyInvoiceSettings {
  companyId: string;
  companyName: string;
  taxRegistrationNumber: string | null;
  businessAddress: string | null;
  settings: InvoiceSettingsValues;
  stripeReady: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** For responses that carry more than `data` (email / sms / receipt outcomes). */
async function fetchBody<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(resolveApiUrl(path), {
    ...init,
    headers: { "Content-Type": "application/json", ...(await apiAuthHeaders()), ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? `API error ${res.status}: ${res.statusText}`, body);
  return body;
}

const base = (orgId: string) => `/api/organizations/${orgId}`;

// ─── Invoices ────────────────────────────────────────────────────────────────

export interface FetchInvoicesOptions {
  filter?: InvoiceFilter;
  companyId?: string;
  contactId?: string;
  customerAccountId?: string;
  quoteId?: string;
  bookingId?: string;
}

export async function fetchInvoices(
  orgId: string,
  opts: FetchInvoicesOptions = {},
): Promise<{ invoices: Invoice[]; summary: InvoiceListSummary }> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) if (v) params.set(k, String(v));
  const qs = params.toString();
  const body = await fetchBody<{ data: Invoice[]; summary: InvoiceListSummary }>(`${base(orgId)}/invoices${qs ? `?${qs}` : ""}`);
  return { invoices: body.data, summary: body.summary };
}

export function fetchInvoice(orgId: string, invoiceId: string): Promise<InvoiceDetail> {
  return apiFetch<InvoiceDetail>(`${base(orgId)}/invoices/${invoiceId}`);
}

export function createInvoice(orgId: string, payload: InvoiceWritePayload & { companyId: string }): Promise<Invoice> {
  return apiFetch<Invoice>(`${base(orgId)}/invoices`, { method: "POST", body: JSON.stringify(payload) });
}

export function updateInvoice(orgId: string, invoiceId: string, payload: Partial<InvoiceWritePayload>): Promise<Invoice> {
  return apiFetch<Invoice>(`${base(orgId)}/invoices/${invoiceId}`, { method: "PATCH", body: JSON.stringify(payload) });
}

export async function sendInvoice(
  orgId: string,
  invoiceId: string,
  opts: { email?: boolean; sms?: boolean } = {},
): Promise<{ invoice: Invoice; email: DeliveryOutcome | null; sms: DeliveryOutcome | null; publicUrl: string }> {
  const body = await fetchBody<{ data: Invoice; email: DeliveryOutcome | null; sms: DeliveryOutcome | null; publicUrl: string }>(
    `${base(orgId)}/invoices/${invoiceId}/send`,
    { method: "POST", body: JSON.stringify(opts) },
  );
  return { invoice: body.data, email: body.email, sms: body.sms, publicUrl: body.publicUrl };
}

export function voidInvoice(orgId: string, invoiceId: string, reason?: string): Promise<Invoice> {
  return apiFetch<Invoice>(`${base(orgId)}/invoices/${invoiceId}/void`, { method: "POST", body: JSON.stringify({ reason: reason ?? null }) });
}

export interface RecordPaymentPayload {
  amountCents: number;
  method: PaymentMethod;
  receivedAt?: string | null;
  reference?: string | null;
  notes?: string | null;
  sendReceipt?: boolean;
}

export async function recordInvoicePayment(
  orgId: string,
  invoiceId: string,
  payload: RecordPaymentPayload,
): Promise<{ invoice: Invoice; payment: InvoicePayment; receipt: DeliveryOutcome | null }> {
  const body = await fetchBody<{ data: Invoice; payment: InvoicePayment; receipt: DeliveryOutcome | null }>(
    `${base(orgId)}/invoices/${invoiceId}/payments`,
    { method: "POST", body: JSON.stringify(payload) },
  );
  return { invoice: body.data, payment: body.payment, receipt: body.receipt };
}

export function removeInvoicePayment(orgId: string, invoiceId: string, paymentId: string): Promise<Invoice> {
  return apiFetch<Invoice>(`${base(orgId)}/invoices/${invoiceId}/payments/${paymentId}`, { method: "DELETE" });
}

/** Quote → draft invoice. On 409 the ApiError body carries `existingInvoiceId`. */
export function createInvoiceFromQuote(orgId: string, quoteId: string): Promise<Invoice> {
  return apiFetch<Invoice>(`${base(orgId)}/invoices/from-quote`, { method: "POST", body: JSON.stringify({ quoteId }) });
}

/** Booking → draft invoice. On 409 the ApiError body carries `existingInvoiceId`. */
export function createInvoiceFromBooking(orgId: string, bookingId: string): Promise<Invoice> {
  return apiFetch<Invoice>(`${base(orgId)}/invoices/from-booking`, { method: "POST", body: JSON.stringify({ bookingId }) });
}

/** The id of the invoice that already exists, when a convert call answered 409. */
export function existingInvoiceIdFrom(err: unknown): string | null {
  if (err instanceof ApiError && err.status === 409 && err.body && typeof err.body === "object") {
    const id = (err.body as { existingInvoiceId?: unknown }).existingInvoiceId;
    return typeof id === "string" ? id : null;
  }
  return null;
}

/** Staff PDF (works for drafts). Same-origin, cookie-authenticated. */
export function invoicePdfUrl(orgId: string, invoiceId: string, download = false): string {
  return resolveApiUrl(`${base(orgId)}/invoices/${invoiceId}/pdf${download ? "?download=1" : ""}`);
}

// ─── Business accounts ───────────────────────────────────────────────────────

export function fetchCustomerAccounts(orgId: string, opts: { q?: string; archived?: boolean } = {}): Promise<CustomerAccount[]> {
  const params = new URLSearchParams();
  if (opts.q) params.set("q", opts.q);
  if (opts.archived) params.set("archived", "1");
  const qs = params.toString();
  return apiFetch<CustomerAccount[]>(`${base(orgId)}/customer-accounts${qs ? `?${qs}` : ""}`);
}

export function fetchCustomerAccount(orgId: string, accountId: string): Promise<CustomerAccountDetail> {
  return apiFetch<CustomerAccountDetail>(`${base(orgId)}/customer-accounts/${accountId}`);
}

export function createCustomerAccount(orgId: string, payload: CustomerAccountPayload): Promise<CustomerAccount> {
  return apiFetch<CustomerAccount>(`${base(orgId)}/customer-accounts`, { method: "POST", body: JSON.stringify(payload) });
}

export function updateCustomerAccount(
  orgId: string,
  accountId: string,
  payload: Partial<CustomerAccountPayload> & { archived?: boolean },
): Promise<CustomerAccount> {
  return apiFetch<CustomerAccount>(`${base(orgId)}/customer-accounts/${accountId}`, { method: "PATCH", body: JSON.stringify(payload) });
}

export function linkContactToAccount(orgId: string, accountId: string, contactId: string, linked = true): Promise<unknown> {
  return apiFetch(`${base(orgId)}/customer-accounts/${accountId}/contacts`, { method: "POST", body: JSON.stringify({ contactId, linked }) });
}

export function statementPdfUrl(orgId: string, accountId: string, companyId: string): string {
  return resolveApiUrl(`${base(orgId)}/customer-accounts/${accountId}/statement?companyId=${encodeURIComponent(companyId)}`);
}

export function sendStatement(orgId: string, accountId: string, companyId: string, to?: string | null): Promise<DeliveryOutcome> {
  return apiFetch<DeliveryOutcome>(`${base(orgId)}/customer-accounts/${accountId}/statement`, {
    method: "POST",
    body: JSON.stringify({ companyId, to: to || null }),
  });
}

// ─── Invoice settings (per company) ─────────────────────────────────────────

export function fetchInvoiceSettings(orgId: string, companyId: string): Promise<CompanyInvoiceSettings> {
  return apiFetch<CompanyInvoiceSettings>(`${base(orgId)}/invoice-settings/${companyId}`);
}

export function updateInvoiceSettings(
  orgId: string,
  companyId: string,
  payload: { taxRegistrationNumber?: string | null; businessAddress?: string | null; settings?: Partial<InvoiceSettingsValues> },
): Promise<CompanyInvoiceSettings> {
  return apiFetch<CompanyInvoiceSettings>(`${base(orgId)}/invoice-settings/${companyId}`, { method: "PATCH", body: JSON.stringify(payload) });
}

// ─── Public invoice page ─────────────────────────────────────────────────────

export interface PublicInvoice {
  token: string;
  invoiceNumber: string | null;
  title: string | null;
  status: InvoiceStatus;
  state: "open" | "overdue" | "partially_paid" | "processing" | "paid" | "void";
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
  pendingCents: number;
  balanceCents: number;
  notes: string | null;
  footerText: string | null;
  paidAt: string | null;
  brand: {
    name: string;
    logoUrl: string | null;
    primaryColor: string | null;
    accentColor: string | null;
    replyEmail: string | null;
    replyPhone: string | null;
    websiteUrl: string | null;
    address: string | null;
    taxRegistrationNumber: string | null;
  };
  payment: {
    card: boolean;
    bankDebit: boolean;
    etransfer: { email: string; instructions: string | null } | null;
    cheque: { payableTo: string; mailTo: string | null } | null;
    cash: boolean;
  };
  publicUrl: string;
}

export function fetchPublicInvoice(token: string): Promise<PublicInvoice> {
  return apiFetch<PublicInvoice>(`/api/public/invoices/${encodeURIComponent(token)}`);
}

export function startInvoicePayment(token: string, method: "card" | "bank_debit"): Promise<{ url: string }> {
  return apiFetch<{ url: string }>(`/api/public/invoices/${encodeURIComponent(token)}/pay`, {
    method: "POST",
    body: JSON.stringify({ method }),
  });
}

export function publicInvoicePdfUrl(token: string, download = false): string {
  return resolveApiUrl(`/api/public/invoices/${encodeURIComponent(token)}/pdf${download ? "?download=1" : ""}`);
}

// ─── Formatting (shared by the screens) ─────────────────────────────────────

export function formatCents(cents: number, currency = "CAD"): string {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency }).format(cents / 100);
}

/** "Oct 30, 2026" from YYYY-MM-DD without a time-zone shift. */
export function formatYmd(ymd: string | null | undefined, style: "short" | "long" = "short"): string {
  if (!ymd) return "—";
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: style === "long" ? "long" : "short",
    day: "numeric",
  });
}

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  card: "Card",
  bank_debit: "Bank debit (PAD)",
  etransfer: "Interac e-Transfer",
  cheque: "Cheque",
  cash: "Cash",
  other: "Other",
};

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Viewed",
  partially_paid: "Partly paid",
  paid: "Paid",
  void: "Void",
};
