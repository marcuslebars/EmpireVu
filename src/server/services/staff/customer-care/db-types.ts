/**
 * Local row types for the Customer care tables (migration 20261014110000_staff_customer_care.sql)
 * until they're merged into database.types.ts. Queries use the `Db = any` cast like the other roles.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = any;

export interface WarrantyTermRow {
  id: string;
  organization_id: string;
  company_id: string;
  service_catalog_item_id: string;
  months: number;
  terms_text: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobWarrantyRow {
  id: string;
  organization_id: string;
  company_id: string;
  contact_id: string | null;
  booking_id: string;
  job_label: string | null;
  starts_on: string;
  ends_on: string;
  months: number;
  terms_text: string | null;
  source: "default" | "item";
  created_at: string;
}

export interface InstalledEquipmentRow {
  id: string;
  organization_id: string;
  company_id: string;
  contact_id: string | null;
  booking_id: string | null;
  make: string | null;
  model: string | null;
  serial: string | null;
  installed_on: string | null;
  manufacturer_warranty_ends: string | null;
  notes: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export type CheckinStatus = "scheduled" | "sending" | "sent" | "skipped" | "blocked" | "failed";

export interface CareCheckinRow {
  id: string;
  organization_id: string;
  company_id: string;
  contact_id: string | null;
  booking_id: string;
  status: CheckinStatus;
  send_at: string;
  pushes: number;
  sent_at: string | null;
  body: string | null;
  reason: string | null;
  job_label: string | null;
  rating: number | null;
  comment: string | null;
  answered_at: string | null;
  created_at: string;
  updated_at: string;
}

export type CaseKind = "complaint" | "callback" | "warranty";
export type CaseStatus = "open" | "scheduled" | "resolved" | "closed";
export type CaseOpenedVia = "checkin" | "sms_agent" | "owner";
export type VisitKind = "callback" | "warranty";

export interface OfferedSlot {
  date: string;
  window: string | null;
  startsAt: string | null;
  label: string;
}

export interface CareCaseRow {
  id: string;
  organization_id: string;
  company_id: string;
  contact_id: string | null;
  booking_id: string | null;
  job_label: string | null;
  kind: CaseKind;
  status: CaseStatus;
  summary: string | null;
  rating: number | null;
  opened_via: CaseOpenedVia;
  checkin_id: string | null;
  warranty_id: string | null;
  equipment_id: string | null;
  followup: "visit" | "call" | "none" | "expired" | null;
  followup_decided_at: string | null;
  visit_kind: VisitKind | null;
  visit_stage: "offered" | "booking" | "booked" | "owner_calls" | null;
  offered_slots: OfferedSlot[] | null;
  offered_at: string | null;
  owner_alert_body: string | null;
  owner_alert_status: "pending" | "sending" | "sent" | "none" | null;
  owner_alerted_at: string | null;
  approval_ids: string[] | null;
  notes: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CareCaseBookingRow {
  id: string;
  organization_id: string;
  company_id: string;
  case_id: string;
  booking_id: string;
  kind: VisitKind;
  created_at: string;
}

export type CareMessageKind = "visit_offer" | "owner_call" | "no_times";

export interface CareMessageRow {
  id: string;
  organization_id: string;
  company_id: string;
  case_id: string | null;
  contact_id: string | null;
  kind: CareMessageKind;
  dedupe_key: string;
  status: "queued" | "sending" | "sent" | "skipped" | "failed" | "blocked";
  body: string;
  not_before: string;
  attempts: number;
  sent_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** The contact columns every part of the role reads (consent included). */
export const CONTACT_COLUMNS = "id, organization_id, company_id, first_name, last_name, phone, email, sms_opt_out_at, email_opt_out_at, sms_consent_at, consent_source, notes, metadata";

export interface CareContact {
  id: string;
  organization_id: string;
  company_id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  sms_opt_out_at: string | null;
  email_opt_out_at: string | null;
  sms_consent_at: string | null;
  consent_source: string | null;
  notes?: string | null;
  metadata?: unknown;
}

export const BOOKING_COLUMNS = "id, organization_id, company_id, contact_id, title, status, scheduled_for, completed_at, duration_minutes, price_cents, quote_id, service_item_id, window_key";

export interface CareBooking {
  id: string;
  organization_id: string;
  company_id: string;
  contact_id: string | null;
  title: string;
  status: string;
  scheduled_for: string;
  completed_at: string | null;
  duration_minutes: number | null;
  price_cents: number | null;
  quote_id: string | null;
  service_item_id: string | null;
  window_key: string | null;
}
