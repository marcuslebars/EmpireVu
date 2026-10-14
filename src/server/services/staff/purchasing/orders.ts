/**
 * Purchase orders (docs/ai-staff.md → "Purchasing"): drafting one for a job, the owner's
 * `materials_order` approval, and what Y does — email the supplier (reply-to = the owner), or,
 * with no supplier email, text the owner the list to call in.
 *
 * Costing: this module NEVER writes job_materials or expenses. The PO's estimate lives on the PO;
 * real costs arrive as receipts (expenses on the job), so job costing counts nothing twice.
 */
import { replyInstruction } from "@/server/services/front-desk/approval-text";
import { insertApproval } from "@/server/services/front-desk/approvals";
import type { AdminClient, ApprovalDecision, ExecuteResult, OwnerApprovalRow } from "@/server/services/front-desk/contracts";
import { ctxFor, sendOwnerSms } from "@/server/services/owner-channel/common";
import { notifyOwnerOfApproval } from "@/server/services/owner-channel/notify";
import { loadCompanyFromAddress } from "@/server/outbound/company-sender";
import { sendEmail, type SendEmailInput } from "@/server/outbound/email";
import { addDays, localDate } from "@/server/services/booking-windows";
import { orgOwnerEmail } from "@/server/services/workflow-engine/messaging";
import { defaultPurchasingModel, estimateMaterials, type PurchasingModel } from "./ai";
import type { Db, Fulfilment, PoLine, PurchaseOrderRow, SupplierRow } from "./db-types";
import { buildOrderSummary, callInText, dayLabel, estTotalCents, exampleItem, jobLabel, lineText, parseOrderNote, renderSupplierEmail, supplierLabel } from "./format";
import { expandRecipes, loadQuoteForMaterials, loadRecipes } from "./lines";
import type { PurchasingCompany } from "./settings";
import { loadPurchasingCompany } from "./settings";

export const MATERIALS_ORDER_KIND = "materials_order";
const MAX_TTL_MS = 48 * 3_600_000;
/** AI estimates above this lose their prices (and say "check it"). */
export const MAX_AI_TOTAL_CENTS = 10_000_000;
/** A draft PO that never got its question (a crash between the two) is cleared after this. */
export const ORPHAN_DRAFT_MS = 5 * 60_000;

/** The job already has an open order (the partial unique index on purchase_orders.booking_id). */
export class AlreadyOrderedError extends Error {
  constructor(readonly poNumber: string | null) {
    super(`The job already has ${poNumber ?? "an open order"}.`);
  }
}
const HOUR = 3_600_000;

export interface PurchasingDeps {
  model: PurchasingModel;
  sendEmail(input: SendEmailInput): Promise<{ id: string | null }>;
  notify(admin: AdminClient, approvalId: string, nowMs: number): Promise<{ notified: boolean }>;
  textOwner(admin: AdminClient, company: PurchasingCompany, body: string): Promise<{ status: string }>;
}

export const defaultPurchasingDeps: PurchasingDeps = {
  model: defaultPurchasingModel,
  sendEmail: (input) => sendEmail(input),
  notify: (admin, id, nowMs) => notifyOwnerOfApproval(admin, id, { nowMs }),
  textOwner: async (admin, company, body) => {
    if (!company.ownerPhone) return { status: "skipped" };
    return sendOwnerSms(admin, { to: company.ownerPhone, body, organizationId: company.organizationId, companyId: company.companyId, platformBrand: company.platformBrand });
  },
};

// ── The job ────────────────────────────────────────────────────────────────────

export interface JobInfo {
  bookingId: string;
  title: string;
  description: string | null;
  location: string | null;
  scheduledFor: string;
  status: string;
  quoteId: string | null;
  firstName: string | null;
  lastName: string | null;
}

export function jobName(job: Pick<JobInfo, "firstName" | "lastName" | "title">): string {
  return jobLabel({ firstName: job.firstName, lastName: job.lastName, title: job.title });
}

