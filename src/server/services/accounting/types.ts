/**
 * Provider-neutral shapes for accounting sync. The engine turns EmpireVu records into
 * these documents (./mapping.ts, pure); each provider turns them into its own API calls.
 * Money is integer cents everywhere here; providers convert to decimal at the edge.
 */
import { z } from "zod";

import { EXPENSE_CATEGORIES } from "@/server/services/expenses/rules";
import type { ProviderId } from "./config";

// ── Settings (the account mapping) ───────────────────────────────────────────

export const refSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().max(300),
  /** Provider account type where it matters (QuickBooks: "Credit Card" pays differently). */
  kind: z.string().max(60).nullish(),
});
export type Ref = z.infer<typeof refSchema>;

export const settingsSchema = z.object({
  syncInvoices: z.boolean().default(true),
  syncExpenses: z.boolean().default(true),
  /** QuickBooks: the product/service each line is booked to. Xero: the sales account code. */
  incomeTarget: refSchema.nullable().default(null),
  /** Tax code / type for taxed invoice lines, and for untaxed ones (deposits, 0% invoices). */
  salesTaxCode: refSchema.nullable().default(null),
  salesExemptCode: refSchema.nullable().default(null),
  /** QuickBooks: deposit-to account (Undeposited Funds or a bank). Xero: the bank account. */
  paymentAccount: refSchema.nullable().default(null),
  /** Category → expense account; anything unmapped goes to the fallback. */
  expenseAccounts: z.record(z.enum(EXPENSE_CATEGORIES), refSchema).default({}),
  expenseFallbackAccount: refSchema.nullable().default(null),
  purchaseTaxCode: refSchema.nullable().default(null),
  purchaseExemptCode: refSchema.nullable().default(null),
  /** Bank / card account business-paid expenses come out of. */
  paidFromBusiness: refSchema.nullable().default(null),
  /** Where out-of-pocket expenses are booked from (often a "due to owner/employee" bank-type account). */
  paidFromPersonal: refSchema.nullable().default(null),
  /** From the file at connect time: "US" uses US sales tax rules in QuickBooks. */
  country: z.string().max(2).nullish(),
  currency: z.string().max(3).nullish(),
});
export type AccountingSettings = z.infer<typeof settingsSchema>;

export function parseSettings(raw: unknown): AccountingSettings {
  const r = settingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : settingsSchema.parse({});
}

/** What's still missing before each side can sync — shown in Settings; the engine refuses until empty. */
export function missingSettings(s: AccountingSettings, provider: ProviderId): { invoices: string[]; expenses: string[] } {
  const usQbo = provider === "quickbooks" && s.country === "US";
  const invoices: string[] = [];
  if (!s.incomeTarget) invoices.push(provider === "quickbooks" ? "Product/service for invoice lines" : "Sales account");
  if (!usQbo && !s.salesTaxCode) invoices.push("Sales tax code");
  if (!usQbo && !s.salesExemptCode) invoices.push("No-tax code");
  if (!s.paymentAccount) invoices.push(provider === "quickbooks" ? "Account payments go to" : "Bank account payments go to");
  const expenses: string[] = [];
  if (!s.expenseFallbackAccount) expenses.push("Default expense account");
  if (!s.paidFromBusiness) expenses.push("Account business expenses are paid from");
  if (!usQbo && !s.purchaseTaxCode) expenses.push("Purchase tax code");
  if (!usQbo && !s.purchaseExemptCode) expenses.push("No-tax purchase code");
  return { invoices, expenses };
}

/** What the mapping form can pick from, read live from the file. */
export interface ProviderOptions {
  incomeTargets: Ref[];
  salesTaxCodes: Ref[];
  purchaseTaxCodes: Ref[];
  depositAccounts: Ref[];
  paidFromAccounts: Ref[];
  expenseAccounts: Ref[];
}

// ── Documents ────────────────────────────────────────────────────────────────

