/**
 * Writing one chunk of an import (the sweep calls this with ≤500 rows and a time budget).
 *
 * QUIET BY CONSTRUCTION: nothing here sends a message, emits an activity / workflow event, or
 * calls a service that does (createBooking, createInvoice, sendInvoice…). Every write is a direct,
 * scoped insert/update with the service role, pinned to the batch's organization AND company:
 *
 *   contacts   consent_source "import", NO sms_consent_at (an import is not consent), stage
 *              "closed" (past customers). A match (phone last-10 or email) only gets its BLANK
 *              fields filled — nothing is overwritten, consent and opt-outs are never touched.
 *   bookings   past jobs as completed bookings in the past (completed_at = the job date — the
 *              Marketer's CASL purchase date), source "import:<batch>", source_call_id = the
 *              job's key (unique per company → a re-upload skips it).
 *   invoices   open balances: status sent with the balance due, NEVER emailed or texted,
 *              reminders_paused + import_hold until the owner OKs chase_imported_balances,
 *              import_key unique per company (a re-upload skips it), kept out of the accounting
 *              sync (they came from the books).
 *   customer_accounts  for a business name, when there isn't one by that exact name.
 */
import { randomBytes } from "node:crypto";

import { localWallTimeToUtcMs } from "@/server/services/monthly-scorecard/weeks";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { parseInvoiceSettings, formatInvoiceNumber } from "@/server/services/invoices/settings";
import type { Db, ImportBatchRow, ImportField, RowOutcome } from "./db-types";
import { isUniqueViolation } from "./deps";
import { balanceKey, buildRecord, displayName, jobKey, type DateOrder, type ImportRecord } from "./normalize";
import { existingAccounts, loadBatchRows } from "./preview";
import { ContactResolver, type KnownContact } from "./resolver";
import type { ImportCompany } from "./settings";
import { must } from "./util";

export const CHUNK_ROWS = 500;

export interface ChunkResult {
  processed: number;
  lastIndex: number | null;
  /** No rows left after this chunk. */
  finished: boolean;
}

interface Ctx {
  db: Db;
  batch: ImportBatchRow & { date_orders?: DateOrder[] | null };
  company: ImportCompany;
  nowIso: string;
  /** YYYY-MM-DD in the company's time zone. */
  today: string;
  accounts: Map<string, string>;
}

function sourceLabel(batch: Pick<ImportBatchRow, "file_name">): string {
  return batch.file_name.slice(0, 80);
}

function notesFor(r: ImportRecord): string | null {
  const lines = [r.notes, r.address ? `Address: ${r.address}` : null, r.tags.length ? `Tags: ${r.tags.join(", ")}` : null].filter(Boolean);
  return lines.length ? lines.join("\n").slice(0, 4000) : null;
}

/** Noon local on a date (a past job's time), as an ISO instant. */
function noonOn(date: string, timeZone: string): string {
  try {
    return new Date(localWallTimeToUtcMs(date, 12, 0, timeZone)).toISOString();
  } catch {
    return `${date}T16:00:00.000Z`;
  }
}

async function ensureAccount(ctx: Ctx, r: ImportRecord, rowNumber: number): Promise<{ id: string; created: boolean } | null> {
  if (!r.company) return null;
  const key = r.company.toLowerCase();
  const hit = ctx.accounts.get(key);
  if (hit) return { id: hit, created: false };
  const { data, error } = await ctx.db
    .from("customer_accounts")
    .insert({
      organization_id: ctx.batch.organization_id,
      name: r.company,
      billing_email: r.email,
      billing_phone: r.phone,
      billing_address: r.address,
      notes: `Imported from ${sourceLabel(ctx.batch)} (row ${rowNumber}).`,
      created_by: null,
    })
    .select("id")
    .single();
  if (error) throw error;
  const id = String((data as { id: string }).id);
  ctx.accounts.set(key, id);
  return { id, created: true };
}