interface BookingRow {
  id: string;
  company_id: string;
  title: string;
  description: string | null;
  location: string | null;
  scheduled_for: string;
  status: string;
  quote_id: string | null;
  contact_id: string | null;
}

export const BOOKING_COLUMNS = "id, company_id, title, description, location, scheduled_for, status, quote_id, contact_id";

/** Bookings → jobs with the customer's name (one contacts read). */
export async function toJobs(admin: AdminClient, organizationId: string, rows: BookingRow[]): Promise<JobInfo[]> {
  const contactIds = [...new Set(rows.map((r) => r.contact_id).filter((id): id is string => Boolean(id)))];
  const names = new Map<string, { first_name: string | null; last_name: string | null }>();
  for (let i = 0; i < contactIds.length; i += 200) {
    const { data } = await (admin as Db).from("contacts").select("id, first_name, last_name").eq("organization_id", organizationId).in("id", contactIds.slice(i, i + 200));
    for (const c of (data ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>) names.set(c.id, c);
  }
  return rows.map((r) => {
    const contact = r.contact_id ? names.get(r.contact_id) : undefined;
    return {
      bookingId: r.id,
      title: r.title,
      description: r.description,
      location: r.location,
      scheduledFor: r.scheduled_for,
      status: r.status,
      quoteId: r.quote_id,
      firstName: contact?.first_name ?? null,
      lastName: contact?.last_name ?? null,
    };
  });
}

export async function loadJob(admin: AdminClient, company: PurchasingCompany, bookingId: string): Promise<JobInfo | null> {
  const { data, error } = await (admin as Db)
    .from("bookings")
    .select(BOOKING_COLUMNS)
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .eq("id", bookingId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return (await toJobs(admin, company.organizationId, [data as BookingRow]))[0] ?? null;
}

/** "Thu Oct 15" — the job's local day. */
export function jobDay(job: Pick<JobInfo, "scheduledFor">, timeZone: string): string {
  return dayLabel(localDate(new Date(job.scheduledFor), timeZone));
}

/** Materials are needed the local day before the job (never before today). PURE. */
export function neededByFor(scheduledFor: string, timeZone: string, nowMs: number): string {
  const jobDate = localDate(new Date(scheduledFor), timeZone);
  const today = localDate(new Date(nowMs), timeZone);
  const before = addDays(jobDate, -1);
  return before < today ? (jobDate < today ? today : jobDate) : before;
}

// ── Suppliers ──────────────────────────────────────────────────────────────────

export async function loadSuppliers(admin: AdminClient, scope: { organizationId: string; companyId: string }, includeInactive = false): Promise<SupplierRow[]> {
  let q = (admin as Db).from("suppliers").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId);
  if (!includeInactive) q = q.eq("active", true);
  const { data, error } = await q.order("created_at", { ascending: true }).limit(200);
  if (error) throw error;
  return (data ?? []) as SupplierRow[];
}

/** The supplier for an order: the one the recipe lines name most, else the preferred one, else the only one. PURE. */
export function pickSupplier(suppliers: SupplierRow[], lineSupplierIds: Array<string | null>): SupplierRow | null {
  const counts = new Map<string, number>();
  for (const id of lineSupplierIds) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  const named = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => suppliers.find((s) => s.id === id)).find(Boolean);
  if (named) return named;
  return suppliers.find((s) => s.preferred) ?? (suppliers.length === 1 ? suppliers[0] : null);
}

// ── Building the list ──────────────────────────────────────────────────────────

export interface DraftLines {
  lines: PoLine[];
  supplierIds: Array<string | null>;
  basis: "recipe" | "ai" | "mixed";
}

function tradeOf(pack: unknown): string | null {
  const p = pack && typeof pack === "object" ? (pack as Record<string, unknown>) : {};
  return typeof p.id === "string" ? p.id.replace(/[-_]/g, " ") : null;
}

/**
 * Recipe lines × quote quantities first; what no recipe covers goes to the AI estimate (when on).
 * Returns null when there's nothing to buy.
 */
