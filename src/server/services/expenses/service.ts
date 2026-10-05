/**
 * Expenses & receipts — the dashboard / app side. Runs under the caller's session: RLS
 * lets crew see and change only their own expenses (until reimbursed or billed), owners
 * and admins everyone's. Receipt files go through ./receipts (server-signed URLs only).
 */
import type { Tables } from "@/server/db/database.types";
import { AuthorizationError, ValidationError } from "@/server/organizations/context";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { receiptExists, removeReceipt, signReceiptUrls } from "./receipts";
import {
  CSV_HEADER,
  billableLine,
  csvRow,
  preTaxCents,
  receiptTypeOfPath,
  summarizeExpenses,
  type ExpenseCreateInput,
  type ExpenseListQuery,
  type ExpenseSummary,
  type ExpenseUpdateInput,
} from "./rules";

type ExpenseRow = Tables<"expenses">;

export class ExpenseNotFoundError extends ValidationError {
  constructor(message = "Expense not found.") {
    super(message);
    this.name = "ExpenseNotFoundError";
  }
}

export function isManager(role: string): boolean {
  return role === "owner" || role === "admin";
}

export interface ExpenseView {
  id: string;
  spentOn: string;
  vendor: string | null;
  description: string | null;
  category: string;
  amountCents: number;
  taxCents: number;
  /** Before tax — what job costing and reports count. */
  costCents: number;
  paidWith: "business" | "personal";
  reimbursedAt: string | null;
  billable: boolean;
  billedInvoiceId: string | null;
  billedInvoiceNumber: string | null;
  bookingId: string | null;
  jobTitle: string | null;
  companyId: string | null;
  receiptUrl: string | null;
  receiptType: string | null;
  createdBy: string | null;
  personName: string | null;
  createdAt: string;
  canEdit: boolean;
}

const PAGE = 1000;
const MAX_ROWS = 5000;

// ── Reads ────────────────────────────────────────────────────────────────────

async function readRows(ctx: TenantServiceContext, query: ExpenseListQuery): Promise<{ rows: ExpenseRow[]; truncated: boolean }> {
  const rows: ExpenseRow[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    let q = ctx.supabase
      .from("expenses")
      .select("*")
      .eq("organization_id", ctx.organizationId)
      .gte("spent_on", query.from)
      .lte("spent_on", query.to);
    if (query.category) q = q.eq("category", query.category);
    if (query.bookingId) q = q.eq("booking_id", query.bookingId);
    if (query.profileId) q = q.eq("created_by", query.profileId);
    if (query.companyId) q = q.eq("company_id", query.companyId);
    if (query.kind === "job") q = q.not("booking_id", "is", null);
    if (query.kind === "overhead") q = q.is("booking_id", null);
    if (query.owed) q = q.eq("paid_with", "personal").is("reimbursed_at", null);
    const { data, error } = await q
      .order("spent_on", { ascending: false })
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return { rows: filterText(rows, query.q), truncated: false };
  }
  return { rows: filterText(rows, query.q), truncated: true };
}

function filterText(rows: ExpenseRow[], q: string | null | undefined): ExpenseRow[] {
  const needle = q?.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => `${r.vendor ?? ""} ${r.description ?? ""}`.toLowerCase().includes(needle));
}

