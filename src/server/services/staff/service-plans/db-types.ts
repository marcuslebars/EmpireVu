/**
 * Local row types for the Service plans tables (migration 20261013110000_staff_service_plans.sql)
 * until they're merged into database.types.ts. Queries use the `Db = any` cast like the other roles.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = any;

export type PlanBilling = "annual" | "per_visit";

export interface ServicePlanRow {
  id: string;
  organization_id: string;
  company_id: string;
  name: string;
  description: string | null;
  price_cents: number;
  billing: PlanBilling;
  visit_months: number[];
  weekday: number;
  week_of_month: number;
  time_of_day: string;
  duration_minutes: number;
  included: unknown;
  active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type AgreementStatus = "pending_owner" | "pending_payment" | "active" | "renewal_due" | "renewed" | "lapsed" | "cancelled";
export const OPEN_STATUSES: AgreementStatus[] = ["pending_owner", "pending_payment", "active", "renewal_due"];
export type AgreementSource = "public" | "owner_text" | "settings" | "renewal";

export interface ServiceAgreementRow {
  id: string;
  organization_id: string;
  company_id: string;
  plan_id: string;
  contact_id: string | null;
  status: AgreementStatus;
  source: AgreementSource;
  plan_name: string;
  billing: PlanBilling;
  price_cents: number;
  visit_months: number[];
  term_start: string | null;
  term_end: string | null;
  visit_dates: string[];
  recurring_job_id: string | null;
  invoice_ids: string[];
  pending_invoice_id: string | null;
  previous_agreement_id: string | null;
  renewed_by_agreement_id: string | null;
  approval_id: string | null;
  renewal_token: string | null;
  renewal_approval_id: string | null;
  renewal_asked_at: string | null;
  renewal_declined_at: string | null;
  renewal_texted_at: string | null;
  renewal_price_cents: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  service_address: string | null;
  sms_consent_at: string | null;
  decision_claimed_at: string | null;
  activated_at: string | null;
  lapsed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  owner_notified_at: string | null;
  created_at: string;
  updated_at: string;
}

export type PlanMessageKind = "confirmation" | "renewal" | "renewed" | "visit_heads_up" | "declined";
export type PlanMessageStatus = "queued" | "sending" | "sent" | "skipped" | "failed" | "blocked";

export interface PlanMessageRow {
  id: string;
  organization_id: string;
  company_id: string;
  agreement_id: string | null;
  booking_id: string | null;
  kind: PlanMessageKind;
  dedupe_key: string;
  status: PlanMessageStatus;
  body: string;
  to_phone: string | null;
  not_before: string;
  attempts: number;
  sent_at: string | null;
  error: string | null;
  created_at: string;
}

/** The columns of a contact this role reads. */
export interface PlanContact {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  sms_opt_out_at: string | null;
  email_opt_out_at: string | null;
  sms_consent_at: string | null;
  consent_source: string | null;
  metadata: unknown;
}
export const CONTACT_COLUMNS = "id, first_name, last_name, phone, email, sms_opt_out_at, email_opt_out_at, sms_consent_at, consent_source, metadata";