export async function buildLines(admin: AdminClient, company: PurchasingCompany, job: JobInfo, deps: PurchasingDeps): Promise<DraftLines | null> {
  const scope = { organizationId: company.organizationId, companyId: company.companyId };
  const quote = job.quoteId ? await loadQuoteForMaterials(admin, scope, job.quoteId) : null;
  // A job booked from a quote we can't read (gone, another company's): don't guess.
  if (job.quoteId && !quote) return null;
  const services = quote?.services ?? [];
  const recipes = await loadRecipes(admin, scope, services.map((s) => s.catalogItemId).filter((id): id is string => Boolean(id)));
  const expanded = expandRecipes(services, recipes);
  const leftover = [
    ...expanded.uncovered.map((s) => ({ label: s.label, description: null, units: s.units })),
    ...(quote?.uncovered ?? []).map((u) => ({ label: u.label, description: u.description, units: u.quantity })),
  ];
  let aiLines: PoLine[] = [];
  const needsAi = company.settings.aiEstimate && (leftover.length > 0 || (!quote && expanded.lines.length === 0));
  if (needsAi) {
    aiLines =
      (await estimateMaterials(
        {
          organizationId: company.organizationId,
          companyId: company.companyId,
          businessName: company.name,
          trade: tradeOf(company.industryPack),
          serviceArea: company.serviceArea,
          jobTitle: quote?.title ?? job.title,
          jobDescription: job.description,
          work: leftover,
        },
        deps.model,
      )) ?? [];
  }
  // An AI estimate over $100k is not a list anyone should order from: keep the lines, drop its prices.
  if (aiLines.length && aiLines.reduce((sum, l) => sum + Math.round(l.qty * (l.estUnitCostCents ?? 0)), 0) > MAX_AI_TOTAL_CENTS) {
    aiLines = aiLines.map((l) => ({ ...l, estUnitCostCents: null, capped: true }));
  }
  const lines = [...expanded.lines, ...aiLines];
  if (lines.length === 0) return null;
  return {
    lines,
    supplierIds: [...expanded.supplierIds, ...aiLines.map(() => null)],
    basis: expanded.lines.length && aiLines.length ? "mixed" : aiLines.length ? "ai" : "recipe",
  };
}

// ── PO rows ────────────────────────────────────────────────────────────────────

async function insertPurchaseOrder(admin: AdminClient, row: Omit<PurchaseOrderRow, "id" | "po_seq" | "po_number" | "updated_at" | "sent_at" | "sent_via" | "sent_to" | "send_error" | "reminder_sent_at" | "status_changed_at" | "cancel_reason" | "notes" | "job_change_notice">): Promise<PurchaseOrderRow> {
  const db = admin as Db;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data: top, error: topErr } = await db.from("purchase_orders").select("po_seq").eq("company_id", row.company_id).order("po_seq", { ascending: false }).limit(1);
    if (topErr) throw topErr;
    const seq = (((top ?? []) as Array<{ po_seq: number }>)[0]?.po_seq ?? 0) + 1 + attempt;
    const { data, error } = await db
      .from("purchase_orders")
      .insert({ ...row, po_seq: seq, po_number: `PO-${seq}` })
      .select("*")
      .single();
    if (!error) return data as PurchaseOrderRow;
    lastError = error;
    if ((error as { code?: string }).code === "23505" && row.booking_id) {
      const open = await openOrderFor(admin, row.company_id, row.booking_id);
      if (open) throw new AlreadyOrderedError(open.po_number);
    }
    if ((error as { code?: string }).code !== "23505") throw error;
  }
  throw lastError ?? new Error("Could not number the purchase order.");
}

/** The job's open (not cancelled) order, if any. */
export async function openOrderFor(admin: AdminClient, companyId: string, bookingId: string): Promise<Pick<PurchaseOrderRow, "id" | "po_number" | "status" | "approval_id" | "created_at"> | null> {
  const { data, error } = await (admin as Db).from("purchase_orders").select("id, po_number, status, approval_id, created_at").eq("company_id", companyId).eq("booking_id", bookingId);
  if (error) throw error;
  return ((data ?? []) as Array<Pick<PurchaseOrderRow, "id" | "po_number" | "status" | "approval_id" | "created_at">>).find((p) => p.status !== "cancelled") ?? null;
}