export interface CustomerDoc {
  /** "contact:<uuid>" or "account:<uuid>" — the link key. */
  key: string;
  name: string;
  /** Used to tell two different customers with the same name apart. */
  alternateName: string;
  email: string | null;
  phone: string | null;
  address: string | null;
}

export interface DocLine {
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  taxable: boolean;
  /** This line's share of the invoice tax (sums exactly to the invoice tax). */
  taxCents: number;
}

export interface InvoiceDoc {
  localId: string;
  number: string | null;
  title: string | null;
  issueDate: string;
  dueDate: string;
  currency: string;
  lines: DocLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  voided: boolean;
  memo: string;
}

export interface PaymentDoc {
  /** invoice_payments.id, or "deposit:<invoiceId>" for a quote deposit taken before the invoice. */
  localKey: string;
  invoiceLocalId: string;
  amountCents: number;
  date: string;
  method: string;
  reference: string | null;
  memo: string;
}

export interface ExpenseDoc {
  localId: string;
  date: string;
  vendorName: string | null;
  description: string;
  category: string;
  /** Before tax, and the tax inside the total. */
  netCents: number;
  taxCents: number;
  totalCents: number;
  personal: boolean;
  memo: string;
}

/** A record as it exists in the file, enough to update / delete it. */
export interface RemoteRef {
  id: string;
  version: string | null;
}

export interface PushResult extends RemoteRef {
  /** The provider's total for the document, when it reports one. */
  totalCents: number | null;
}

// ── Provider ─────────────────────────────────────────────────────────────────

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date | null;
}

export interface ConnectedFile {
  tenantId: string;
  name: string | null;
  country: string | null;
  currency: string | null;
}

/** An authorised handle on one file. */
export interface ProviderSession {
  tenantId: string;
  accessToken: string;
  environment: "sandbox" | "production";
  fetch: typeof fetch;
}

export interface AccountingProvider {
  id: ProviderId;
  authorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(input: { code: string; redirectUri: string; query: URLSearchParams }, f?: typeof fetch): Promise<{ tokens: TokenSet; file: ConnectedFile }>;
  refresh(refreshToken: string, f?: typeof fetch): Promise<TokenSet>;
  revoke(tokens: { accessToken: string; refreshToken: string; tenantId: string }, f?: typeof fetch): Promise<void>;
  options(s: ProviderSession): Promise<ProviderOptions>;
  findOrCreateCustomer(s: ProviderSession, c: CustomerDoc, takenRemoteIds: Set<string>): Promise<RemoteRef>;
  findOrCreateVendor(s: ProviderSession, name: string): Promise<RemoteRef | null>;
  pushInvoice(s: ProviderSession, doc: InvoiceDoc, customer: RemoteRef, settings: AccountingSettings, existing: RemoteRef | null): Promise<PushResult>;
  voidInvoice(s: ProviderSession, existing: RemoteRef): Promise<void>;
  pushPayment(s: ProviderSession, doc: PaymentDoc, invoice: RemoteRef, customer: RemoteRef, settings: AccountingSettings, existing: RemoteRef | null): Promise<PushResult>;
  deletePayment(s: ProviderSession, existing: RemoteRef): Promise<void>;
  pushExpense(s: ProviderSession, doc: ExpenseDoc, vendor: RemoteRef | null, settings: AccountingSettings, existing: RemoteRef | null): Promise<PushResult>;
  deleteExpense(s: ProviderSession, existing: RemoteRef): Promise<void>;
  attachReceipt(s: ProviderSession, expense: RemoteRef, file: { bytes: Buffer; contentType: string; fileName: string }): Promise<void>;
}

/**
 * A provider call failed. `retryable` → back off and try again (rate limit, outage);
 * `reauth` → the connection's tokens no longer work; otherwise it needs a person
 * (bad mapping, the record was changed in the file…).
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly opts: { status?: number; retryable?: boolean; reauth?: boolean; code?: string; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "ProviderError";
  }
  get retryable(): boolean {
    return Boolean(this.opts.retryable);
  }
  get reauth(): boolean {
    return Boolean(this.opts.reauth);
  }
}
