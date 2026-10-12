/**
 * The Tax Clerk's tables (20261013100000_staff_tax_clerk.sql), typed here until they're merged
 * into database.types.ts. Queries go through the `Db = any` cast (like sms-agent) so the
 * generated types don't need these tables yet.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = any;

export type ReceiptTextStatus = "reading" | "filed" | "duplicate" | "needs_review" | "not_receipt" | "failed" | "deleted" | "discarded";
export type HstFrequency = "monthly" | "quarterly" | "annual";
export type FilerType = "individual" | "corporation";

export interface ReceiptTextRow {
  id: string;
  organization_id: string;
  company_id: string;
  log_id: string;
  media_index: number;
  status: ReceiptTextStatus;
  expense_id: string | null;
  duplicate_of: string | null;
  file_path: string | null;
  file_type: "image/jpeg" | "application/pdf" | null;
  vendor: string | null;
  spent_on: string | null;
  amount_cents: number | null;
  tax_cents: number | null;
  category: string | null;
  description: string | null;
  booking_id: string | null;
  paid_with: "business" | "personal" | null;
  po_reference: string | null;
  owner_words: string | null;
  missing: string[];
  reply: string | null;
  filed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface HstPeriodRow {
  id: string;
  organization_id: string;
  company_id: string;
  frequency: HstFrequency;
  period_start: string;
  period_end: string;
  due_date: string;
  payment_due_date: string;
  label: string;
  status: "pending" | "reminding" | "reminded" | "failed" | "skipped";
  reminded_at: string | null;
  reminder_body: string | null;
  figures: Record<string, unknown>;
  approval_id: string | null;
  packet_claimed_at: string | null;
  packet_emailed_at: string | null;
  packet_emailed_to: string | null;
  packet_error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

export interface TaxClerkNoticeRow {
  id: string;
  organization_id: string;
  company_id: string;
  kind: "first_seen" | "receipt_tip" | "weekly_nudge";
  key: string;
  status: "claimed" | "sent" | "skipped" | "failed";
  body: string | null;
  sent_at: string | null;
  created_at: string;
}

/** The expenses columns the Tax Clerk reads. */
export interface ExpenseLite {
  id: string;
  organization_id: string;
  company_id: string | null;
  booking_id: string | null;
  spent_on: string;
  vendor: string | null;
  description: string | null;
  category: string;
  amount_cents: number;
  tax_cents: number;
  paid_with: string;
  receipt_path: string | null;
  receipt_type: string | null;
  created_by: string | null;
  created_at: string;
}

/** The invoices columns the HST worksheet reads. */
export interface InvoiceLite {
  id: string;
  company_id: string;
  invoice_number: string | null;
  status: string;
  issue_date: string | null;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  credit_cents: number;
  amount_paid_cents: number;
  balance_due_cents: number;
  bill_to: unknown;
  title: string | null;
  imported_at: string | null;
}