/**
 * Cancel draft orders that never got their question (a worker died between the two inserts),
 * and withdraw any question that was never linked to them. Older than ORPHAN_DRAFT_MS only.
 */
export async function clearOrphanDrafts(admin: AdminClient, companyId: string, nowMs: number): Promise<number> {
  const db = admin as Db;
  const cutoff = new Date(nowMs - ORPHAN_DRAFT_MS).toISOString();
  const { data, error } = await db.from("purchase_orders").select("id, created_at").eq("company_id", companyId).eq("status", "draft").is("approval_id", null).lt("created_at", cutoff).limit(100);
  if (error) throw error;
  let cleared = 0;
  for (const po of (data ?? []) as Array<{ id: string }>) {
    const { data: hit } = await db
      .from("purchase_orders")
      .update({ status: "cancelled", cancel_reason: "orphan", status_changed_at: new Date(nowMs).toISOString() })
      .eq("id", po.id)
      .eq("status", "draft")
      .is("approval_id", null)
      .select("id");
    if (((hit ?? []) as unknown[]).length === 0) continue;
    cleared += 1;
    await db.from("owner_approvals").update({ status: "superseded" }).eq("company_id", companyId).eq("kind", MATERIALS_ORDER_KIND).eq("status", "pending").eq("payload->>poId", po.id);
  }
  return cleared;
}

export async function loadPurchaseOrder(admin: AdminClient, scope: { organizationId: string; companyId: string }, id: string): Promise<PurchaseOrderRow | null> {
  const { data, error } = await (admin as Db).from("purchase_orders").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as PurchaseOrderRow | null) ?? null;
}

// ── The approval ───────────────────────────────────────────────────────────────

export interface OrderView {
  summary: string;
  payload: Record<string, unknown>;
}

/** The owner's question for a PO as it stands (summary + payload). PURE. */
export function orderView(company: PurchasingCompany, job: JobInfo, po: Pick<PurchaseOrderRow, "id" | "po_number" | "lines" | "fulfilment" | "needed_by" | "basis">, supplier: SupplierRow | null): OrderView {
  const summary = buildOrderSummary({
    job: jobName(job),
    jobDay: jobDay(job, company.timeZone),
    poNumber: po.po_number,
    lines: po.lines,
    estTotalCents: estTotalCents(po.lines),
    aiEstimate: po.lines.some((l) => l.source === "ai"),
    capped: po.lines.some((l) => l.capped === true),
    supplier: supplierLabel(supplier),
    supplierEmail: supplier?.email ?? null,
    supplierPhone: supplier?.phone ?? null,
    fulfilment: po.fulfilment,
    neededBy: po.needed_by,
  });
  return { summary, payload: { poId: po.id, poNumber: po.po_number, bookingId: job.bookingId, fulfilment: po.fulfilment, exampleItem: exampleItem(po.lines) } };
}

/** The approval's TTL: 48h, but ends 6h before the job starts (never less than 2h). PURE. */
export function approvalExpiry(scheduledFor: string, nowMs: number): Date {
  const start = Date.parse(scheduledFor);
  const cap = Number.isFinite(start) ? start - 6 * HOUR : nowMs + MAX_TTL_MS;
  return new Date(Math.max(nowMs + 2 * HOUR, Math.min(nowMs + MAX_TTL_MS, cap)));
}

