/**
 * Import batches: the state machine, the owner's actions on it, and the sweep that moves it.
 *
 *   uploading ──file landed──▶ uploaded ──sweep: read file, guess columns──▶ mapped
 *   mapped ──sweep: preview──▶ previewed ──owner: Import──▶ importing ──sweep, 500 rows a pass──▶ done
 *   done ──sweep: one text to the owner (+ the chase_imported_balances question)
 *   done | failed ──owner: Undo──▶ undoing ──sweep, phase by phase──▶ undone
 *   uploading … previewed ──owner: Cancel──▶ cancelled          anything ──bad file──▶ failed
 *
 * The owner can fix a column at mapped / previewed (→ mapped, a fresh preview). Large files are
 * never processed in the HTTP request: the request may take ONE short step (read + preview a small
 * file) so the page feels quick; importing and undoing only ever happen in the sweep.
 *
 * Concurrency: every sweep step holds the batch's lease (compare-and-swap on lease_id, 2 minutes),
 * and owner actions are compare-and-swap on status — two workers, or a double click, never run the
 * same step twice. Every read/write is pinned to the batch's organization AND company.
 *
 * SANCTIONED EXCEPTION (service role): routes check the caller (org owner/admin, or the
 * company's import link token) FIRST and pass only that company here.
 */
import { createHash, randomUUID } from "node:crypto";

import { replyInstruction } from "@/server/services/front-desk/approval-text";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { isQuietHours } from "@/server/services/owner-channel/common";
import { ValidationError } from "@/server/organizations/context";
import { applyChunk } from "./apply";
import { createChaseApproval, KIND_CHASE_IMPORTED, loadHeldBalances } from "./approvals";
import type { BatchStatus, Db, ImportBatchRow, ImportCounts, ImportField, ImportPreview, UndoReport } from "./db-types";
import { defaultImporterDeps, errorText, importPathFor, type ImporterDeps } from "./deps";
import { cleanMapping, guessMapping, IMPORT_FIELDS, mappingProblem, mappingPrompt, mergeAiMapping, parseMappingAnswer } from "./mapping";
import { rowHash, type DateOrder } from "./normalize";
import { fileKindOf, ImportFileError, MAX_FILE_BYTES, parseImportFile } from "./parse";
import { computePreview } from "./preview";
import { loadImportCompany, type ImportCompany } from "./settings";
import { emptyUndoReport, undoStep, undoSummary } from "./undo";
import { localDate, must, ownerMoney, plural, readAllPages } from "./util";

export const LEASE_MS = 2 * 60_000;
export const BATCHES_PER_DAY = 20;
/** Files and raw rows are deleted this long after a batch is finished. */
export const PURGE_AFTER_MS = 30 * 86_400_000;
const INSERT_CHUNK = 500;
/**
 * Passes a step may start without finishing before the batch is marked failed. Counted BEFORE the
 * step runs, so a pass that takes the worker down (out of memory on a hostile file) still counts.
 */
export const MAX_ATTEMPTS: Partial<Record<BatchStatus, number>> = { uploaded: 3, mapped: 3, importing: 10, undoing: 10 };
/** Files up to this size are read and previewed inside the upload request (snappier page). */
const INLINE_BYTES = 1_000_000;
/** …and a fresh preview after a column change, up to this many rows. */
const INLINE_ROWS = 3_000;

type Batch = ImportBatchRow & { date_orders?: DateOrder[] | null; duplicate_rows?: number | null; chase_status?: string | null; failures?: number | null };
type Scope = { organizationId: string; companyId: string };

// ── Reading ─────────────────────────────────────────────────────────────────────

export async function loadBatch(admin: AdminClient, scope: Scope, batchId: string): Promise<Batch | null> {
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) return null;
  const { data, error } = await (admin as Db).from("import_batches").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("id", batchId).maybeSingle();
  if (error) throw error;
  return (data as Batch | null) ?? null;
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
  fields: typeof IMPORT_FIELDS;
  duplicateRows: number;
  preview: ImportPreview | null;
  progress: { done: number; total: number };
  error: string | null;
  chaseStatus: string | null;
  undoReport: UndoReport | null;
  can: { editMapping: boolean; import: boolean; undo: boolean; cancel: boolean };
}

