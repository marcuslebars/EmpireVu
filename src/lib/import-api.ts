/**
 * Customer import (docs/ai-staff.md → "Customer import"): the API client for the Import customers
 * page (signed in) and the /import/:token page (texted link). Both talk to the same server code;
 * only the base path differs. Files go straight from the browser to the private customer-imports
 * bucket with a one-time signed upload URL.
 */
import { apiFetch } from "@/lib/api-client";
import { supabase } from "@/lib/supabase";

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

export type BatchStatus = "uploading" | "uploaded" | "mapped" | "previewed" | "importing" | "done" | "failed" | "undoing" | "undone" | "cancelled";

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

export interface ImportPreview {
  totalRows: number;
  newContacts: number;
  matchedContacts: number;
  repeatRows: number;
  invalidRows: number;
  issues: Array<{ row: number; reason: string }>;
  pastJobs: number;
  jobsAlreadyImported: number;
  openBalances: number;
  openBalanceCents: number;
  balancesAlreadyImported: number;
  accounts: number;
  samples: Array<{ row: number; name: string; phone: string | null; email: string | null; address: string | null; company: string | null; match: "new" | "existing" | "same_as_earlier_row" | "invalid"; jobs: number; balanceCents: number; reason?: string | null }>;
  sameFileImportedAt: string | null;
  computedAt: string;
}

export interface BatchSummary {
  id: string;
  status: BatchStatus;
  fileName: string;
  createdAt: string;
  totalRows: number;
  counts: ImportCounts | null;
  undoSummary: string | null;
}

export interface BatchView extends BatchSummary {
  fileKind: "csv" | "xlsx";
  sheetName: string | null;
  source: "app" | "link";
  headers: string[];
  samples: string[][];
  mapping: ImportField[];
  unsureColumns: number[];
  mappingSource: string | null;
  fields: Array<{ field: ImportField; label: string; help: string }>;
  duplicateRows: number;
  preview: ImportPreview | null;
  progress: { done: number; total: number };
  error: string | null;
  chaseStatus: string | null;
  undoReport: { removed: Record<string, number>; kept: Record<string, number>; keptExamples: string[] } | null;
  can: { editMapping: boolean; import: boolean; undo: boolean; cancel: boolean };
}

export interface ImportOverview {
  companyId: string;
  companyName: string;
  settings: { enabled: boolean; enabledIsDefault: boolean };
  defaultEnabled: boolean;
  ownerPhoneOnFile: boolean;
  batches: BatchSummary[];
  held: { count: number; totalCents: number; pendingCode: number | null };
}

export interface PublicImportOverview {
  businessName: string;
  platformBrand: string;
  batches: BatchSummary[];
}

export type BatchActionBody = { action: "uploaded" } | { action: "mapping"; mapping: ImportField[] } | { action: "import" } | { action: "undo" } | { action: "cancel" };

/** Where the page talks to: the signed-in routes or the token routes. */
export interface ImportApi {
  createBatch(file: File): Promise<{ batch: BatchView; upload: { bucket: string; path: string; token: string } }>;
  getBatch(id: string): Promise<BatchView>;
  act(id: string, body: BatchActionBody): Promise<BatchView>;
}

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

function contentTypeFor(file: File): string {
  if (/\.xlsx$/i.test(file.name)) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return "text/csv";
}

function makeApi(base: string): ImportApi {
  return {
    createBatch: (file) =>
      apiFetch(base, { method: "POST", body: JSON.stringify({ fileName: file.name, fileSize: file.size, contentType: file.type || contentTypeFor(file) }) }),
    getBatch: (id) => apiFetch(`${base}/${encodeURIComponent(id)}`),
    act: (id, body) => apiFetch(`${base}/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(body) }),
  };
}

export function appImportApi(orgId: string, companyId: string): ImportApi {
  return makeApi(`/api/organizations/${orgId}/companies/${companyId}/imports`);
}

export function linkImportApi(token: string): ImportApi {
  return makeApi(`/api/public/import/${encodeURIComponent(token)}`);
}

export const fetchImportOverview = (orgId: string, companyId: string) => apiFetch<ImportOverview>(`/api/organizations/${orgId}/companies/${companyId}/imports`);
export const fetchPublicImport = (token: string) => apiFetch<PublicImportOverview>(`/api/public/import/${encodeURIComponent(token)}`);
export const sendImportLinkToOwner = (orgId: string, companyId: string) => apiFetch<{ sent: boolean }>(`/api/organizations/${orgId}/companies/${companyId}/imports/send-link`, { method: "POST", body: "{}" });
export const askToStartReminders = (orgId: string, companyId: string) =>
  apiFetch<{ code: number | null; created: boolean }>(`/api/organizations/${orgId}/companies/${companyId}/imports/start-reminders`, { method: "POST", body: "{}" });

/** Create the batch, put the file in storage, tell the server it landed. Returns the batch. */
export async function uploadImportFile(api: ImportApi, file: File): Promise<BatchView> {
  if (!/\.(csv|xlsx|txt)$/i.test(file.name)) throw new Error("Upload a CSV or Excel (.xlsx) file.");
  if (file.size > MAX_IMPORT_BYTES) throw new Error("That file is over 10 MB. Split it into smaller files.");
  if (!supabase) throw new Error("Uploads aren't available right now - try again in a minute.");
  const { batch, upload } = await api.createBatch(file);
  const { error } = await supabase.storage.from(upload.bucket).uploadToSignedUrl(upload.path, upload.token, file, { contentType: contentTypeFor(file), upsert: true });
  if (error) throw new Error(error.message || "The upload didn't finish - try again.");
  return api.act(batch.id, { action: "uploaded" });
}

export function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/** Statuses the page keeps polling on. */
export function isWorking(status: BatchStatus): boolean {
  return status === "uploaded" || status === "mapped" || status === "importing" || status === "undoing";
}