async function toViews(ctx: TenantServiceContext, role: string, rows: ExpenseRow[], withReceipts = true): Promise<ExpenseView[]> {
  if (rows.length === 0) return [];
  const bookingIds = [...new Set(rows.map((r) => r.booking_id).filter((v): v is string => !!v))];
  const people = [...new Set(rows.map((r) => r.created_by).filter((v): v is string => !!v))];
  const invoiceIds = [...new Set(rows.map((r) => r.billed_invoice_id).filter((v): v is string => !!v))];
  const [jobs, profiles, invoices, urls] = await Promise.all([
    bookingIds.length
      ? ctx.supabase.from("bookings").select("id, title").eq("organization_id", ctx.organizationId).in("id", bookingIds)
      : Promise.resolve({ data: [] as Array<{ id: string; title: string }>, error: null }),
    people.length ? ctx.supabase.from("profiles").select("id, full_name, email").in("id", people) : Promise.resolve({ data: [] as Array<{ id: string; full_name: string | null; email: string | null }>, error: null }),
    invoiceIds.length
      ? ctx.supabase.from("invoices").select("id, invoice_number, status").eq("organization_id", ctx.organizationId).in("id", invoiceIds)
      : Promise.resolve({ data: [] as Array<{ id: string; invoice_number: string | null; status: string }>, error: null }),
    withReceipts ? signReceiptUrls(ctx.organizationId, rows.map((r) => r.receipt_path).filter((p): p is string => !!p)) : Promise.resolve(new Map<string, string>()),
  ]);
  for (const r of [jobs, profiles, invoices]) if (r.error) throw r.error;
  const title = new Map((jobs.data ?? []).map((j) => [j.id, j.title]));
  const name = new Map((profiles.data ?? []).map((p) => [p.id, p.full_name?.trim() || p.email || "Team member"]));
  const invoice = new Map((invoices.data ?? []).map((i) => [i.id, i]));
  const manager = isManager(role);
  return rows.map((r) => {
    const inv = r.billed_invoice_id ? invoice.get(r.billed_invoice_id) : undefined;
    // A voided invoice releases the expense to be billed again.
    const billed = inv && inv.status !== "void" ? inv : null;
    return {
      id: r.id,
      spentOn: r.spent_on,
      vendor: r.vendor,
      description: r.description,
      category: r.category,
      amountCents: r.amount_cents,
      taxCents: r.tax_cents,
      costCents: preTaxCents(r),
      paidWith: r.paid_with === "personal" ? "personal" : "business",
      reimbursedAt: r.reimbursed_at,
      billable: r.billable,
      billedInvoiceId: billed?.id ?? null,
      billedInvoiceNumber: billed?.invoice_number ?? null,
      bookingId: r.booking_id,
      jobTitle: r.booking_id ? (title.get(r.booking_id) ?? null) : null,
      companyId: r.company_id,
      receiptUrl: r.receipt_path ? (urls.get(r.receipt_path) ?? null) : null,
      receiptType: r.receipt_type,
      createdBy: r.created_by,
      personName: r.created_by ? (name.get(r.created_by) ?? null) : null,
      createdAt: r.created_at,
      canEdit: manager || (r.created_by === ctx.actorProfileId && !r.reimbursed_at && !r.billed_invoice_id),
    };
  });
}

export interface ExpenseListResult {
  expenses: ExpenseView[];
  summary: ExpenseSummary & { owedNames: Record<string, string> };
  truncated: boolean;
  canManage: boolean;
}

export async function listExpenses(ctx: TenantServiceContext, role: string, query: ExpenseListQuery): Promise<ExpenseListResult> {
  const { rows, truncated } = await readRows(ctx, query);
  const expenses = await toViews(ctx, role, rows);
  const summary = summarizeExpenses(rows);
  const owedNames: Record<string, string> = {};
  for (const e of expenses) if (e.createdBy && e.personName) owedNames[e.createdBy] = e.personName;
  return { expenses, summary: { ...summary, owedNames }, truncated, canManage: isManager(role) };
}

async function requireRow(ctx: TenantServiceContext, id: string): Promise<ExpenseRow> {
  const { data, error } = await ctx.supabase.from("expenses").select("*").eq("organization_id", ctx.organizationId).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new ExpenseNotFoundError();
  return data;
}

export async function getExpense(ctx: TenantServiceContext, role: string, id: string): Promise<ExpenseView> {
  const [view] = await toViews(ctx, role, [await requireRow(ctx, id)]);
  return view;
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** The job's company (an expense on a job is that job's), else the one chosen, else the org's only company. */
async function resolveCompany(ctx: TenantServiceContext, bookingId: string | null, companyId: string | null | undefined): Promise<string | null> {
  if (bookingId) {
    const { data, error } = await ctx.supabase.from("bookings").select("id, company_id").eq("organization_id", ctx.organizationId).eq("id", bookingId).maybeSingle();
    if (error) throw error;
    if (!data) throw new ValidationError("Job not found.");
    return data.company_id;
  }
  if (companyId) {
    await assertCompanyInOrganization(ctx, companyId);
    return companyId;
  }
  const { data, error } = await ctx.supabase.from("companies").select("id").eq("organization_id", ctx.organizationId).limit(2);
  if (error) throw error;
  return data && data.length === 1 ? data[0].id : null;
}