function summaryOf(b: Batch): BatchSummary {
  return {
    id: b.id,
    status: b.status,
    fileName: b.file_name,
    createdAt: b.created_at,
    totalRows: b.total_rows ?? 0,
    counts: b.counts ?? null,
    undoSummary: b.undo_report && (b.status === "undone" || b.status === "undoing") ? undoSummary(b.undo_report) : null,
  };
}

export function viewOf(b: Batch): BatchView {
  const done = b.status === "importing" ? Math.max(0, b.cursor + 1) : b.status === "done" || b.status === "undoing" || b.status === "undone" ? b.total_rows : 0;
  return {
    ...summaryOf(b),
    fileKind: b.file_kind,
    sheetName: b.sheet_name,
    source: b.source,
    headers: b.headers ?? [],
    samples: b.samples ?? [],
    mapping: b.mapping ?? [],
    unsureColumns: b.unsure_columns ?? [],
    mappingSource: b.mapping_source,
    fields: IMPORT_FIELDS,
    duplicateRows: b.duplicate_rows ?? 0,
    preview: b.preview ?? null,
    progress: { done: Math.min(done, b.total_rows ?? 0), total: b.total_rows ?? 0 },
    error: b.error,
    chaseStatus: b.chase_status ?? null,
    undoReport: b.undo_report ?? null,
    can: {
      editMapping: (b.status === "mapped" || b.status === "previewed") && !b.purged_at,
      import: b.status === "previewed" && mappingProblem(b.mapping ?? []) === null,
      undo: b.status === "done" || (b.status === "failed" && Boolean(b.import_started_at)),
      cancel: ["uploading", "uploaded", "mapped", "previewed"].includes(b.status) || (b.status === "failed" && !b.import_started_at),
    },
  };
}

export async function listBatches(admin: AdminClient, scope: Scope, limit = 10): Promise<BatchSummary[]> {
  const { data, error } = await (admin as Db)
    .from("import_batches")
    .select("*")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Batch[]).map(summaryOf);
}

// ── Owner actions ───────────────────────────────────────────────────────────────

export interface CreateBatchInput {
  fileName: string;
  fileSize: number;
  contentType?: string | null;
  source: "app" | "link";
  createdBy: string | null;
}

/** A new batch + a one-time signed upload URL for its file (the browser uploads straight to storage). */
export async function createBatch(admin: AdminClient, company: ImportCompany, input: CreateBatchInput, deps: Pick<ImporterDeps, "storage" | "now"> = defaultImporterDeps): Promise<{ batch: BatchView; upload: { bucket: string; path: string; token: string } }> {
  if (!company.settings.enabled) throw new ValidationError("Customer import is off for this business (Settings > AI front desk > Customer import).");
  const kind = fileKindOf(input.fileName, input.contentType);
  if (!kind) throw new ValidationError("Upload a CSV or Excel (.xlsx) file. An older .xls? Open it and save it as .xlsx or .csv first.");
  if (!(input.fileSize > 0)) throw new ValidationError("That file is empty.");
  if (input.fileSize > MAX_FILE_BYTES) throw new ValidationError("That file is over 10 MB. Split it into smaller files.");
  const db = admin as Db;
  const nowMs = deps.now();
  const since = new Date(nowMs - 86_400_000).toISOString();
  const { data: recent, error: recentError } = await db.from("import_batches").select("id").eq("organization_id", company.organizationId).eq("company_id", company.companyId).gte("created_at", since).limit(BATCHES_PER_DAY + 1);
  if (recentError) throw recentError;
  if (((recent ?? []) as unknown[]).length >= BATCHES_PER_DAY) throw new ValidationError("That's a lot of uploads today - try again tomorrow, or reply to our text for help.");

  const id = randomUUID();
  const path = importPathFor(company.organizationId, id, kind);
  const upload = await deps.storage.createUpload(admin, path);
  const row = must(
    await db
      .from("import_batches")
      .insert({
        id,
        organization_id: company.organizationId,
        company_id: company.companyId,
        created_by: input.createdBy,
        source: input.source,
        file_name: input.fileName.replace(/[\r\n\t]/g, " ").trim().slice(0, 200) || `customers.${kind}`,
        file_path: path,
        file_size: Math.round(input.fileSize),
        file_kind: kind,
        status: "uploading",
        headers: [],
        samples: [],
        mapping: [],
        unsure_columns: [],
        total_rows: 0,
        cursor: -1,
        created_at: new Date(nowMs).toISOString(),
      })
      .select("*")
      .single(),
  ) as Batch;
  return { batch: viewOf(row), upload: { bucket: "customer-imports", path: upload.path, token: upload.token } };
}

