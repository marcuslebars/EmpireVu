/**
 * Local row types for the Bookkeeper's tables (migration 20261011110000_staff_bookkeeper.sql).
 * database.types.ts is not edited here (the lead merges the generated types); queries use the
 * `Db = any` cast and these shapes.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = any;

export type FinalNoticeStatus = "none" | "proposed" | "approved" | "sent" | "skipped";
export type PromiseStatus = "open" | "kept" | "missed";

export interface InvoiceCollectionsRow {
  id: string;
  organization_id: string;
  company_id: string;
  invoice_id: string;
  contact_id: string | null;
  sms_count: number;
  last_sms_at: string | null;
  hold_until: string | null;
  hold_reason: "promise" | "payment_plan" | null;
  promise_date: string | null;
  promise_recorded_at: string | null;
  promise_status: PromiseStatus | null;
  final_notice_status: FinalNoticeStatus;
  final_notice_approval_id: string | null;
  created_at: string;
  updated_at: string;
}

export type ReminderTextKind = "scheduled" | "final_notice" | "manual" | "instalment";
export type ReminderTextStatus = "queued" | "claimed" | "sent" | "blocked" | "failed" | "skipped";

export interface InvoiceReminderTextRow {
  id: string;
  organization_id: string;
  company_id: string;
  invoice_id: string;
  contact_id: string | null;
  reminder_key: string;
  kind: ReminderTextKind;
  status: ReminderTextStatus;
  body: string | null;
  balance_cents: number | null;
  reason: string | null;
  approval_id: string | null;
  sent_at: string | null;
  created_at: string;
}

export interface Instalment {
  n: number;
  dueDate: string;
  amountCents: number;
}

export interface PaymentPlanRow {
  id: string;
  organization_id: string;
  company_id: string;
  invoice_id: string;
  contact_id: string | null;
  approval_id: string | null;
  status: "active" | "completed" | "cancelled";
  instalments: Instalment[];
  total_cents: number;
  starting_balance_cents: number;
  activated_at: string;
  completed_at: string | null;
}

export interface MoneyAlertRow {
  id: string;
  organization_id: string;
  company_id: string;
  alert_date: string;
  status: "claimed" | "sent" | "skipped" | "failed";
  body: string | null;
  items: unknown;
  sent_at: string | null;
}

/** The invoice columns the Bookkeeper reads. */
export interface BookkeeperInvoice {
  id: string;
  organization_id: string;
  company_id: string;
  contact_id: string | null;
  invoice_number: string | null;
  public_token: string;
  status: string;
  title: string | null;
  total_cents: number;
  credit_cents: number;
  amount_paid_cents: number;
  pending_payment_cents: number;
  balance_due_cents: number;
  issue_date: string | null;
  due_date: string | null;
  sent_at: string | null;
  paid_at: string | null;
  last_reminder_at: string | null;
  reminders_paused: boolean;
  bill_to: unknown;
}

export const INVOICE_COLUMNS =
  "id, organization_id, company_id, contact_id, invoice_number, public_token, status, title, total_cents, credit_cents, amount_paid_cents, " +
  "pending_payment_cents, balance_due_cents, issue_date, due_date, sent_at, paid_at, last_reminder_at, reminders_paused, bill_to";

/** The contact columns the Bookkeeper reads. */
export interface BookkeeperContact {
  id: string;
  organization_id: string;
  company_id: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  sms_opt_out_at: string | null;
  email_opt_out_at: string | null;
  sms_consent_at: string | null;
  consent_source: string | null;
}

export const CONTACT_COLUMNS = "id, organization_id, company_id, first_name, last_name, phone, sms_opt_out_at, email_opt_out_at, sms_consent_at, consent_source";