async function askOwner(
  admin: AdminClient,
  company: PurchasingCompany,
  job: JobInfo,
  po: PurchaseOrderRow,
  supplier: SupplierRow | null,
  opts: { nowMs: number; askedInlineTo: string | null },
  deps: PurchasingDeps,
): Promise<{ id: string; shortCode: number | null; summary: string; payload: Record<string, unknown> }> {
  const view = orderView(company, job, po, supplier);
  const now = new Date(opts.nowMs);
  const row = await insertApproval(admin, {
    organizationId: company.organizationId,
    companyId: company.companyId,
    contactId: null,
    kind: MATERIALS_ORDER_KIND,
    summary: view.summary,
    payload: view.payload,
    requestedBy: "purchasing",
    createdAt: now,
    expiresAt: approvalExpiry(job.scheduledFor, opts.nowMs),
    // Inserted as already "notified" to nobody, so neither the approvals sweep nor a "Y" can reach it
    // until it's linked to the order below (a crash in between leaves nothing to answer).
    notifiedAt: now,
    notifiedTo: opts.askedInlineTo,
  });
  const { data: linked, error } = await (admin as Db)
    .from("purchase_orders")
    .update({ approval_id: row.id })
    .eq("id", po.id)
    .eq("organization_id", company.organizationId)
    .eq("status", "draft")
    .select("id");
  if (error || ((linked ?? []) as unknown[]).length === 0) {
    // A "Y" must never land on nothing: withdraw the question.
    await admin.from("owner_approvals").update({ status: "superseded" }).eq("id", row.id).eq("status", "pending");
    throw new Error("Could not link the order to its approval.");
  }
  if (!opts.askedInlineTo) {
    await admin.from("owner_approvals").update({ notified_at: null, notified_to: null }).eq("id", row.id).eq("status", "pending");
    try {
      await deps.notify(admin, row.id, opts.nowMs);
    } catch (err) {
      console.error("[purchasing] notify failed:", err instanceof Error ? err.message : err);
    }
  }
  return { id: row.id, shortCode: row.short_code ?? null, summary: view.summary, payload: view.payload };
}

/** "#12 Materials for … Reply Y 12 to order it, …" (the inline question). PURE. */
export function questionText(code: number | null, summary: string, payload: Record<string, unknown>): string {
  return `#${code ?? "?"} ${summary} ${replyInstruction(MATERIALS_ORDER_KIND, code, payload)}`;
}

export type DraftResult =
  | { outcome: "asked"; po: PurchaseOrderRow; approvalId: string; shortCode: number | null; question: string }
  | { outcome: "no_materials" };

/** Draft a PO for one job and ask the owner (materials_order). */
export async function draftForJob(
  admin: AdminClient,
  company: PurchasingCompany,
  job: JobInfo,
  opts: { source: "auto" | "owner"; nowMs: number; askedInlineTo?: string | null },
  deps: PurchasingDeps = defaultPurchasingDeps,
): Promise<DraftResult> {
  const built = await buildLines(admin, company, job, deps);
  if (!built) return { outcome: "no_materials" };
  const suppliers = await loadSuppliers(admin, company);
  const supplier = pickSupplier(suppliers, built.supplierIds);
  const po = await insertPurchaseOrder(admin, {
    organization_id: company.organizationId,
    company_id: company.companyId,
    booking_id: job.bookingId,
    supplier_id: supplier?.id ?? null,
    supplier_name: supplierLabel(supplier),
    status: "draft",
    needed_by: neededByFor(job.scheduledFor, company.timeZone, opts.nowMs),
    fulfilment: company.settings.defaultFulfilment,
    lines: built.lines,
    est_total_cents: estTotalCents(built.lines),
    basis: built.basis,
    source: opts.source,
    approval_id: null,
    job_label: jobName(job),
    job_scheduled_for: job.scheduledFor,
    created_at: new Date(opts.nowMs).toISOString(),
  });
  try {
    const asked = await askOwner(admin, company, job, po, supplier, { nowMs: opts.nowMs, askedInlineTo: opts.askedInlineTo ?? null }, deps);
    return { outcome: "asked", po: { ...po, approval_id: asked.id }, approvalId: asked.id, shortCode: asked.shortCode, question: questionText(asked.shortCode, asked.summary, asked.payload) };
  } catch (err) {
    await (admin as Db).from("purchase_orders").update({ status: "cancelled", cancel_reason: "ask_failed", status_changed_at: new Date(opts.nowMs).toISOString() }).eq("id", po.id).eq("status", "draft");
    throw err;
  }
}