async function createContact(ctx: Ctx, r: ImportRecord, accountId: string | null): Promise<string> {
  const metadata: Record<string, unknown> = { import: { batchId: ctx.batch.id, at: ctx.nowIso, file: sourceLabel(ctx.batch) } };
  if (r.address) metadata.address = r.address;
  if (r.otherPhones.length) metadata.other_phones = r.otherPhones;
  if (r.tags.length) metadata.tags = r.tags;
  if (r.company) metadata.company = r.company;
  const { data, error } = await ctx.db
    .from("contacts")
    .insert({
      organization_id: ctx.batch.organization_id,
      company_id: ctx.batch.company_id,
      first_name: r.firstName ?? displayName(r),
      last_name: r.lastName,
      phone: r.phone,
      email: r.email,
      notes: notesFor(r),
      stage: "closed",
      // An imported list is NOT consent to text: no sms_consent_at. CASL implied consent comes
      // only from the purchase dates (the past jobs below) — checkConsent decides per message.
      consent_source: "import",
      sms_consent_at: null,
      customer_account_id: accountId,
      metadata,
    })
    .select("id")
    .single();
  if (error) throw error;
  return String((data as { id: string }).id);
}

/** Fill only what's blank on an existing contact. Returns the fields filled. */
async function fillBlanks(ctx: Ctx, known: KnownContact, r: ImportRecord, accountId: string | null): Promise<string[]> {
  const patch: Record<string, unknown> = {};
  if (!known.last_name && r.lastName) patch.last_name = r.lastName;
  if (!known.phone && r.phone) patch.phone = r.phone;
  if (!known.email && r.email) patch.email = r.email;
  if (!known.notes) {
    const notes = notesFor(r);
    if (notes) patch.notes = notes;
  }
  if (!known.customer_account_id && accountId) patch.customer_account_id = accountId;
  const meta = { ...(known.metadata ?? {}) };
  let metaChanged = false;
  if (r.address && !meta.address) {
    meta.address = r.address;
    metaChanged = true;
  }
  if (r.tags.length && !meta.tags) {
    meta.tags = r.tags;
    metaChanged = true;
  }
  if (metaChanged) patch.metadata = meta;
  const filled = Object.keys(patch).filter((k) => k !== "metadata").concat(metaChanged ? ["address/tags"] : []);
  if (filled.length === 0) return [];
  must(await ctx.db.from("contacts").update(patch).eq("id", known.id).eq("organization_id", ctx.batch.organization_id).eq("company_id", ctx.batch.company_id));
  Object.assign(known, {
    last_name: (patch.last_name as string | undefined) ?? known.last_name,
    phone: (patch.phone as string | undefined) ?? known.phone,
    email: (patch.email as string | undefined) ?? known.email,
    notes: (patch.notes as string | undefined) ?? known.notes,
    customer_account_id: (patch.customer_account_id as string | undefined) ?? known.customer_account_id,
    metadata: metaChanged ? meta : known.metadata,
  });
  return filled;
}

async function addPastJob(ctx: Ctx, contactId: string, r: ImportRecord): Promise<"created" | "exists"> {
  const job = r.job!;
  const key = jobKey(ctx.batch.company_id, contactId, job);
  const at = noonOn(job.date, ctx.company.timeZone);
  const { error } = await ctx.db.from("bookings").insert({
    organization_id: ctx.batch.organization_id,
    company_id: ctx.batch.company_id,
    contact_id: contactId,
    title: job.description ?? "Past job",
    description: `Imported from ${sourceLabel(ctx.batch)}.`,
    scheduled_for: at,
    duration_minutes: 60,
    status: "completed",
    completed_at: at,
    location: r.address,
    price_cents: job.amountCents,
    source: `import:${ctx.batch.id}`,
    source_call_id: key,
    created_by: null,
  });
  if (error) {
    if (isUniqueViolation(error)) return "exists";
    throw error;
  }
  return "created";
}