export type BatchAction = { type: "uploaded" } | { type: "mapping"; mapping: unknown } | { type: "import" } | { type: "undo" } | { type: "cancel" };

async function casStatus(admin: AdminClient, batch: Batch, from: BatchStatus[], patch: Record<string, unknown>): Promise<Batch | null> {
  const { data, error } = await (admin as Db)
    .from("import_batches")
    .update(patch)
    .eq("organization_id", batch.organization_id)
    .eq("company_id", batch.company_id)
    .eq("id", batch.id)
    .in("status", from)
    .select("*");
  if (error) throw error;
  return ((data ?? []) as Batch[])[0] ?? null;
}

const STALE = "Someone else changed this import a moment ago - reload the page.";

/** The owner's buttons. Returns the fresh view. Throws ValidationError with an owner-facing message. */
export async function runBatchAction(admin: AdminClient, company: ImportCompany, batchId: string, action: BatchAction, deps: ImporterDeps = defaultImporterDeps): Promise<BatchView> {
  const scope = { organizationId: company.organizationId, companyId: company.companyId };
  const batch = await loadBatch(admin, scope, batchId);
  if (!batch) throw new ValidationError("That import wasn't found.");
  const nowIso = new Date(deps.now()).toISOString();
  let next: Batch | null = batch;

  switch (action.type) {
    case "uploaded": {
      if (batch.status !== "uploading") return viewOf(batch);
      const size = await deps.storage.stat(admin, batch.file_path);
      if (size === null) throw new ValidationError("The upload didn't finish - try the file again.");
      if (size > MAX_FILE_BYTES) {
        await casStatus(admin, batch, ["uploading"], { status: "failed", error: "That file is over 10 MB." });
        throw new ValidationError("That file is over 10 MB. Split it into smaller files.");
      }
      next = await casStatus(admin, batch, ["uploading"], { status: "uploaded", file_size: size || batch.file_size, error: null });
      if (!next) throw new ValidationError(STALE);
      // A small file is read and previewed right away; anything big carries on in the sweep.
      if ((size || batch.file_size || 0) <= INLINE_BYTES) await advanceBatch(admin, next, company, deps, { budgetMs: 8_000, steps: ["uploaded", "mapped"] }).catch((err) => console.error("[importer] inline step failed:", errorText(err)));
      break;
    }
    case "mapping": {
      if (batch.status !== "mapped" && batch.status !== "previewed") throw new ValidationError("The columns can't be changed at this point.");
      const mapping = cleanMapping(batch.headers ?? [], action.mapping);
      const problem = mappingProblem(mapping);
      if (problem) throw new ValidationError(problem);
      next = await casStatus(admin, batch, ["mapped", "previewed"], { status: "mapped", mapping, mapping_source: "owner", preview: null, error: null });
      if (!next) throw new ValidationError(STALE);
      if ((batch.total_rows ?? 0) <= INLINE_ROWS) await advanceBatch(admin, next, company, deps, { budgetMs: 8_000, steps: ["mapped"] }).catch((err) => console.error("[importer] inline preview failed:", errorText(err)));
      break;
    }
    case "import": {
      if (batch.status !== "previewed") throw new ValidationError(batch.status === "importing" ? "It's already importing." : "Wait for the preview first.");
      const problem = mappingProblem(batch.mapping ?? []);
      if (problem) throw new ValidationError(problem);
      next = await casStatus(admin, batch, ["previewed"], { status: "importing", import_started_at: nowIso, cursor: -1, counts: null, error: null });
      if (!next) throw new ValidationError(STALE);
      break;
    }
    case "undo": {
      if (!(batch.status === "done" || (batch.status === "failed" && batch.import_started_at))) throw new ValidationError("Only a finished import can be undone.");
      next = await casStatus(admin, batch, ["done", "failed"], { status: "undoing", undo_phase: "invoices", undo_cursor: null, undo_report: emptyUndoReport(), error: null });
      if (!next) throw new ValidationError(STALE);
      break;
    }
    case "cancel": {
      if (!viewOf(batch).can.cancel) throw new ValidationError("This import can't be cancelled now - undo it instead.");
      next = await casStatus(admin, batch, ["uploading", "uploaded", "mapped", "previewed", "failed"], { status: "cancelled" });
      if (!next) throw new ValidationError(STALE);
      await deps.storage.remove(admin, batch.file_path).catch(() => undefined);
      break;
    }
  }
  const fresh = await loadBatch(admin, scope, batchId);
  return viewOf(fresh ?? next!);
}