async function checkReceipt(ctx: TenantServiceContext, receipt: { path?: string; type?: string }): Promise<void> {
  const type = receipt.path ? receiptTypeOfPath(ctx.organizationId, receipt.path) : null;
  if (!type || type !== receipt.type) throw new ValidationError("That receipt doesn't belong to this business.");
  if (!(await receiptExists(ctx.organizationId, receipt.path as string))) throw new ValidationError("The receipt didn't finish uploading — try adding it again.");
}

export async function createExpense(ctx: TenantServiceContext, role: string, input: ExpenseCreateInput): Promise<ExpenseView> {
  if (!ctx.actorProfileId) throw new AuthorizationError("Sign in to log an expense.");
  const bookingId = input.bookingId ?? null;
  const companyId = await resolveCompany(ctx, bookingId, input.companyId);
  if (input.receipt) await checkReceipt(ctx, input.receipt);
  const { data, error } = await ctx.supabase
    .from("expenses")
    .insert({
      organization_id: ctx.organizationId,
      company_id: companyId,
      booking_id: bookingId,
      spent_on: input.spentOn,
      vendor: input.vendor || null,
      description: input.description || null,
      category: input.category,
      amount_cents: input.amountCents,
      tax_cents: input.taxCents,
      paid_with: input.paidWith,
      billable: Boolean(bookingId) && input.billable,
      receipt_path: input.receipt?.path ?? null,
      receipt_type: input.receipt?.type ?? null,
      created_by: ctx.actorProfileId,
    })
    .select("*")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") throw new ValidationError("That receipt is already on another expense.");
    throw error;
  }
  const [view] = await toViews(ctx, role, [data]);
  return view;
}

export async function updateExpense(ctx: TenantServiceContext, role: string, id: string, input: ExpenseUpdateInput): Promise<ExpenseView> {
  const existing = await requireRow(ctx, id);
  const manager = isManager(role);
  if (!manager && (existing.created_by !== ctx.actorProfileId || existing.reimbursed_at || existing.billed_invoice_id)) {
    throw new AuthorizationError(
      existing.created_by !== ctx.actorProfileId
        ? "You can only change expenses you logged."
        : "This expense has been paid back or billed, so only an owner or admin can change it.",
    );
  }

  const oldReceipt = existing.receipt_path;
  const bookingId = input.bookingId !== undefined ? (input.bookingId ?? null) : existing.booking_id;
  const companyId =
    input.bookingId !== undefined || input.companyId !== undefined
      ? await resolveCompany(ctx, bookingId, input.companyId !== undefined ? input.companyId : existing.company_id)
      : existing.company_id;
  const amount = input.amountCents ?? existing.amount_cents;
  const tax = input.taxCents ?? existing.tax_cents;
  if (tax > amount) throw new ValidationError("Tax can't be more than the total.");
  const billable = input.billable !== undefined ? input.billable : existing.billable;
  if (billable && !bookingId) {
    if (input.billable) throw new ValidationError("Only an expense on a job can be billed to the customer.");
  }
  const paidWith = input.paidWith ?? existing.paid_with;

  let receiptPath = existing.receipt_path;
  let receiptType = existing.receipt_type;
  if (input.receipt !== undefined) {
    if (input.receipt && input.receipt.path !== existing.receipt_path) await checkReceipt(ctx, input.receipt);
    receiptPath = input.receipt?.path ?? null;
    receiptType = input.receipt?.type ?? null;
  }

  const { data, error } = await ctx.supabase
    .from("expenses")
    .update({
      spent_on: input.spentOn ?? existing.spent_on,
      vendor: input.vendor !== undefined ? input.vendor || null : existing.vendor,
      description: input.description !== undefined ? input.description || null : existing.description,
      category: input.category ?? existing.category,
      amount_cents: amount,
      tax_cents: tax,
      paid_with: paidWith,
      // Switching to "paid by the business" clears a reimbursement — there's nothing to pay back.
      reimbursed_at: paidWith === "personal" ? existing.reimbursed_at : null,
      reimbursed_by: paidWith === "personal" ? existing.reimbursed_by : null,
      billable: Boolean(bookingId) && billable,
      booking_id: bookingId,
      company_id: companyId,
      receipt_path: receiptPath,
      receipt_type: receiptType,
    })
    .eq("organization_id", ctx.organizationId)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) {
    if ((error as { code?: string }).code === "23505") throw new ValidationError("That receipt is already on another expense.");
    throw error;
  }
  if (!data) throw new AuthorizationError("You can't change this expense.");
  if (oldReceipt && oldReceipt !== receiptPath) await removeReceipt(ctx.organizationId, oldReceipt);
  const [view] = await toViews(ctx, role, [data]);
  return view;
}