async function allocateNumber(ctx: Ctx): Promise<string | null> {
  try {
    const { data, error } = await ctx.db.rpc("next_invoice_number", { p_company_id: ctx.batch.company_id });
    if (error || (typeof data !== "string" && typeof data !== "number") || String(data).trim() === "") return null;
    return formatInvoiceNumber(parseInvoiceSettings(ctx.company.invoiceSettings as never), String(data));
  } catch {
    return null;
  }
}

async function addBalance(ctx: Ctx, contactId: string, accountId: string | null, r: ImportRecord, rowNumber: number): Promise<{ id: string } | "exists"> {
  const key = balanceKey(contactId, r);
  const { data: found, error: findError } = await ctx.db
    .from("invoices")
    .select("id")
    .eq("organization_id", ctx.batch.organization_id)
    .eq("company_id", ctx.batch.company_id)
    .eq("import_key", key)
    .limit(1);
  if (findError) throw findError;
  if (((found ?? []) as unknown[]).length > 0) return "exists";
  const today = ctx.today;
  const issue = r.balanceDate && r.balanceDate <= today ? r.balanceDate : today;
  const due = r.balanceDueDate && r.balanceDueDate >= issue ? r.balanceDueDate : issue;
  const cents = r.balanceCents;
  const ref = r.invoiceRef;
  const { data, error } = await ctx.db
    .from("invoices")
    .insert({
      organization_id: ctx.batch.organization_id,
      company_id: ctx.batch.company_id,
      contact_id: contactId,
      customer_account_id: accountId,
      invoice_number: await allocateNumber(ctx),
      public_token: randomBytes(16).toString("hex"),
      status: "sent",
      currency: "CAD",
      title: "Balance carried over",
      line_items: [{ label: "Balance carried over", description: ref ? `Invoice ${ref}` : "From your previous records", quantity: 1, unitPriceCents: cents, amountCents: cents }],
      subtotal_cents: cents,
      tax_rate_bps: 0,
      tax_cents: 0,
      total_cents: cents,
      credit_cents: 0,
      amount_paid_cents: 0,
      pending_payment_cents: 0,
      balance_due_cents: cents,
      issue_date: issue,
      due_date: due,
      payment_terms_days: 0,
      bill_to: { name: [r.firstName, r.lastName].filter(Boolean).join(" ") || displayName(r), company: r.company, email: r.email, phone: r.phone, address: r.address },
      internal_notes: `Imported from ${sourceLabel(ctx.batch)} (row ${rowNumber})${ref ? `, their invoice ${ref}` : ""}. We never sent this to the customer.`,
      sent_at: noonOn(issue, ctx.company.timeZone),
      reminders_paused: true,
      imported_at: ctx.nowIso,
      import_batch_id: ctx.batch.id,
      import_hold: true,
      import_key: key,
      created_by: null,
    })
    .select("id")
    .single();
  if (error) {
    if (isUniqueViolation(error)) return "exists";
    throw error;
  }
  return { id: String((data as { id: string }).id) };
}

interface RowWrite {
  outcome: RowOutcome;
  reason: string | null;
  contact_id: string | null;
  contact_created: boolean;
  filled: string[] | null;
  jobs_created: number;
  jobs_skipped: number;
  invoice_id: string | null;
  balance_cents: number;
  balances_skipped: number;
  account_id: string | null;
  account_created: boolean;
}