// ── The steps (sweep, under the lease) ───────────────────────────────────────────

async function claimLease(admin: AdminClient, batch: Batch, nowMs: number): Promise<string | null> {
  if (batch.leased_until && Date.parse(batch.leased_until) > nowMs) return null;
  const lease = randomUUID();
  let q = (admin as Db)
    .from("import_batches")
    .update({ lease_id: lease, leased_until: new Date(nowMs + LEASE_MS).toISOString() })
    .eq("organization_id", batch.organization_id)
    .eq("id", batch.id);
  q = batch.lease_id ? q.eq("lease_id", batch.lease_id) : q.is("lease_id", null);
  const { data, error } = await q.select("id");
  if (error) throw error;
  return ((data ?? []) as unknown[]).length > 0 ? lease : null;
}

/**
 * Save under the lease AND the status the step started from (a stale holder's write, or one racing
 * an owner's Cancel / Undo, changes nothing). Returns the fresh row, or null when either moved.
 */
async function save(admin: AdminClient, batch: Batch, lease: string, patch: Record<string, unknown>): Promise<Batch | null> {
  const { data, error } = await (admin as Db)
    .from("import_batches")
    .update(patch)
    .eq("organization_id", batch.organization_id)
    .eq("id", batch.id)
    .eq("lease_id", lease)
    .eq("status", batch.status)
    .select("*");
  if (error) throw error;
  return ((data ?? []) as Batch[])[0] ?? null;
}

async function aiMapping(headers: string[], samples: string[][], company: ImportCompany, deps: ImporterDeps) {
  const { system, user } = mappingPrompt(headers, samples);
  const text = await deps.model({ system, user, maxTokens: 800, organizationId: company.organizationId, companyId: company.companyId });
  return parseMappingAnswer(text, headers.length);
}

/** uploaded → mapped: read the file, store its rows (one per distinct row), guess the columns. */
async function parseStep(admin: AdminClient, batch: Batch, company: ImportCompany, lease: string, deps: ImporterDeps): Promise<Batch | null> {
  const db = admin as Db;
  const bytes = await deps.storage.download(admin, batch.file_path);
  let sheet;
  try {
    sheet = await parseImportFile(bytes, batch.file_kind);
  } catch (err) {
    if (err instanceof ImportFileError) return save(admin, batch, lease, { status: "failed", error: err.message });
    throw err;
  }
  must(await db.from("import_rows").delete().eq("organization_id", batch.organization_id).eq("batch_id", batch.id));
  const seen = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  let duplicates = 0;
  sheet.rows.forEach((cells, i) => {
    const hash = rowHash(cells);
    if (seen.has(hash)) {
      duplicates++;
      return;
    }
    seen.add(hash);
    // row_index + 2 = the row number the owner sees in their spreadsheet.
    const rowIndex = (sheet.lineNumbers[i] ?? i + 2) - 2;
    rows.push({ organization_id: batch.organization_id, company_id: batch.company_id, batch_id: batch.id, row_index: rowIndex, row_hash: hash, cells });
  });
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) must(await db.from("import_rows").insert(rows.slice(i, i + INSERT_CHUNK)));

  const guess = guessMapping(sheet.headers, sheet.rows.slice(0, 20));
  let mapping = guess.mapping;
  let source: "heuristic" | "ai" = "heuristic";
  let unsure = guess.unsure;
  if (guess.needsHelp) {
    const ai = await aiMapping(sheet.headers, sheet.rows.slice(0, 5), company, deps);
    if (ai) {
      mapping = mergeAiMapping(sheet.headers, guess, ai);
      source = "ai";
      unsure = [];
    }
  }
  return save(admin, batch, lease, {
    status: "mapped",
    headers: sheet.headers,
    samples: sheet.rows.slice(0, 5),
    sheet_name: sheet.sheetName,
    mapping,
    mapping_source: source,
    unsure_columns: unsure,
    total_rows: sheet.rows.length,
    duplicate_rows: duplicates,
    file_sha256: createHash("sha256").update(bytes).digest("hex"),
    preview: null,
    error: null,
  });
}

