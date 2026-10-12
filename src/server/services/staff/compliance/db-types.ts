/**
 * Row types for the Compliance tables (migration 20261013120000_staff_compliance.sql). Local until
 * the lead merges them into database.types.ts; queries use the `Db = any` cast.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = any;

export type ComplianceKind =
  | "liability_insurance"
  | "wsib_clearance"
  | "wsib_account"
  | "vehicle_insurance"
  | "trade_licence"
  | "business_licence"
  | "certification"
  | "bond"
  | "other";

export type HolderType = "company" | "crew" | "subcontractor";
export type DocStatus = "pending" | "current" | "expiring" | "expired" | "replaced";
export type UploadedVia = "sms" | "settings" | "sub_link";
export type SendStatus = "queued" | "sending" | "sent" | "failed" | "blocked";

export interface ComplianceDocumentRow {
  id: string;
  organization_id: string;
  company_id: string;
  kind: ComplianceKind;
  title: string | null;
  holder_type: HolderType | null;
  profile_id: string | null;
  subcontractor_id: string | null;
  holder_name: string | null;
  issuer: string | null;
  number: string | null;
  issued_on: string | null;
  expires_on: string | null;
  file_path: string | null;
  file_content_type: string | null;
  notes: string | null;
  uploaded_via: UploadedVia;
  uploaded_by: string | null;
  status: DocStatus;
  replaced_by: string | null;
  source_key: string | null;
  upload_request_id: string | null;
  ai_read: Record<string, unknown> | null;
  intake_reply: string | null;
  reminded_30_at: string | null;
  reminded_7_at: string | null;
  reminded_0_at: string | null;
  owner_notified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubcontractorRow {
  id: string;
  organization_id: string;
  company_id: string;
  name: string | null;
  business_name: string | null;
  trade: string | null;
  phone_e164: string | null;
  email: string | null;
  notes: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface UploadRequestRow {
  id: string;
  organization_id: string;
  company_id: string;
  subcontractor_id: string;
  document_id: string | null;
  approval_id: string | null;
  token: string;
  kinds: ComplianceKind[];
  channel: "sms" | "email";
  status: SendStatus | "cancelled";
  body: string | null;
  send_after: string | null;
  sent_at: string | null;
  expires_at: string;
  uploads: number;
  last_upload_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShareRow {
  id: string;
  organization_id: string;
  company_id: string;
  document_id: string;
  contact_id: string | null;
  approval_id: string | null;
  token: string;
  status: SendStatus | "revoked";
  body: string | null;
  send_after: string | null;
  sent_at: string | null;
  expires_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  open_count: number;
  last_opened_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ComplianceEventRow {
  id: string;
  organization_id: string;
  company_id: string;
  document_id: string | null;
  share_id: string | null;
  request_id: string | null;
  event: string;
  actor: string | null;
  ip: string | null;
  user_agent: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
}
