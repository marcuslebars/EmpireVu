/**
 * SANCTIONED EXCEPTION (service role): the accounting sync worker.
 *
 * Runs in the worker's scheduler pass (and for "Sync now"). It claims queued jobs
 * (claim_accounting_sync_jobs — skip-locked, never two jobs for one record at once) and
 * pushes each record to its company's connected file. Every read is pinned to the job's
 * own company + organization; nothing comes from request input.
 *
 * Per job:
 *   invoice → its customer (find-or-create), the invoice (create / update / void), then a
 *             quote deposit as a payment, and any earlier payments still waiting on it
 *   payment → makes sure its invoice is in the file first; refunded/removed → deleted there
 *   expense → its vendor/contact, the expense, then the receipt file once
 * An unchanged record (same payload hash) makes no API call at all. Failures back off
 * (rate limits honour Retry-After); a dead sign-in pauses the company until it reconnects.
 */
import type { Tables } from "@/server/db/database.types";
import { downloadReceipt } from "@/server/services/expenses/receipts";
import { reviewTimeZone } from "@/server/services/reviews/rules";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { loadOrganizationBrand } from "@/server/services/platform-brand";
import { DEFAULT_PRODUCT_NAME, customerDoc, depositPaymentDoc, docHash, expenseDoc, invoiceDoc, paymentDoc } from "./mapping";
import { providerFor } from "./providers";
import { sessionFor } from "./tokens";
import { ProviderError, missingSettings, parseSettings, type AccountingProvider, type AccountingSettings, type ProviderSession, type RemoteRef } from "./types";

type Admin = ReturnType<typeof createSupabaseAdminClient>;
type Job = Tables<"accounting_sync_jobs">;
type Connection = Tables<"accounting_connections">;
type LinkType = "customer" | "vendor" | "invoice" | "payment" | "deposit" | "expense";

const BACKOFF_BASE_S = 60;
const BACKOFF_MAX_S = 6 * 3600;
const REAUTH_PAUSE_S = 3600;

export interface Outcome {
  status: "done" | "skipped";
  detail: string;
}

/** Everything one company's jobs share within a pass. */
export class SyncContext {
  private sessionPromise: Promise<ProviderSession> | null = null;
  readonly provider: AccountingProvider;
  readonly settings: AccountingSettings;
  readonly timeZone: string;
  /** The org's platform brand name, for memos and the generic vendor ("CrankLeads" for a CrankLeads org). */
  readonly productName: string;

  constructor(
    readonly admin: Admin,
    readonly conn: Connection,
    timeZone: string,
    private readonly f: typeof fetch,
    productName: string = DEFAULT_PRODUCT_NAME,
  ) {
    this.provider = providerFor(conn.provider);
    this.settings = parseSettings(conn.settings);
    this.timeZone = timeZone;
    this.productName = productName;
  }

  session(): Promise<ProviderSession> {
    this.sessionPromise ??= sessionFor(this.admin, this.conn, this.f);
    return this.sessionPromise;
  }

  private base() {
    return { company_id: this.conn.company_id, provider: this.conn.provider, remote_tenant_id: this.conn.remote_tenant_id };
  }