/** mapped → previewed. */
async function previewStep(admin: AdminClient, batch: Batch, company: ImportCompany, lease: string, deps: ImporterDeps): Promise<Batch | null> {
  const nowMs = deps.now();
  const { preview, dateOrders } = await computePreview(admin, { batch, today: localDate(nowMs, company.timeZone), nowMs });
  return save(admin, batch, lease, { status: "previewed", preview, date_orders: dateOrders });
}

/** The final tally, from what each row recorded (robust to a pass that died mid-chunk). */
export async function tallyCounts(admin: AdminClient, batch: Pick<ImportBatchRow, "id" | "organization_id">): Promise<ImportCounts> {
  const rows = await readAllPages<{ outcome: string | null; contact_created: boolean | null; filled: string[] | null; jobs_created: number | null; jobs_skipped: number | null; invoice_id: string | null; balance_cents: number | null; balances_skipped: number | null; account_created: boolean | null }>(
    (from, to) =>
      (admin as Db)
        .from("import_rows")
        .select("outcome, contact_created, filled, jobs_created, jobs_skipped, invoice_id, balance_cents, balances_skipped, account_created")
        .eq("organization_id", batch.organization_id)
        .eq("batch_id", batch.id)
        .order("row_index", { ascending: true })
        .range(from, to),
    30_000,
  );
  const c: ImportCounts = { rowsDone: 0, contactsCreated: 0, contactsMatched: 0, contactsFilled: 0, jobsCreated: 0, jobsSkipped: 0, balancesCreated: 0, balanceCents: 0, balancesSkipped: 0, accountsCreated: 0, invalidRows: 0, repeatRows: 0 };
  for (const r of rows) {
    if (!r.outcome) continue;
    c.rowsDone++;
    if (r.outcome === "created") c.contactsCreated++;
    if (r.outcome === "matched") c.contactsMatched++;
    if (r.outcome === "repeat") c.repeatRows++;
    if (r.outcome === "invalid") c.invalidRows++;
    if ((r.filled ?? []).length) c.contactsFilled++;
    c.jobsCreated += r.jobs_created ?? 0;
    c.jobsSkipped += r.jobs_skipped ?? 0;
    if (r.invoice_id) {
      c.balancesCreated++;
      c.balanceCents += r.balance_cents ?? 0;
    }
    c.balancesSkipped += r.balances_skipped ?? 0;
    if (r.account_created) c.accountsCreated++;
  }
  return c;
}

/** importing: one chunk; → done when no rows are left. */
async function importStep(admin: AdminClient, batch: Batch, company: ImportCompany, lease: string, deps: ImporterDeps, budgetMs: number): Promise<Batch | null> {
  const nowMs = deps.now();
  const result = await applyChunk(admin, batch, company, { nowMs, today: localDate(nowMs, company.timeZone), budgetMs, startedMs: Date.now() });
  if (result.finished) {
    const counts = await tallyCounts(admin, batch);
    return save(admin, batch, lease, { status: "done", counts, import_finished_at: new Date(nowMs).toISOString(), owner_notified_at: null });
  }
  const counts = { ...(batch.counts ?? {}), rowsDone: (batch.counts?.rowsDone ?? 0) + result.processed } as ImportCounts;
  return save(admin, batch, lease, { cursor: result.lastIndex ?? batch.cursor, counts });
}

/** undoing: one chunk; → undone when every phase is through. */
async function undoingStep(admin: AdminClient, batch: Batch, lease: string, deps: ImporterDeps): Promise<Batch | null> {
  const step = await undoStep(admin, batch);
  if (!step.finished) return save(admin, batch, lease, { undo_phase: step.phase, undo_cursor: step.cursor, undo_report: step.report });
  // The question about these balances is moot now.
  if (batch.chase_approval_id) {
    await (admin as Db).from("owner_approvals").update({ status: "superseded" }).eq("id", batch.chase_approval_id).eq("organization_id", batch.organization_id).eq("status", "pending");
  }
  return save(admin, batch, lease, { status: "undone", undo_phase: null, undo_cursor: null, undo_report: step.report, undone_at: new Date(deps.now()).toISOString() });
}

