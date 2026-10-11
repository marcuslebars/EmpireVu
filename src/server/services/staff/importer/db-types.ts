/**
 * Local row types for the customer import's tables and columns (migration
 * 20261012110000_staff_importer.sql). database.types.ts is not edited here (the lead merges the
 * generated types); queries use the `Db = any` cast and these shapes.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = any;

export const BATCH_STATUSES = [
  // created, waiting for the file to land in storage
  "uploading",
  // file is in storage; the sweep reads it, guesses the columns
  "uploaded",
  // columns mapped (guessed or fixed by the owner); the sweep builds the preview
  "mapped",
  // preview ready; nothing written yet — the owner presses Import
  "previewed",
  "importing",
  "done",
  "failed",
  // the owner asked to undo; the sweep removes what it created
  "undoing",
  "undone",
  // dropped before anything was written
  "cancelled",
] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export type ImportField =
  | "ignore"
  | "first_name"
  | "last_name"
  | "full_name"
  | "phone"
  | "email"
  | "address"
  | "company"
  | "notes"
  | "tags"
  | "last_service_date"
  | "job_date"
  | "job_description"
  | "job_amount"
  | "balance"
  | "balance_date"
  | "balance_due_date"
  | "invoice_ref";

export interface PreviewIssue {
  row: number;
  reason: string;
}

export interface PreviewSample {
  row: number;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  company: string | null;
  match: "new" | "existing" | "same_as_earlier_row" | "invalid";
  jobs: number;
  balanceCents: number;
  reason?: string | null;
}

export interface ImportPreview {
  totalRows: number;
  newContacts: number;
  matchedContacts: number;
  /** Rows for a customer an earlier row already covers (their extra jobs still count). */
  repeatRows: number;
  invalidRows: number;
  issues: PreviewIssue[];
  pastJobs: number;
  /** Jobs this file already brought in (a re-upload) — skipped. */
  jobsAlreadyImported: number;
  openBalances: number;
  openBalanceCents: number;
  balancesAlreadyImported: number;
  accounts: number;
  samples: PreviewSample[];
  /** Same file (by content) already imported in an earlier batch. */
  sameFileImportedAt: string | null;
  computedAt: string;
}

export interface ImportCounts {
  rowsDone: number;
  contactsCreated: number;
  contactsMatched: number;
  contactsFilled: number;
  jobsCreated: number;
  jobsSkipped: number;
  balancesCreated: number;
  balanceCents: number;
  balancesSkipped: number;
  accountsCreated: number;
  invalidRows: number;
  repeatRows: number;
}

export interface UndoReport {
  removed: { contacts: number; jobs: number; balances: number; accounts: number };
  kept: { contacts: number; jobs: number; balances: number; accounts: number };
  /** A few names / reasons for what was kept (≤ 10). */
  keptExamples: string[];
}

export interface ImportBatchRow {
  id: string;
  organization_id: string;
  company_id: string;
  created_by: string | null;
  source: "app" | "link";
  file_name: string;
  file_path: string;
  file_size: number | null;
  file_kind: "csv" | "xlsx";
  file_sha256: string | null;
  sheet_name: string | null;
  status: BatchStatus;
  headers: string[];
  samples: string[][];
  mapping: ImportField[];
  mapping_source: "heuristic" | "ai" | "owner" | null;
  unsure_columns: number[];
  total_rows: number;
  preview: ImportPreview | null;
  counts: ImportCounts | null;
  cursor: number;
  lease_id: string | null;
  leased_until: string | null;
  error: string | null;
  owner_notified_at: string | null;
  chase_approval_id: string | null;
  undo_phase: "invoices" | "bookings" | "contacts" | "accounts" | null;
  undo_cursor: string | null;
  undo_report: UndoReport | null;
  import_started_at: string | null;
  import_finished_at: string | null;
  undone_at: string | null;
  purged_at: string | null;
  created_at: string;
  updated_at: string;
}

export type RowOutcome = "created" | "matched" | "repeat" | "invalid" | "duplicate";

export interface ImportRowRow {
  id: string;
  organization_id: string;
  company_id: string;
  batch_id: string;
  row_index: number;
  row_hash: string;
  cells: string[];
  outcome: RowOutcome | null;
  reason: string | null;
  contact_id: string | null;
  contact_created: boolean;
  filled: string[] | null;
  jobs_created: number;
  jobs_skipped: number;
  invoice_id: string | null;
  account_id: string | null;
  account_created: boolean;
  applied_at: string | null;
}

export interface ImportLinkRow {
  id: string;
  organization_id: string;
  company_id: string;
  token: string;
  expires_at: string;
  sent_at: string | null;
  created_at: string;
}

/** The invoice columns the import adds (invoices.*). */
export interface ImportedInvoiceColumns {
  imported_at: string | null;
  import_batch_id: string | null;
  /** True while the Bookkeeper / email reminders must leave this balance alone. */
  import_hold: boolean;
  import_key: string | null;
}
