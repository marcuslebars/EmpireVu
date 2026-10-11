/**
 * Local types for the Dispatcher's tables and columns (migration 20261011120000_staff_dispatcher.sql).
 * database.types.ts is not edited by role builders; the lead merges these in later. Until then
 * queries use the `Db = any` cast (see sms-agent) and these row shapes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = any;

export type DispatchMessageKind = "on_our_way" | "crew_schedule" | "crew_update" | "job_moved" | "gap_offer";
export type DispatchMessageStatus = "queued" | "sending" | "sent" | "skipped" | "failed" | "blocked";

export interface DispatchMessageRow {
  id: string;
  organization_id: string;
  company_id: string;
  kind: DispatchMessageKind;
  dedupe_key: string;
  booking_id: string | null;
  contact_id: string | null;
  profile_id: string | null;
  approval_id: string | null;
  to_phone: string | null;
  body: string | null;
  status: DispatchMessageStatus;
  reason: string | null;
  not_before: string | null;
  expires_at: string | null;
  attempts: number;
  payload: Record<string, unknown>;
  sent_at: string | null;
  created_at: string;
  updated_at?: string;
}

export type DispatchRunKind = "weather" | "fill_gap";

export interface DispatchRunRow {
  id: string;
  organization_id: string;
  company_id: string;
  kind: DispatchRunKind;
  run_key: string;
  status: "running" | "done" | "skipped" | "failed";
  approval_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
}

export interface DispatchWeatherCacheRow {
  company_id: string;
  organization_id: string;
  hour_key: string;
  latitude: number;
  longitude: number;
  forecast: unknown;
  fetched_at: string;
}

/** New columns on companies. */
export interface CompanyLocationColumns {
  latitude: number | null;
  longitude: number | null;
  location_source: string | null;
  location_checked_at: string | null;
}

/** New column on organization_memberships. */
export interface MembershipPhoneColumns {
  phone_e164: string | null;
}