/** The owner's "import done" text (PURE). */
export function doneText(fileName: string, c: ImportCounts): string {
  const customers = c.contactsCreated + c.contactsMatched;
  const had = c.contactsMatched ? ` (${c.contactsCreated.toLocaleString("en-CA")} new, ${c.contactsMatched.toLocaleString("en-CA")} you already had - blanks filled, nothing overwritten)` : "";
  const parts = [`Imported ${plural(customers, "customer")}${had}`, plural(c.jobsCreated, "past job")];
  if (c.balancesCreated) parts.push(`${plural(c.balancesCreated, "open balance")} (${ownerMoney(c.balanceCents)})`);
  const skipped = c.invalidRows ? ` ${plural(c.invalidRows, "row")} skipped - see the import page.` : "";
  const again = c.jobsSkipped || c.balancesSkipped ? " Anything already imported before was left as is." : "";
  return `${parts.join(", ")} from ${fileName.slice(0, 60)}.${skipped}${again} Nobody was texted or emailed.`;
}

/** done: text the owner once (outside quiet hours), with the chase question when balances are held. */
async function notifyStep(admin: AdminClient, batch: Batch, company: ImportCompany, lease: string, deps: ImporterDeps): Promise<Batch | null> {
  const nowMs = deps.now();
  if (company.ownerPhone && isQuietHours(nowMs, company.timeZone)) return batch;
  const claimed = await save(admin, batch, lease, { owner_notified_at: new Date(nowMs).toISOString() });
  if (!claimed) return null;
  const scope = { organizationId: company.organizationId, companyId: company.companyId };
  const counts = batch.counts ?? (await tallyCounts(admin, batch));
  let body = doneText(batch.file_name, counts);

  let chaseId = batch.chase_approval_id;
  let chaseLine: string | null = null;
  if (chaseId) {
    const { data } = await (admin as Db).from("owner_approvals").select("id, status, short_code, summary").eq("id", chaseId).eq("organization_id", batch.organization_id).maybeSingle();
    const row = data as { status: string; short_code: number | null; summary: string } | null;
    if (row?.status === "pending") chaseLine = `#${row.short_code ?? "?"} ${row.summary} ${replyInstruction(KIND_CHASE_IMPORTED, row.short_code)}`;
  } else {
    const held = await loadHeldBalances(admin, scope, [batch.id]);
    if (held.count > 0) {
      const chase = await createChaseApproval(admin, company, held, deps, { inlineTo: company.ownerPhone });
      if (chase) {
        chaseId = chase.id;
        chaseLine = `#${chase.shortCode ?? "?"} ${chase.summary} ${replyInstruction(KIND_CHASE_IMPORTED, chase.shortCode)}`;
        await save(admin, claimed, lease, { chase_approval_id: chase.id, chase_status: "pending" });
      }
    }
  }
  if (!company.ownerPhone) return claimed;
  if (chaseLine) body = `${body}\n${chaseLine}`;
  const status = await deps.textOwner(admin, { to: company.ownerPhone, body, organizationId: company.organizationId, companyId: company.companyId, platformBrand: company.platformBrand });
  if (status === "failed") {
    // Try again next pass (the question too: the owner channel's sweep may also re-send it).
    await save(admin, claimed, lease, { owner_notified_at: null });
    if (chaseId) await (admin as Db).from("owner_approvals").update({ notified_at: null, notified_to: null }).eq("id", chaseId).eq("organization_id", batch.organization_id).eq("status", "pending");
  }
  return claimed;
}

/** Old finished batches: delete the file and the raw rows (the records they made stay; undo still works). */
async function purgeStep(admin: AdminClient, batch: Batch, lease: string, deps: ImporterDeps): Promise<Batch | null> {
  await deps.storage.remove(admin, batch.file_path).catch(() => undefined);
  must(await (admin as Db).from("import_rows").update({ cells: [] }).eq("organization_id", batch.organization_id).eq("batch_id", batch.id));
  return save(admin, batch, lease, { purged_at: new Date(deps.now()).toISOString(), samples: [] });
}

