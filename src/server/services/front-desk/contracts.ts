/**
 * Shared contracts for the AI front desk (Phase 1, docs/front-desk-ai.md).
 *
 * Four parts meet here:
 *   - sms-agent/      the AI that texts customers (owns entry.ts + approved.ts)
 *   - owner-channel/  the owner runs the business by text (owns entry.ts + notify.ts,
 *                     and the inbound SMS router in twilio/inbound-sms.ts)
 *   - call answering  (Retell / Twilio voice)
 *   - weekly report
 * They talk through these types and through DB state (sms_conversations, owner_approvals).
 */
import type { createSupabaseAdminClient } from "@/server/supabase/admin";

export type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

/**
 * message_log.sent_by for texts the AI front desk wrote: the texting AI, and the phone AI's
 * post-call follow-up. The inbox labels both "Assistant"; the SMS agent reads both as its own.
 */
export const SMS_AGENT_SENDER = "sms_agent";
export const VOICE_AGENT_SENDER = "voice_agent";
export const AI_SENDERS: readonly string[] = [SMS_AGENT_SENDER, VOICE_AGENT_SENDER];

/** A picture (MMS) on an inbound text. */
export interface InboundMedia {
  url: string;
  contentType: string | null;
}

/** A customer's text that reached a company number, after routing (not the owner, not STOP/START). */
export interface InboundCustomerSms {
  organizationId: string;
  companyId: string;
  contactId: string;
  /** message_log.id of the stored inbound text. */
  messageLogId: string | null;
  from: string;
  to: string;
  body: string;
  media: InboundMedia[];
  receivedAt: string;
}

/** A text from a business owner (to the platform number, or to their own company number). */
export interface InboundOwnerSms {
  from: string;
  to: string;
  body: string;
  media: InboundMedia[];
  providerRef: string | null;
  /** True when it arrived on the platform number (TWILIO_FROM_NUMBER). */
  viaPlatformNumber: boolean;
  /** The company whose number received it, when it came in on a company number. */
  companyId: string | null;
}

/**
 * Kinds of approval the AI can ask the owner for. Each kind's payload is owned by whoever
 * creates it; executeApprovedAction (sms-agent/approved.ts) runs it once approved.
 */
export type ApprovalKind =
  | "send_quote"
  | "book_job"
  | "send_reply"
  | "custom_price"
  | "callback"
  | (string & {});

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "superseded" | "executed" | "failed";

export interface OwnerApprovalRow {
  id: string;
  organization_id: string;
  company_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  kind: ApprovalKind;
  summary: string;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  short_code: number | null;
  requested_by: string;
  expires_at: string | null;
  created_at: string;
}

/** What the owner decided, possibly with an edit ("Y but $700"). */
export interface ApprovalDecision {
  approved: boolean;
  /** Free-text instruction the owner added (e.g. a different price), if any. */
  ownerNote?: string | null;
  decidedVia: "sms" | "app" | "auto" | "expiry";
  decidedBy: string;
}

export interface ExecuteResult {
  ok: boolean;
  /** One short line for the owner, e.g. "Sent the $650 quote to Dana." */
  message: string;
  detail?: Record<string, unknown>;
}