  async link(type: LinkType, key: string): Promise<Tables<"accounting_links"> | null> {
    const { data, error } = await this.admin
      .from("accounting_links")
      .select("*")
      .eq("company_id", this.conn.company_id)
      .eq("provider", this.conn.provider)
      .eq("remote_tenant_id", this.conn.remote_tenant_id)
      .eq("entity_type", type)
      .eq("local_key", key)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async saveLink(type: LinkType, key: string, remote: RemoteRef, extra: { hash?: string | null; note?: string | null; attached?: string | null } = {}): Promise<void> {
    const row = {
      ...this.base(),
      organization_id: this.conn.organization_id,
      entity_type: type,
      local_key: key,
      remote_id: remote.id,
      remote_version: remote.version,
      payload_hash: extra.hash ?? null,
      note: extra.note ?? null,
      ...(extra.attached !== undefined ? { attached_receipt_path: extra.attached } : {}),
      synced_at: new Date().toISOString(),
    };
    const { error } = await this.admin.from("accounting_links").upsert(row, { onConflict: "company_id,provider,remote_tenant_id,entity_type,local_key" });
    if (error) throw error;
  }

  async dropLink(type: LinkType, key: string): Promise<void> {
    const b = this.base();
    const { error } = await this.admin
      .from("accounting_links")
      .delete()
      .eq("company_id", b.company_id)
      .eq("provider", b.provider)
      .eq("remote_tenant_id", b.remote_tenant_id)
      .eq("entity_type", type)
      .eq("local_key", key);
    if (error) throw error;
  }

  async takenRemoteIds(type: LinkType): Promise<Set<string>> {
    const b = this.base();
    const { data, error } = await this.admin
      .from("accounting_links")
      .select("remote_id")
      .eq("company_id", b.company_id)
      .eq("provider", b.provider)
      .eq("remote_tenant_id", b.remote_tenant_id)
      .eq("entity_type", type)
      .limit(10000);
    if (error) throw error;
    return new Set((data ?? []).map((r) => r.remote_id));
  }

  enqueue(type: "invoice" | "payment" | "expense", id: string): Promise<unknown> {
    return Promise.resolve(this.admin.rpc("enqueue_accounting_sync", { p_company_id: this.conn.company_id, p_entity_type: type, p_entity_id: id }));
  }

  get startDate(): string {
    return this.conn.sync_start_date;
  }
}

class NeedsSetup extends Error {}

function assertReady(ctx: SyncContext, side: "invoices" | "expenses"): void {
  const missing = missingSettings(ctx.settings, ctx.provider.id)[side];
  if (missing.length) throw new NeedsSetup(`Finish the account mapping in Settings → Accounting first: ${missing.join(", ")}.`);
}

// ── Customers / vendors ──────────────────────────────────────────────────────

async function ensureCustomer(ctx: SyncContext, inv: Tables<"invoices">): Promise<RemoteRef> {
  const doc = customerDoc(inv);
  const existing = await ctx.link("customer", doc.key);
  if (existing) return { id: existing.remote_id, version: existing.remote_version };
  const remote = await ctx.provider.findOrCreateCustomer(await ctx.session(), doc, await ctx.takenRemoteIds("customer"));
  await ctx.saveLink("customer", doc.key, remote);
  return remote;
}

/** Xero needs a contact on every spend: "Expenses (CrankLeads)" / "Expenses (EmpireVu)". */
function genericVendor(productName: string): string {
  return `Expenses (${productName})`;
}

async function ensureVendor(ctx: SyncContext, name: string | null): Promise<RemoteRef | null> {
  // QuickBooks expenses don't need a vendor; Xero needs a contact on every spend.
  const vendorName = name ?? (ctx.provider.id === "xero" ? genericVendor(ctx.productName) : null);
  if (!vendorName) return null;
  const key = vendorName.trim().toLowerCase();
  const existing = await ctx.link("vendor", key);
  if (existing) return { id: existing.remote_id, version: existing.remote_version };
  const remote = await ctx.provider.findOrCreateVendor(await ctx.session(), vendorName);
  if (remote) await ctx.saveLink("vendor", key, remote);
  return remote;
}

// ── Invoices ─────────────────────────────────────────────────────────────────

async function loadInvoice(ctx: SyncContext, id: string): Promise<Tables<"invoices"> | null> {
  const { data, error } = await ctx.admin
    .from("invoices")
    .select("*")
    .eq("id", id)
    .eq("organization_id", ctx.conn.organization_id)
    .eq("company_id", ctx.conn.company_id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export async function syncInvoice(ctx: SyncContext, invoiceId: string): Promise<Outcome> {
  const inv = await loadInvoice(ctx, invoiceId);
  if (!inv) return { status: "skipped", detail: "The invoice no longer exists." };
  if (!ctx.settings.syncInvoices) return { status: "skipped", detail: "Invoice sync is turned off." };
  if (inv.status === "draft") return { status: "skipped", detail: "Drafts aren't synced." };
  const link = await ctx.link("invoice", inv.id);
  const issueDate = inv.issue_date ?? (inv.sent_at ?? inv.created_at).slice(0, 10);
  if (!link && issueDate < ctx.startDate) return { status: "skipped", detail: `Issued before the sync start date (${ctx.startDate}).` };

  if (inv.status === "void") {
    if (!link) return { status: "skipped", detail: "Voided before it was synced." };
    await ctx.provider.voidInvoice(await ctx.session(), { id: link.remote_id, version: link.remote_version });
    await ctx.saveLink("invoice", inv.id, { id: link.remote_id, version: link.remote_version }, { hash: "void", note: "Voided" });
    return { status: "done", detail: `Voided ${inv.invoice_number ?? "invoice"}.` };
  }
  assertReady(ctx, "invoices");

  // Which kind of deposit is in credit_cents (see mapping.ts).
  let depositInvoiceNumber: string | null = null;
  let depositAsLine = false;
  let quoteDepositPaidAt: string | null = null;
  if (inv.credit_cents > 0) {
    if (inv.booking_id) {
      const { data: b } = await ctx.admin.from("bookings").select("deposit_invoice_id").eq("id", inv.booking_id).eq("organization_id", inv.organization_id).maybeSingle();
      if (b?.deposit_invoice_id) {
        depositAsLine = true;
        const { data: d } = await ctx.admin.from("invoices").select("invoice_number").eq("id", b.deposit_invoice_id).eq("organization_id", inv.organization_id).maybeSingle();
        depositInvoiceNumber = d?.invoice_number ?? null;
      }
    }
    if (!depositAsLine && inv.quote_id) {
      const { data: qt } = await ctx.admin.from("quotes").select("deposit_paid_at").eq("id", inv.quote_id).eq("organization_id", inv.organization_id).maybeSingle();
      quoteDepositPaidAt = qt?.deposit_paid_at ?? null;
    }
  }

  const doc = invoiceDoc(inv, { timeZone: ctx.timeZone, depositAsLine, depositInvoiceNumber, productName: ctx.productName });
  const customer = await ensureCustomer(ctx, inv);
  const s = ctx.settings;
  const hash = docHash(doc, customer.id, s.incomeTarget?.id, s.salesTaxCode?.id, s.salesExemptCode?.id, s.country);
  let detail = `Up to date (${inv.invoice_number ?? "invoice"}).`;
  if (!link || link.payload_hash !== hash) {
    const res = await ctx.provider.pushInvoice(await ctx.session(), doc, customer, s, link ? { id: link.remote_id, version: link.remote_version } : null);
    const note = res.totalCents !== null && res.totalCents !== doc.totalCents ? `Total in the file is ${money(res.totalCents)}; ${ctx.productName} has ${money(doc.totalCents)} — check the tax code on this invoice.` : null;
    await ctx.saveLink("invoice", inv.id, res, { hash, note });
    detail = `${link ? "Updated" : "Created"} ${inv.invoice_number ?? "invoice"}${note ? ` — ${note}` : "."}`;
  }

  // A quote deposit taken before the invoice: book it as a payment on it.
  if (inv.credit_cents > 0 && !depositAsLine) {
    const invLink = await ctx.link("invoice", inv.id);
    if (invLink) {
      const pdoc = depositPaymentDoc(inv, quoteDepositPaidAt, ctx.timeZone, ctx.productName);
      const dlink = await ctx.link("deposit", pdoc.localKey);
      const phash = docHash(pdoc, invLink.remote_id, s.paymentAccount?.id);
      if (!dlink || dlink.payload_hash !== phash) {
        const res = await ctx.provider.pushPayment(await ctx.session(), pdoc, { id: invLink.remote_id, version: invLink.remote_version }, customer, s, dlink ? { id: dlink.remote_id, version: dlink.remote_version } : null);
        await ctx.saveLink("deposit", pdoc.localKey, res, { hash: phash });
      }
    }
  }

  // Payments that arrived before the invoice reached the file (or failed waiting on it).
  const { data: pays } = await ctx.admin.from("invoice_payments").select("id").eq("invoice_id", inv.id).eq("organization_id", inv.organization_id).eq("status", "succeeded");
  for (const p of pays ?? []) if (!(await ctx.link("payment", p.id))) await ctx.enqueue("payment", p.id);
  return { status: "done", detail };
}

// ── Payments ─────────────────────────────────────────────────────────────────

export async function syncPayment(ctx: SyncContext, paymentId: string): Promise<Outcome> {
  const { data: p, error } = await ctx.admin
    .from("invoice_payments")
    .select("*")
    .eq("id", paymentId)
    .eq("organization_id", ctx.conn.organization_id)
    .eq("company_id", ctx.conn.company_id)
    .maybeSingle();
  if (error) throw error;
  const link = await ctx.link("payment", paymentId);
  if (!p || p.status !== "succeeded") {
    if (!link) return { status: "skipped", detail: p ? `Payment is ${p.status}; nothing to sync.` : "The payment no longer exists." };
    await ctx.provider.deletePayment(await ctx.session(), { id: link.remote_id, version: link.remote_version });
    await ctx.dropLink("payment", paymentId);
    return { status: "done", detail: p?.status === "refunded" ? "Refunded — removed from the file." : "Removed — deleted from the file." };
  }
  if (!ctx.settings.syncInvoices) return { status: "skipped", detail: "Invoice sync is turned off." };

  let invLink = await ctx.link("invoice", p.invoice_id);
  if (!invLink) {
    // Dependency: put the invoice in first.
    const r = await syncInvoice(ctx, p.invoice_id);
    invLink = await ctx.link("invoice", p.invoice_id);
    if (!invLink) return { status: "skipped", detail: `Its invoice isn't synced: ${r.detail}` };
  }
  assertReady(ctx, "invoices");
  const inv = await loadInvoice(ctx, p.invoice_id);
  if (!inv) return { status: "skipped", detail: "Its invoice no longer exists." };
  const customer = await ensureCustomer(ctx, inv);
  const doc = paymentDoc(p, ctx.timeZone, ctx.productName);
  const hash = docHash(doc, invLink.remote_id, ctx.settings.paymentAccount?.id);
  if (link && link.payload_hash === hash) return { status: "done", detail: "Up to date." };
  const res = await ctx.provider.pushPayment(
    await ctx.session(),
    doc,
    { id: invLink.remote_id, version: invLink.remote_version },
    customer,
    ctx.settings,
    link ? { id: link.remote_id, version: link.remote_version } : null,
  );
  await ctx.saveLink("payment", paymentId, res, { hash });
  return { status: "done", detail: `${link ? "Updated" : "Recorded"} ${money(p.amount_cents)} on ${inv.invoice_number ?? "the invoice"}.` };
}

// ── Expenses ─────────────────────────────────────────────────────────────────

export async function syncExpense(ctx: SyncContext, expenseId: string): Promise<Outcome> {
  const { data: e, error } = await ctx.admin.from("expenses").select("*").eq("id", expenseId).eq("organization_id", ctx.conn.organization_id).maybeSingle();
  if (error) throw error;
  const link = await ctx.link("expense", expenseId);
  // Deleted, or moved to another company → remove it from this file.
  if (!e || e.company_id !== ctx.conn.company_id) {
    if (!link) return { status: "skipped", detail: "Nothing to remove." };
    await ctx.provider.deleteExpense(await ctx.session(), { id: link.remote_id, version: link.remote_version });
    await ctx.dropLink("expense", expenseId);
    return { status: "done", detail: "Deleted from the file." };
  }
  if (!ctx.settings.syncExpenses) return { status: "skipped", detail: "Expense sync is turned off." };
  if (!link && e.spent_on < ctx.startDate) return { status: "skipped", detail: `Dated before the sync start date (${ctx.startDate}).` };
  assertReady(ctx, "expenses");

  const doc = expenseDoc(e, ctx.productName);
  const vendor = await ensureVendor(ctx, doc.vendorName);
  const s = ctx.settings;
  const account = s.expenseAccounts[e.category as keyof AccountingSettings["expenseAccounts"]] ?? s.expenseFallbackAccount;
  const hash = docHash(doc, vendor?.id ?? null, account?.id, s.paidFromBusiness?.id, s.paidFromPersonal?.id, s.purchaseTaxCode?.id, s.purchaseExemptCode?.id, s.country);
  let remote: RemoteRef = link ? { id: link.remote_id, version: link.remote_version } : { id: "", version: null };
  let detail = "Up to date.";
  if (!link || link.payload_hash !== hash) {
    const res = await ctx.provider.pushExpense(await ctx.session(), doc, vendor, s, link ? remote : null);
    remote = res;
    // A new remote record has no receipt yet.
    await ctx.saveLink("expense", expenseId, res, { hash, attached: link && link.remote_id === res.id ? link.attached_receipt_path : null });
    detail = `${link ? "Updated" : "Created"} ${money(e.amount_cents)}${doc.vendorName ? ` at ${doc.vendorName}` : ""}.`;
  }

  // The receipt, once per file. Never fails the expense itself.
  const current = await ctx.link("expense", expenseId);
  if (e.receipt_path && current && current.attached_receipt_path !== e.receipt_path) {
    try {
      const file = await downloadReceipt(e.organization_id, e.receipt_path);
      const ext = file.type === "application/pdf" ? "pdf" : "jpg";
      await ctx.provider.attachReceipt(await ctx.session(), remote, { bytes: file.bytes, contentType: file.type, fileName: `receipt-${e.spent_on}.${ext}` });
      await ctx.saveLink("expense", expenseId, remote, { hash: current.payload_hash, note: null, attached: e.receipt_path });
      detail += " Receipt attached.";
    } catch (err) {
      if (err instanceof ProviderError && (err.retryable || err.reauth)) throw err;
      const msg = err instanceof Error ? err.message : "unknown error";
      await ctx.saveLink("expense", expenseId, remote, { hash: current.payload_hash, note: `Receipt not attached: ${msg}`.slice(0, 300), attached: current.attached_receipt_path });
      detail += ` Receipt not attached (${msg}).`;
    }
  }
  return { status: "done", detail };
}

// ── The pass ─────────────────────────────────────────────────────────────────

export function backoffSeconds(attempts: number, retryAfter?: number): number {
  const exp = Math.min(BACKOFF_MAX_S, BACKOFF_BASE_S * 2 ** Math.max(0, attempts - 1));
  return Math.max(exp, retryAfter ?? 0);
}

async function finish(admin: Admin, job: Job, patch: Partial<Job>): Promise<void> {
  const { error } = await admin.from("accounting_sync_jobs").update(patch).eq("id", job.id).eq("status", "running");
  if (!error) return;
  // Going back to pending while a newer change already queued the same record: that
  // newer job will push the latest state, so this one can stand down.
  if (patch.status === "pending" && (error as { code?: string }).code === "23505") {
    await admin
      .from("accounting_sync_jobs")
      .update({ status: "skipped", detail: "Superseded by a newer change.", last_error: patch.last_error ?? null, locked_at: null, done_at: new Date().toISOString() })
      .eq("id", job.id);
    return;
  }
  console.error("[accounting] could not update job", job.id, error.message);
}

async function contextFor(admin: Admin, companyId: string, f: typeof fetch): Promise<SyncContext | null> {
  const { data: conn } = await admin.from("accounting_connections").select("*").eq("company_id", companyId).maybeSingle();
  if (!conn || conn.status !== "active") return null;
  const { data: company } = await admin.from("companies").select("timezone").eq("id", companyId).eq("organization_id", conn.organization_id).maybeSingle();
  const brand = await loadOrganizationBrand(admin, conn.organization_id);
  return new SyncContext(admin, conn, reviewTimeZone(company), f, brand.name);
}

export async function runJob(ctx: SyncContext, job: Job): Promise<Outcome> {
  if (job.entity_type === "invoice") return syncInvoice(ctx, job.entity_id);
  if (job.entity_type === "payment") return syncPayment(ctx, job.entity_id);
  return syncExpense(ctx, job.entity_id);
}

export interface PassResult {
  claimed: number;
  done: number;
  skipped: number;
  retrying: number;
  failed: number;
}

/** Claim and push due jobs. Never throws for one bad job; a dead sign-in pauses only its company. */
export async function processAccountingJobs(opts: { limit?: number; admin?: Admin; fetch?: typeof fetch; now?: Date } = {}): Promise<PassResult> {
  const admin = opts.admin ?? createSupabaseAdminClient();
  const f = opts.fetch ?? fetch;
  const { data: jobs, error } = await admin.rpc("claim_accounting_sync_jobs", { p_limit: opts.limit ?? 25, p_stale_after_seconds: 600 });
  if (error) throw error;
  const result: PassResult = { claimed: jobs?.length ?? 0, done: 0, skipped: 0, retrying: 0, failed: 0 };
  const contexts = new Map<string, SyncContext | null>();
  const paused = new Set<string>();

  for (const job of jobs ?? []) {
    const nowIso = () => new Date().toISOString();
    if (paused.has(job.company_id)) {
      await finish(admin, job, { status: "pending", attempts: Math.max(0, job.attempts - 1), locked_at: null, available_at: new Date(Date.now() + REAUTH_PAUSE_S * 1000).toISOString() });
      result.retrying++;
      continue;
    }
    if (!contexts.has(job.company_id)) contexts.set(job.company_id, await contextFor(admin, job.company_id, f));
    const ctx = contexts.get(job.company_id);
    if (!ctx) {
      await finish(admin, job, { status: "skipped", detail: "The company isn't connected any more.", locked_at: null, done_at: nowIso() });
      result.skipped++;
      continue;
    }
    try {
      const out = await runJob(ctx, job);
      await finish(admin, job, { status: out.status, detail: out.detail.slice(0, 500), last_error: null, locked_at: null, done_at: nowIso() });
      if (out.status === "done") {
        result.done++;
        await admin.from("accounting_connections").update({ last_sync_at: nowIso(), last_error: null }).eq("company_id", job.company_id);
      } else result.skipped++;
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      if (err instanceof ProviderError && err.reauth) {
        // Pause this company: its jobs wait until someone reconnects (reconnecting re-queues them).
        paused.add(job.company_id);
        await admin.from("accounting_connections").update({ status: "needs_reauth", last_error: message }).eq("company_id", job.company_id);
        await finish(admin, job, { status: "pending", attempts: Math.max(0, job.attempts - 1), last_error: message, locked_at: null, available_at: new Date(Date.now() + REAUTH_PAUSE_S * 1000).toISOString() });
        result.retrying++;
        continue;
      }
      const retryable = !(err instanceof NeedsSetup) && (!(err instanceof ProviderError) || err.retryable);
      if (retryable && job.attempts < job.max_attempts) {
        const wait = backoffSeconds(job.attempts, err instanceof ProviderError ? err.opts.retryAfterSeconds : undefined);
        await finish(admin, job, { status: "pending", last_error: message, locked_at: null, available_at: new Date(Date.now() + wait * 1000).toISOString() });
        result.retrying++;
      } else {
        await finish(admin, job, { status: "failed", last_error: message, locked_at: null, done_at: nowIso() });
        await admin.from("accounting_connections").update({ last_error: message }).eq("company_id", job.company_id);
        result.failed++;
      }
      if (!(err instanceof ProviderError) && !(err instanceof NeedsSetup)) console.error("[accounting] job failed", job.id, message);
    }
  }
  return result;
}
