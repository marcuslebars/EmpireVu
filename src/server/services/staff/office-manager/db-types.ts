/**
 * Local row types for the Office manager's table (migration 20261012100000_staff_office_manager.sql).
 * database.types.ts is not edited here (the lead merges the generated types); queries use the
 * `Db = any` cast and these shapes.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = any;

export type BriefingStatus = "claimed" | "sent" | "failed" | "skipped";

/** owner_briefings: one row per company per local date — the claim for that morning's text. */
export interface OwnerBriefingRow {
  id: string;
  organization_id: string;
  company_id: string;
  /** The company-local date (YYYY-MM-DD) the briefing is for. */
  local_date: string;
  status: BriefingStatus;
  /** Send attempts so far (a failed send releases the claim for a retry before 11:00). */
  attempts: number;
  last_attempt_at: string | null;
  body: string | null;
  /** "sent" | "failed" | "blocked" | null (no email copy). */
  email_status: string | null;
  /** Bookkeeper money-alert item keys folded into this briefing. */
  money_items: string[];
  /** 'included' (the alert's items rode along), 'none' (alert off), 'failed' (couldn't read them → the 8am alert goes). */
  money_fold: "included" | "none" | "failed" | null;
  sent_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}