export async function deleteExpense(ctx: TenantServiceContext, role: string, id: string): Promise<void> {
  const existing = await requireRow(ctx, id);
  if (!isManager(role) && existing.created_by !== ctx.actorProfileId) throw new AuthorizationError("You can only delete expenses you logged.");
  if (!isManager(role) && (existing.reimbursed_at || existing.billed_invoice_id)) {
    throw new AuthorizationError("This expense has been paid back or billed, so only an owner or admin can delete it.");
  }
  const receipt = existing.receipt_path;
  const { data, error } = await ctx.supabase.from("expenses").delete().eq("organization_id", ctx.organizationId).eq("id", id).select("id");
  if (error) throw error;
  if (!data?.length) throw new AuthorizationError("You can't delete this expense.");
  await removeReceipt(ctx.organizationId, receipt);
}

/** Mark out-of-pocket expenses as paid back (or undo it). Owners/admins only. */
export async function setReimbursed(ctx: TenantServiceContext, role: string, ids: string[], reimbursed: boolean, now = new Date()): Promise<number> {
  if (!isManager(role)) throw new AuthorizationError("Only owners and admins can mark expenses as paid back.");
  if (ids.length === 0) return 0;
  let q = ctx.supabase
    .from("expenses")
    .update({ reimbursed_at: reimbursed ? now.toISOString() : null, reimbursed_by: reimbursed ? ctx.actorProfileId : null })
    .eq("organization_id", ctx.organizationId)
    .eq("paid_with", "personal")
    .in("id", ids);
  q = reimbursed ? q.is("reimbursed_at", null) : q.not("reimbursed_at", "is", null);
  const { data, error } = await q.select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

// ── Export ───────────────────────────────────────────────────────────────────

export async function exportExpensesCsv(ctx: TenantServiceContext, role: string, query: ExpenseListQuery): Promise<string> {
  const { rows } = await readRows(ctx, query);
  const views = await toViews(ctx, role, [...rows].reverse(), false);
  const lines = [CSV_HEADER.join(",")];
  for (const e of views) {
    lines.push(
      csvRow({
        spentOn: e.spentOn,
        vendor: e.vendor,
        description: e.description,
        category: e.category,
        amountCents: e.amountCents,
        taxCents: e.taxCents,
        jobTitle: e.jobTitle,
        paidWith: e.paidWith,
        reimbursedAt: e.reimbursedAt,
        billable: e.billable,
        personName: e.personName,
        hasReceipt: Boolean(rows.find((r) => r.id === e.id)?.receipt_path),
      }),
    );
  }
  return lines.join("\n") + "\n";
}

// ── Billing a job's expenses on its invoice ──────────────────────────────────

/**
 * The job's billable, not-yet-billed expenses as invoice lines. Goes through a security
 * definer function: the person invoicing (maybe a crew member finishing the job) can't
 * see the rest of the crew's expenses under RLS. Never fails the invoice.
 */
export async function billableExpenseLines(
  ctx: TenantServiceContext,
  bookingId: string,
): Promise<{ ids: string[]; lines: Array<ReturnType<typeof billableLine>> }> {
  try {
    const { data, error } = await ctx.supabase.rpc("billable_expenses_for_booking", { p_booking_id: bookingId });
    if (error) throw error;
    const rows = (data ?? []).filter((r) => preTaxCents(r) > 0);
    return { ids: rows.map((r) => r.id), lines: rows.map(billableLine) };
  } catch (err) {
    console.error("[expenses] could not read billable expenses:", err instanceof Error ? err.message : err);
    return { ids: [], lines: [] };
  }
}

export async function markExpensesBilled(ctx: TenantServiceContext, invoiceId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await ctx.supabase.rpc("mark_expenses_billed", { p_invoice_id: invoiceId, p_expense_ids: ids });
  if (error) console.error("[expenses] could not mark expenses billed:", error.message);
}
