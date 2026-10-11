/**
 * Local types for the porting tables (migration 20261012120000_staff_porting.sql).
 * database.types.ts is not edited by role builders; the lead merges these in later. Until then
 * queries use the `Db = any` cast (see sms-agent) and these row shapes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = any;

export const PORT_STATUSES = ["collecting", "ready", "submitted", "foc_scheduled", "completed", "rejected", "cancelled"] as const;
export type PortStatus = (typeof PORT_STATUSES)[number];

export type PinStatus = "none" | "stored" | "call";

export interface ServiceAddress {
  line1: string;
  line2: string | null;
  city: string;
  province: string;
  postalCode: string;
  country: "CA" | "US";
}

export interface NumberPortRow {
  id: string;
  organization_id: string;
  company_id: string;
  token: string;
  status: PortStatus;
  numbers: string[];
  carrier: string | null;
  business_name: string | null;
  authorized_name: string | null;
  service_address: ServiceAddress | null;
  account_number_enc: string | null;
  account_number_last4: string | null;
  pin_enc: string | null;
  pin_status: PinStatus;
  secrets_purged_at: string | null;
  bill_path: string | null;
  bill_content_type: string | null;
  bill_uploaded_at: string | null;
  loa_path: string | null;
  loa_sha256: string | null;
  loa_signed_at: string | null;
  loa_signed_name: string | null;
  loa_signed_ip: string | null;
  loa_signed_user_agent: string | null;
  twilio_port_request_id: string | null;
  foc_date: string | null;
  rejection_reason: string | null;
  attached_numbers: string[];
  created_via: "settings" | "owner_text" | "operator";
  /** The owner text due: "<status>@<iso>" (a new key per transition); sent when notified_status catches up. */
  notify_status: string | null;
  notified_status: string | null;
  ready_at: string | null;
  submitted_at: string | null;
  foc_set_at: string | null;
  completed_at: string | null;
  rejected_at: string | null;
  cancelled_at: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at?: string;
}

export interface BusinessLineCallRow {
  id: string;
  organization_id: string;
  company_id: string;
  call_sid: string;
  business_line: string;
  rang: string[];
  screen: boolean;
  accepted_at: string | null;
  outcome: "answered" | "missed" | null;
  created_at: string;
}

/** voice_numbers.mode of a ported main line (rings the owner first, then the catcher path). */
export const BUSINESS_LINE_MODE = "business_line";