// ── Y / N / expiry ─────────────────────────────────────────────────────────────

function smsDecider(decision: ApprovalDecision): string | null {
  return decision.decidedVia === "sms" && /^\+\d{8,15}$/.test(decision.decidedBy) ? decision.decidedBy : null;
}

/** Where the supplier's reply goes: the business's owner email, else the org owner's / an admin's. */
export async function ownerReplyEmail(admin: AdminClient, company: PurchasingCompany): Promise<string | null> {
  if (company.ownerEmail) return company.ownerEmail;
  try {
    return await orgOwnerEmail(ctxFor(admin, company.organizationId));
  } catch {
    return null;
  }
}

const OPEN_JOB = new Set(["pending", "confirmed"]);

/** The materials_order executor (owner-channel decideApproval → registry → here). Idempotent. */
export async function executeMaterialsOrder(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision, deps: PurchasingDeps = defaultPurchasingDeps): Promise<ExecuteResult> {
  const nowMs = Date.now();
  const scope = { organizationId: approval.organization_id, companyId: approval.company_id };
  const code = approval.short_code ?? "?";
  const poId = typeof approval.payload.poId === "string" ? approval.payload.poId : null;
  const po = poId ? await loadPurchaseOrder(admin, scope, poId) : null;
  if (!po || po.approval_id !== approval.id) return { ok: false, message: `#${code} isn't linked to a materials order any more, so nothing was sent.` };
  const company = await loadPurchasingCompany(admin, scope.organizationId, scope.companyId);
  if (!company) return { ok: false, message: "Business not found - nothing was sent." };
  const job = po.booking_id ? await loadJob(admin, company, po.booking_id) : null;
  const label = job ? `${jobName(job)} (${jobDay(job, company.timeZone)})` : po.po_number;
  const nowIso = new Date(nowMs).toISOString();

  if (!decision.approved) {
    const reason = decision.decidedVia === "expiry" ? "expired" : "owner_said_no";
    await (admin as Db).from("purchase_orders").update({ status: "cancelled", cancel_reason: reason, status_changed_at: nowIso }).eq("id", po.id).eq("approval_id", approval.id).eq("status", "draft");
    return decision.decidedVia === "expiry"
      ? { ok: true, message: `No answer on #${code}, so nothing was ordered for ${label}. Text "order materials for ${job?.lastName ?? job?.firstName ?? "the job"}" to start again.` }
      : { ok: true, message: `OK - nothing ordered for ${label}.` };
  }

  if (po.status !== "draft") return { ok: true, message: `${po.po_number} was already handled (${po.status.replace("_", " ")}).` };
  if (!job || !OPEN_JOB.has(job.status)) {
    await (admin as Db).from("purchase_orders").update({ status: "cancelled", cancel_reason: "job_closed", status_changed_at: nowIso }).eq("id", po.id).eq("approval_id", approval.id).eq("status", "draft");
    return { ok: false, message: `${label} is ${job ? job.status.replace("_", " ") : "gone"}, so nothing was ordered.` };
  }

  const suppliers = await loadSuppliers(admin, company, true);
  const supplier = po.supplier_id ? suppliers.find((s) => s.id === po.supplier_id) ?? null : null;

  // The owner's note: pickup / delivery, leave items out, change an amount. Anything else → ask again.
  let lines = po.lines;
  let fulfilment: Fulfilment = po.fulfilment;
  let changes: string[] = [];
  if (decision.ownerNote?.trim()) {
    const read = parseOrderNote(decision.ownerNote, po.lines, po.fulfilment);
    if ("why" in read) {
      const asked = await askOwner(admin, company, job, po, supplier && supplier.active ? supplier : null, { nowMs, askedInlineTo: smsDecider(decision) }, deps).catch(() => null);
      const how = `I can do "delivery" / "pickup", leave items out ("no nails") or change an amount ("25 bundles shingles").`;
      if (!asked) return { ok: false, message: `Nothing was sent: ${read.why}. ${how}` };
      return {
        ok: false,
        message: smsDecider(decision)
          ? `Nothing was sent: ${read.why}. ${how} ${questionText(asked.shortCode, asked.summary, asked.payload)}`.slice(0, 680)
          : `Nothing was sent: ${read.why}. I asked again as #${asked.shortCode ?? "?"}.`,
        detail: { reasked: asked.id },
      };
    }
    lines = read.lines;
    fulfilment = read.fulfilment;
    changes = read.changes;
  }

  const neededBy = neededByFor(job.scheduledFor, company.timeZone, nowMs);
  const { data: claimed } = await (admin as Db)
    .from("purchase_orders")
    .update({ status: "approved", lines, fulfilment, needed_by: neededBy, est_total_cents: estTotalCents(lines), status_changed_at: nowIso, job_scheduled_for: job.scheduledFor, job_label: jobName(job) })
    .eq("id", po.id)
    .eq("organization_id", company.organizationId)
    .eq("approval_id", approval.id)
    .eq("status", "draft")
    .select("id");
  if (((claimed ?? []) as unknown[]).length === 0) return { ok: true, message: `${po.po_number} was already handled.` };

  const name = supplierLabel(supplier);
  const changed = changes.length ? ` (${changes.join("; ")})` : "";
  const callIn = () =>
    callInText({ poNumber: po.po_number, job: jobName(job), supplier: name, supplierPhone: supplier?.phone ?? null, accountNumber: supplier?.account_number ?? null, fulfilment, neededBy, lines });

  const replyTo = supplier?.email && supplier.active ? await ownerReplyEmail(admin, company) : null;
  if (!supplier || !supplier.active || !supplier.email || !replyTo) {
    await (admin as Db).from("purchase_orders").update({ sent_via: "owner_call_in" }).eq("id", po.id).eq("status", "approved");
    const why = supplier?.active && supplier.email && !replyTo ? "No email on file for you, so the supplier's reply couldn't reach you - " : "";
    return { ok: true, message: `${why}${callIn()}`.slice(0, 680), detail: { poNumber: po.po_number, sentVia: "owner_call_in" } };
  }

  const email = renderSupplierEmail({
    companyName: company.name,
    supplierName: supplier.name,
    poNumber: po.po_number,
    accountNumber: supplier.account_number,
    fulfilment,
    neededBy,
    deliverTo: job.location,
    lines,
  });
  try {
    // D7: the company's own sender when it has one.
    const fromAddress = await loadCompanyFromAddress(admin, company.companyId);
    await deps.sendEmail({ to: supplier.email, subject: email.subject, body: email.text, html: email.html, fromName: company.name, replyTo, ...(fromAddress ? { fromAddress } : {}) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await (admin as Db).from("purchase_orders").update({ send_error: reason.slice(0, 500), sent_via: "owner_call_in" }).eq("id", po.id).eq("status", "approved");
    return { ok: false, message: `Couldn't email ${name}, so please call it in. ${callIn()}`.slice(0, 680) };
  }
  await (admin as Db)
    .from("purchase_orders")
    .update({ status: "sent", sent_at: new Date(Date.now()).toISOString(), sent_via: "email", sent_to: supplier.email, send_error: null, status_changed_at: new Date(Date.now()).toISOString() })
    .eq("id", po.id)
    .eq("status", "approved");
  const when = fulfilment === "pickup" ? `for pickup ${dayLabel(neededBy)}` : `for delivery by ${dayLabel(neededBy)}`;
  return {
    ok: true,
    message: `Emailed ${po.po_number} to ${name} ${when}${changed}. Their reply goes to ${replyTo}. Text "${po.po_number} ready" when it's ready.`,
    detail: { poNumber: po.po_number, sentVia: "email", lines: lines.map(lineText) },
  };
}
