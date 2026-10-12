/**
 * Local row types for the Email inbox tables (migration 20261014100000_staff_email_clerk.sql)
 * until they are merged into database.types.ts. Queries use the `Db = any` cast, like the other
 * roles.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = any;

/** What an inbound email turned out to be (classify.ts). */
export type EmailCategory =
  | "forwarding_confirmation"
  | "auto_reply"
  | "bounce"
  | "newsletter"
  | "no_reply"
  | "spam"
  | "customer"
  | "supplier"
  | "bid_invite"
  | "bill"
  | "other";

/** new = metadata only (content not fetched yet) → received → processing → done | failed (retried) | dead (gave up) | ignored. */
export type InboundStatus = "new" | "received" | "processing" | "done" | "failed" | "ignored" | "dead";

export type ReplyStatus = "none" | "no_draft" | "awaiting_owner" | "sending" | "sent" | "skipped" | "expired" | "superseded" | "blocked" | "failed";

/** The owner's per-email text (customer / bid invite / supplier about an open PO). */
export type OwnerAlertStatus = "none" | "sending" | "held" | "sent" | "dropped" | "approval" | "digest";

export interface EmailInboxRow {
  id: string;
  organization_id: string;
  company_id: string;
  address: string;
  /** The owner's own mailbox that forwards to us, once seen (a Gmail confirmation names it). */
  forwarded_from: string | null;
  forwarding_requested_at: string | null;
  forwarding_confirmed_at: string | null;
  last_received_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailDetail {
  /** Supplier / GC / vendor name as the email (or the model) gives it. Data, not instructions. */
  from_business?: string | null;
  amount_cents?: number | null;
  due_on?: string | null;
  project?: string | null;
  po_number?: string | null;
  /** Forwarding confirmation: which provider ("gmail" | "outlook"). The code itself is never stored. */
  provider?: string | null;
  /** Forwarding confirmation: the mailbox that asked (Gmail names it). */
  forwarded_from?: string | null;
  reason?: string | null;
}

export interface InboundEmailRow {
  id: string;
  organization_id: string;
  company_id: string;
  inbox_id: string;
  provider: string;
  provider_email_id: string;
  message_id: string;
  from_address: string | null;
  from_name: string | null;
  to_addresses: string[];
  cc_addresses: string[];
  reply_to: string | null;
  subject: string | null;
  text_body: string | null;
  html_excerpt: string | null;
  in_reply_to: string | null;
  reference_ids: string[];
  thread_key: string | null;
  /** A few routing headers kept for the rules (auto-submitted, list-id…), lower-cased names. */
  headers: Record<string, string> | null;
  auth: { spf?: string | null; dkim?: string | null; dmarc?: string | null } | null;
  attachments_meta: Array<{ id: string; filename: string | null; content_type: string | null; size: number | null; inline: boolean }>;
  received_at: string;
  status: InboundStatus;
  attempts: number;
  locked_until: string | null;
  last_error: string | null;
  category: EmailCategory | null;
  classified_by: "rules" | "model" | "fallback" | null;
  detail: EmailDetail | null;
  ai_summary: string | null;
  contact_id: string | null;
  booking_id: string | null;
  supplier_id: string | null;
  purchase_order_id: string | null;
  message_log_id: string | null;
  task_id: string | null;
  draft_subject: string | null;
  draft_reply: string | null;
  approval_id: string | null;
  reply_status: ReplyStatus;
  replied_at: string | null;
  owner_alert_status: OwnerAlertStatus;
  owner_alerted_at: string | null;
  digest_date: string | null;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailAttachmentRow {
  id: string;
  organization_id: string;
  company_id: string;
  inbound_email_id: string;
  provider_attachment_id: string;
  filename: string | null;
  content_type: string | null;
  size_bytes: number | null;
  storage_path: string | null;
  status: "stored" | "skipped_type" | "skipped_size" | "failed";
  created_at: string;
}

export interface EmailDigestRow {
  id: string;
  organization_id: string;
  company_id: string;
  local_date: string;
  status: "claimed" | "sent" | "failed" | "skipped";
  attempts: number;
  body: string | null;
  email_ids: string[];
  last_error: string | null;
  created_at: string;
  updated_at: string;
}