function wantsPurge(b: Batch, nowMs: number): boolean {
  if (b.purged_at) return false;
  if (!["done", "undone", "cancelled", "failed"].includes(b.status)) return false;
  return nowMs - Date.parse(b.updated_at ?? b.created_at) > PURGE_AFTER_MS;
}

/**
 * Move one batch forward as far as the budget allows (each step under the lease). `steps` limits
 * which statuses this call may work on (the HTTP request only reads/previews).
 */
export async function advanceBatch(admin: AdminClient, batch: Batch, company: ImportCompany, deps: ImporterDeps, options: { budgetMs?: number; steps?: BatchStatus[] } = {}): Promise<Batch> {
  const started = Date.now();
  const budget = options.budgetMs ?? 25_000;
  const allowed = (s: BatchStatus) => !options.steps || options.steps.includes(s);
  const lease = await claimLease(admin, batch, deps.now());
  if (!lease) return batch;
  let current: Batch | null = { ...batch, lease_id: lease };
  try {
    while (current && Date.now() - started < budget) {
      let b: Batch = current;
      const left = budget - (Date.now() - started);
      const limit = MAX_ATTEMPTS[b.status];
      if (limit !== undefined && allowed(b.status)) {
        if ((b.failures ?? 0) >= limit) {
          current = await giveUp(admin, b, company, lease, deps);
          break;
        }
        const counted = await save(admin, b, lease, { failures: (b.failures ?? 0) + 1 });
        if (!counted) break;
        b = counted;
      }
      let next: Batch | null;
      if (b.status === "uploaded" && allowed("uploaded")) next = await parseStep(admin, b, company, lease, deps);
      else if (b.status === "mapped" && allowed("mapped")) next = await previewStep(admin, b, company, lease, deps);
      else if (b.status === "importing" && allowed("importing")) next = await importStep(admin, b, company, lease, deps, left);
      else if (b.status === "undoing" && allowed("undoing")) next = await undoingStep(admin, b, lease, deps);
      else if (b.status === "done" && !b.owner_notified_at && allowed("done")) {
        current = await notifyStep(admin, b, company, lease, deps);
        break;
      } else if (wantsPurge(b, deps.now()) && !options.steps) {
        current = await purgeStep(admin, b, lease, deps);
        break;
      } else break;
      // The step finished: its attempt doesn't count against it.
      current = next && (next.failures ?? 0) > 0 ? ((await save(admin, next, lease, { failures: 0 })) ?? next) : next;
    }
  } catch (err) {
    const message = errorText(err);
    console.error("[importer] batch step failed", batch.id, message);
    // Keep the status (the next pass retries — the attempt was already counted) but say what happened.
    await save(admin, current ?? batch, lease, { error: message.slice(0, 300) }).catch(() => undefined);
  } finally {
    await (admin as Db).from("import_batches").update({ leased_until: null }).eq("organization_id", batch.organization_id).eq("id", batch.id).eq("lease_id", lease);
  }
  return current ?? batch;
}

/** Too many passes died on this step: mark it failed and (for a half-done import / undo) tell the owner. PURE text. */
export function stuckText(b: Pick<ImportBatchRow, "status" | "file_name" | "cursor" | "total_rows">): string | null {
  const file = b.file_name.slice(0, 60);
  if (b.status === "importing") {
    const done = Math.max(0, Math.min(b.cursor + 1, b.total_rows));
    return `Your customer import of ${file} stopped after ${done.toLocaleString("en-CA")} of ${b.total_rows.toLocaleString("en-CA")} rows - we kept hitting a problem. Nothing more will be added and nobody was texted. Open the import page to undo what got in, or try the file again.`;
  }
  if (b.status === "undoing") return `Undoing your import of ${file} kept hitting a problem, so it stopped part way. Open the import page to try the undo again.`;
  return null;
}