async function applyRow(ctx: Ctx, resolver: ContactResolver, index: number, cells: string[], dateOrders: DateOrder[], today: string): Promise<RowWrite> {
  const rowNumber = index + 2;
  const built = buildRecord(cells, ctx.batch.mapping as ImportField[], { dateOrders, today });
  const empty: RowWrite = { outcome: "invalid", reason: null, contact_id: null, contact_created: false, filled: null, jobs_created: 0, jobs_skipped: 0, invoice_id: null, balance_cents: 0, balances_skipped: 0, account_id: null, account_created: false };
  if (!built.ok) return { ...empty, reason: built.reason };
  const r = built.record;
  const write: RowWrite = { ...empty, reason: r.warnings.length ? r.warnings.join("; ").slice(0, 500) : null };

  const known = resolver.find(r);
  const account = await ensureAccount(ctx, r, rowNumber);
  if (account) {
    write.account_id = account.id;
    write.account_created = account.created;
  }
  let contactId: string;
  if (known) {
    contactId = known.id;
    const ours = known.source === "batch" || (known.metadata?.import as { batchId?: string } | undefined)?.batchId === ctx.batch.id;
    write.outcome = ours ? "repeat" : "matched";
    write.filled = ours ? null : await fillBlanks(ctx, known, r, account?.id ?? null);
    resolver.link(known, r);
  } else {
    contactId = await createContact(ctx, r, account?.id ?? null);
    resolver.remember(contactId, r, { customer_account_id: account?.id ?? null, metadata: { import: { batchId: ctx.batch.id } } });
    write.outcome = "created";
    write.contact_created = true;
  }
  write.contact_id = contactId;

  if (r.job) {
    const outcome = await addPastJob(ctx, contactId, r);
    if (outcome === "created") write.jobs_created = 1;
    else write.jobs_skipped = 1;
  }
  if (r.balanceCents > 0) {
    const inv = await addBalance(ctx, contactId, account?.id ?? null, r, rowNumber);
    if (inv === "exists") write.balances_skipped = 1;
    else {
      write.invoice_id = inv.id;
      write.balance_cents = r.balanceCents;
    }
  }
  return write;
}

/**
 * Apply the next chunk (rows after batch.cursor). The caller holds the batch's lease and saves
 * the returned cursor. Rows already applied (a pass that died after writing them) are skipped.
 */
export async function applyChunk(
  admin: AdminClient,
  batch: ImportBatchRow & { date_orders?: DateOrder[] | null },
  company: ImportCompany,
  options: { nowMs: number; today: string; chunkRows?: number; budgetMs?: number; startedMs?: number },
): Promise<ChunkResult> {
  const db = admin as Db;
  const started = options.startedMs ?? Date.now();
  const budget = options.budgetMs ?? 25_000;
  const rows = await loadBatchRows(admin, batch, batch.cursor, options.chunkRows ?? CHUNK_ROWS);
  if (rows.length === 0) return { processed: 0, lastIndex: null, finished: true };
  const { data: appliedData, error: appliedError } = await db
    .from("import_rows")
    .select("row_index")
    .eq("organization_id", batch.organization_id)
    .eq("batch_id", batch.id)
    .gt("row_index", batch.cursor)
    .lte("row_index", rows[rows.length - 1].row_index)
    .not("applied_at", "is", null);
  if (appliedError) throw appliedError;
  const alreadyApplied = new Set(((appliedData ?? []) as Array<{ row_index: number }>).map((r) => r.row_index));

  const dateOrders = (batch.date_orders ?? []) as DateOrder[];
  const records = rows
    .map((r) => buildRecord(r.cells, batch.mapping, { dateOrders, today: options.today }))
    .filter((b): b is { ok: true; record: ImportRecord } => b.ok)
    .map((b) => b.record);
  const resolver = new ContactResolver(db, { organizationId: batch.organization_id, companyId: batch.company_id });
  await resolver.preload(records);
  const ctx: Ctx = {
    db,
    batch,
    company,
    nowIso: new Date(options.nowMs).toISOString(),
    today: options.today,
    accounts: await existingAccounts(admin, batch.organization_id, records.map((r) => r.company).filter((c): c is string => Boolean(c))),
  };

  let lastIndex: number | null = null;
  let processed = 0;
  for (const row of rows) {
    if (processed > 0 && Date.now() - started > budget) break;
    if (!alreadyApplied.has(row.row_index)) {
      const write = await applyRow(ctx, resolver, row.row_index, row.cells, dateOrders, options.today);
      must(
        await db
          .from("import_rows")
          .update({ ...write, applied_at: ctx.nowIso })
          .eq("organization_id", batch.organization_id)
          .eq("batch_id", batch.id)
          .eq("row_index", row.row_index),
      );
    }
    lastIndex = row.row_index;
    processed++;
  }
  return { processed, lastIndex, finished: false };
}
