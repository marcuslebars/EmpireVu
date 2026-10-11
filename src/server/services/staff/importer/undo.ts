/**
 * Undo a batch: remove what it CREATED, as long as nothing has happened to it since. Run by the
 * sweep in chunks (status "undoing"), phase by phase so a kept record keeps what it hangs on:
 *
 *   invoices  (import_batch_id)        kept if paid / partly paid / viewed / reminded / any payment
 *   bookings  (source "import:<id>")   kept if edited, no longer completed, invoiced, assigned
 *   contacts  (metadata.import.batchId) kept if they've texted / been texted, have a booking,
 *                                       quote or invoice left, have a conversation, or were edited
 *   accounts  (created by this batch)   kept while a contact or invoice still uses them
 *
 * Contacts the batch only MATCHED are never removed (blanks it filled stay filled). Every read and
 * delete is pinned to the batch's organization AND company. Keyset paging (id > cursor) means a
 * kept record is passed over, never retried forever.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db, ImportBatchRow, UndoReport } from "./db-types";
import { chunks, must } from "./util";

export const UNDO_CHUNK = 200;
/** An edit this long after the import counts as "touched since". */
const EDIT_SLACK_MS = 60_000;
const MAX_EXAMPLES = 10;

export function emptyUndoReport(): UndoReport {
  return { removed: { contacts: 0, jobs: 0, balances: 0, accounts: 0 }, kept: { contacts: 0, jobs: 0, balances: 0, accounts: 0 }, keptExamples: [] };
}

function edited(row: { created_at?: string | null; updated_at?: string | null }): boolean {
  const c = Date.parse(row.created_at ?? "");
  const u = Date.parse(row.updated_at ?? "");
  return Number.isFinite(c) && Number.isFinite(u) && u - c > EDIT_SLACK_MS;
}

async function idsReferencing(db: Db, table: string, column: string, ids: string[], scope: { organizationId: string }, extra?: (q: Db) => Db): Promise<Set<string>> {
  const out = new Set<string>();
  for (const list of chunks(ids)) {
    let q = db.from(table).select(column).eq("organization_id", scope.organizationId).in(column, list);
    if (extra) q = extra(q);
    const { data, error } = await q.limit(10_000);
    if (error) throw error;
    for (const r of (data ?? []) as Array<Record<string, unknown>>) if (r[column]) out.add(String(r[column]));
  }
  return out;
}

/**
 * Delete these ids; if the batch delete is refused (something we didn't check still points at one
 * of them), delete one by one and keep the ones that can't go. Returns how many were removed.
 */
async function removeWhere(ids: string[], del: (ids: string[]) => PromiseLike<{ error: unknown }>): Promise<number> {
  const { error } = await del(ids);
  if (!error) return ids.length;
  let removed = 0;
  for (const id of ids) {
    const one = await del([id]);
    if (!one.error) removed++;
  }
  return removed;
}

function note(report: UndoReport, text: string): void {
  if (report.keptExamples.length < MAX_EXAMPLES) report.keptExamples.push(text);
}

export interface UndoStep {
  phase: ImportBatchRow["undo_phase"];
  cursor: string | null;
  report: UndoReport;
  finished: boolean;
}