async function giveUp(admin: AdminClient, b: Batch, company: ImportCompany, lease: string, deps: ImporterDeps): Promise<Batch | null> {
  const text = stuckText(b);
  const reason = b.status === "uploaded" || b.status === "mapped" ? "We couldn't read that file. Save it again as .csv and try again, or split it into smaller files." : `Stopped after ${b.failures ?? 0} tries${b.error ? `: ${b.error}` : ""}`.slice(0, 300);
  const failed = await save(admin, b, lease, { status: "failed", error: reason, ...(b.status === "importing" ? { counts: await tallyCounts(admin, b) } : {}), owner_notified_at: new Date(deps.now()).toISOString() });
  if (failed && text && company.ownerPhone) {
    await deps.textOwner(admin, { to: company.ownerPhone, body: text, organizationId: company.organizationId, companyId: company.companyId, platformBrand: company.platformBrand });
  }
  return failed;
}

// ── The sweep ─────────────────────────────────────────────────────────────────────

const WORK_COLUMNS = "id, organization_id, company_id, status, owner_notified_at, purged_at, updated_at, created_at";
const PER_SWEEP = 20;
const CANDIDATES = 200;

/**
 * Batches with work to do (oldest first), plus finished ones due a purge. Candidates are read
 * light, and a batch of a company that has the import switched off (before it started importing)
 * is passed over HERE — so a pile of those can never crowd out the batches that can move.
 */
async function batchesWithWork(admin: AdminClient, nowMs: number, enabled: (orgId: string, companyId: string) => Promise<boolean>): Promise<Batch[]> {
  const db = admin as Db;
  type Light = Pick<Batch, "id" | "organization_id" | "company_id" | "status" | "owner_notified_at" | "purged_at" | "updated_at" | "created_at">;
  const candidates = new Map<string, Light>();
  const active = must(await db.from("import_batches").select(WORK_COLUMNS).in("status", ["uploaded", "mapped", "importing", "undoing"]).order("updated_at", { ascending: true }).limit(CANDIDATES)) as Light[];
  const toNotify = must(await db.from("import_batches").select(WORK_COLUMNS).eq("status", "done").is("owner_notified_at", null).order("updated_at", { ascending: true }).limit(CANDIDATES)) as Light[];
  const old = new Date(nowMs - PURGE_AFTER_MS).toISOString();
  const stale = must(await db.from("import_batches").select(WORK_COLUMNS).in("status", ["done", "undone", "cancelled", "failed"]).is("purged_at", null).lt("updated_at", old).limit(PER_SWEEP)) as Light[];
  for (const b of [...active, ...toNotify, ...stale]) candidates.set(b.id, b);
  const picked: string[] = [];
  for (const b of candidates.values()) {
    if (picked.length >= PER_SWEEP) break;
    const startedWork = b.status === "importing" || b.status === "undoing" || b.status === "done";
    if (!startedWork && !wantsPurge(b as Batch, nowMs) && !(await enabled(b.organization_id, b.company_id))) continue;
    picked.push(b.id);
  }
  if (picked.length === 0) return [];
  return must(await db.from("import_batches").select("*").in("id", picked)) as Batch[];
}

/**
 * The import sweep (every scheduler tick, every worker; leases make it safe). A house org only
 * ever has batches if the owner switched the import on; a batch whose company switched it off
 * before importing just waits.
 */
export async function runImportSweep(admin: AdminClient, nowMs: number = Date.now(), deps: ImporterDeps = defaultImporterDeps, options: { budgetMs?: number } = {}): Promise<{ advanced: string[] }> {
  const started = Date.now();
  const budget = options.budgetMs ?? 25_000;
  const advanced: string[] = [];
  const stepDeps: ImporterDeps = { ...deps, now: () => nowMs + (Date.now() - started) };
  const companies = new Map<string, Promise<ImportCompany | null>>();
  const companyOf = (orgId: string, companyId: string) => {
    if (!companies.has(companyId)) companies.set(companyId, loadImportCompany(admin, orgId, companyId).catch(() => null));
    return companies.get(companyId)!;
  };
  const enabled = async (orgId: string, companyId: string) => (await companyOf(orgId, companyId))?.settings.enabled === true;
  for (const batch of await batchesWithWork(admin, nowMs, enabled)) {
    const left = budget - (Date.now() - started);
    if (left <= 0) break;
    try {
      const company = await companyOf(batch.organization_id, batch.company_id);
      if (!company) continue;
      await advanceBatch(admin, batch, company, stepDeps, { budgetMs: left });
      advanced.push(batch.id);
    } catch (err) {
      console.error("[importer] sweep skipped batch", batch.id, errorText(err));
    }
  }
  return { advanced };
}
