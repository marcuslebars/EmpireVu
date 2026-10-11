/**
 * Local row types for the estimator's tables (migration 20261011100000_staff_estimator.sql).
 * database.types.ts is not edited here (the lead merges the generated types); queries use the
 * `Db = any` cast and these shapes.
 */

export type EstimateStatus = "collecting" | "estimating" | "awaiting_owner" | "sent" | "declined" | "failed";
export const OPEN_ESTIMATE_STATUSES: readonly EstimateStatus[] = ["estimating", "awaiting_owner"];

export type EstimateConfidence = "low" | "medium" | "high";

export interface EstimatePhoto {
  storage_path: string;
  content_type: string;
}

/** One line of an AI estimate, as the owner sees it and the quote will carry it. */
export interface EstimateLine {
  label: string;
  amountCents: number;
  /** True for a line the model priced (not on the price list). */
  custom: boolean;
}

/** A price-list service on the estimate, exactly as priceQuoteForCompany takes it. */
export interface EstimateService {
  serviceId: string;
  quantity?: number;
  lengthFt?: number;
  modifiers?: Record<string, string>;
}

export interface EstimateCustomLine {
  label: string;
  amountCents: number;
}

export interface EstimateJson {
  title: string;
  /** What the owner was shown (priced lines, in quote order). */
  lines: EstimateLine[];
  /** What the quote is built from. */
  services: EstimateService[];
  customLines: EstimateCustomLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  confidence: EstimateConfidence;
  assumptions: string[];
  questions: string[];
  model?: string;
}

export interface EstimateRequestRow {
  id: string;
  organization_id: string;
  company_id: string;
  contact_id: string;
  conversation_id: string | null;
  description: string;
  photos: EstimatePhoto[];
  status: EstimateStatus;
  /** Full once priced; while 'collecting' only { questions } (what to ask the customer). */
  estimate: EstimateJson | Partial<EstimateJson> | null;
  quote_id: string | null;
  approval_id: string | null;
  decision_claimed_at: string | null;
  owner_result: string | null;
  error: string | null;
  created_at: string;
  updated_at?: string;
}

export interface QuoteFollowUpRow {
  id: string;
  organization_id: string;
  company_id: string;
  contact_id: string | null;
  quote_id: string;
  nudges_sent: number;
  last_nudge_at: string | null;
  stopped_at: string | null;
  stop_reason: string | null;
  last_error: string | null;
  created_at: string;
}

/** The quote columns the follow-up sweep reads. */
export interface FollowedQuote {
  id: string;
  organization_id: string;
  company_id: string | null;
  contact_id: string | null;
  status: string;
  source: string | null;
  title: string | null;
  public_token: string;
  subtotal_cents: number;
  sent_at: string | null;
  deposit_paid_at?: string | null;
}