/** One chunk of the undo. PURE apart from the scoped reads/deletes. */
export async function undoStep(admin: AdminClient, batch: ImportBatchRow): Promise<UndoStep> {
  const db = admin as Db;
  const scope = { organizationId: batch.organization_id, companyId: batch.company_id };
  const report: UndoReport = batch.undo_report ?? emptyUndoReport();
  const phase = batch.undo_phase ?? "invoices";
  const cursor = batch.undo_cursor ?? "";
  const base = (table: string, columns: string) => db.from(table).select(columns).eq("organization_id", scope.organizationId).eq("company_id", scope.companyId);

  if (phase === "invoices") {
    const rows = must(
      await base("invoices", "id, contact_id, status, amount_paid_cents, pending_payment_cents, last_reminder_at, reminder_count, invoice_number, bill_to")
        .eq("import_batch_id", batch.id)
        .gt("id", cursor)
        .order("id", { ascending: true })
        .limit(UNDO_CHUNK),
    ) as Array<{ id: string; status: string; amount_paid_cents: number; pending_payment_cents: number; last_reminder_at: string | null; reminder_count: number; invoice_number: string | null; bill_to: { name?: string } | null }>;
    if (rows.length === 0) return { phase: "bookings", cursor: null, report, finished: false };
    const ids = rows.map((r) => r.id);
    const paid = await idsReferencing(db, "invoice_payments", "invoice_id", ids, scope);
    const texted = await idsReferencing(db, "invoice_reminder_texts", "invoice_id", ids, scope);
    const remove: string[] = [];
    for (const r of rows) {
      const touched = r.status !== "sent" || (r.amount_paid_cents ?? 0) > 0 || (r.pending_payment_cents ?? 0) > 0 || Boolean(r.last_reminder_at) || (r.reminder_count ?? 0) > 0 || paid.has(r.id) || texted.has(r.id);
      if (touched) {
        report.kept.balances++;
        note(report, `${r.bill_to?.name ?? "A customer"}'s balance (${r.invoice_number ?? "invoice"}) has a payment or reminder since`);
      } else remove.push(r.id);
    }
    if (remove.length) {
      const gone = await removeWhere(remove, (ids) => db.from("invoices").delete().eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("import_batch_id", batch.id).in("id", ids));
      report.removed.balances += gone;
      if (gone < remove.length) {
        report.kept.balances += remove.length - gone;
        note(report, "a balance is still linked to other records");
      }
    }
    return { phase: "invoices", cursor: rows[rows.length - 1].id, report, finished: false };
  }

  if (phase === "bookings") {
    const rows = must(
      await base("bookings", "id, contact_id, status, title, created_at, updated_at")
        .eq("source", `import:${batch.id}`)
        .gt("id", cursor)
        .order("id", { ascending: true })
        .limit(UNDO_CHUNK),
    ) as Array<{ id: string; status: string; title: string | null; created_at: string | null; updated_at: string | null }>;
    if (rows.length === 0) return { phase: "contacts", cursor: null, report, finished: false };
    const ids = rows.map((r) => r.id);
    const invoiced = await idsReferencing(db, "invoices", "booking_id", ids, scope);
    const assigned = await idsReferencing(db, "booking_assignments", "booking_id", ids, scope);
    const remove: string[] = [];
    for (const r of rows) {
      if (r.status !== "completed" || edited(r) || invoiced.has(r.id) || assigned.has(r.id)) {
        report.kept.jobs++;
        note(report, `the past job "${(r.title ?? "job").slice(0, 40)}" was changed since`);
      } else remove.push(r.id);
    }
    if (remove.length) {
      const gone = await removeWhere(remove, (ids) => db.from("bookings").delete().eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("source", `import:${batch.id}`).in("id", ids));
      report.removed.jobs += gone;
      if (gone < remove.length) {
        report.kept.jobs += remove.length - gone;
        note(report, "a past job is still linked to other records");
      }
    }
    return { phase: "bookings", cursor: rows[rows.length - 1].id, report, finished: false };
  }

  if (phase === "contacts") {
    const rows = must(
      await base("contacts", "id, first_name, last_name, created_at, updated_at")
        .eq("metadata->import->>batchId", batch.id)
        .gt("id", cursor)
        .order("id", { ascending: true })
        .limit(UNDO_CHUNK),
    ) as Array<{ id: string; first_name: string | null; last_name: string | null; created_at: string | null; updated_at: string | null }>;
    if (rows.length === 0) return { phase: "accounts", cursor: null, report, finished: false };
    const ids = rows.map((r) => r.id);
    const busy = new Set<string>();
    for (const table of ["message_log", "sms_conversations", "bookings", "quotes", "invoices"]) {
      for (const id of await idsReferencing(db, table, "contact_id", ids, scope)) busy.add(id);
    }
    const remove: string[] = [];
    for (const r of rows) {
      if (busy.has(r.id) || edited(r)) {
        report.kept.contacts++;
        note(report, `${[r.first_name, r.last_name].filter(Boolean).join(" ") || "a customer"} has messages, jobs or changes since`);
      } else remove.push(r.id);
    }
    if (remove.length) {
      const gone = await removeWhere(remove, (ids) => db.from("contacts").delete().eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("metadata->import->>batchId", batch.id).in("id", ids));
      report.removed.contacts += gone;
      if (gone < remove.length) {
        report.kept.contacts += remove.length - gone;
        note(report, "a customer is still linked to other records");
      }
    }
    return { phase: "contacts", cursor: rows[rows.length - 1].id, report, finished: false };
  }

  // accounts: the ones this batch created, if nothing uses them any more.
  const created = must(
    await db.from("import_rows").select("account_id").eq("organization_id", scope.organizationId).eq("batch_id", batch.id).eq("account_created", true).limit(30_000),
  ) as Array<{ account_id: string | null }>;
  const ids = [...new Set(created.map((r) => r.account_id).filter((id): id is string => Boolean(id)))];
  if (ids.length) {
    const used = new Set<string>();
    for (const table of ["contacts", "invoices"]) {
      for (const list of chunks(ids)) {
        const { data, error } = await db.from(table).select("customer_account_id").eq("organization_id", scope.organizationId).in("customer_account_id", list).limit(10_000);
        if (error) throw error;
        for (const r of (data ?? []) as Array<{ customer_account_id: string | null }>) if (r.customer_account_id) used.add(r.customer_account_id);
      }
    }
    const remove = ids.filter((id) => !used.has(id));
    report.kept.accounts += ids.length - remove.length;
    for (const list of chunks(remove)) {
      must(await db.from("customer_accounts").delete().eq("organization_id", scope.organizationId).in("id", list));
    }
    report.removed.accounts += remove.length;
  }
  return { phase: "accounts", cursor: null, report, finished: true };
}

/** "Removed 312 customers, 1,104 past jobs and 14 balances. Kept 3 …" PURE. */
export function undoSummary(report: UndoReport): string {
  const r = report.removed;
  const k = report.kept;
  const parts = [`${r.contacts} customers`, `${r.jobs} past jobs`, `${r.balances} balances`];
  const kept = k.contacts + k.jobs + k.balances;
  const keptParts = [k.contacts ? `${k.contacts} customers` : null, k.jobs ? `${k.jobs} past jobs` : null, k.balances ? `${k.balances} balances` : null].filter(Boolean);
  return `Removed ${parts.join(", ")}.${kept ? ` Kept ${keptParts.join(", ")} that were used since (texts, bookings, payments or edits).` : ""}`;
}
