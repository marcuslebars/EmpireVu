/**
 * Business overview report — reads. Runs under the caller's session: RLS scopes every row
 * to their organization, and every query also filters organization_id (and company_id when
 * a company is selected). Owners and admins only (the route checks the role).
 */
import { z } from "zod";

import { resolveCompanyTimeZone } from "@/server/services/attribution";
import { ValidationError } from "@/server/organizations/context";
import { daysBetween } from "@/server/services/invoices/math";
import type { TenantServiceContext } from "@/server/services/shared";
import { buildPeriod, computeOverview, isYmd, MAX_RANGE_DAYS, type OverviewInputs, type OverviewPeriod, type OverviewReport } from "./overview-logic";

const PAGE = 1000;
const MAX_PAGES = 25;

type Page<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

/** Read every row of a query in pages of 1,000 (PostgREST caps a single response). */
async function readAll<T>(build: (from: number, to: number) => Page<T>): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await build(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

function chunks<T>(list: T[], size = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export const overviewQuerySchema = z.object({
  from: z.string(),
  to: z.string(),
  companyId: z.string().uuid().nullish(),
});

export function validateRange(from: string, to: string): void {
  if (!isYmd(from) || !isYmd(to)) throw new ValidationError("from and to must be dates (YYYY-MM-DD).");
  const days = daysBetween(from, to);
  if (days < 1) throw new ValidationError("The end date must be after the start date.");
  if (days > MAX_RANGE_DAYS) throw new ValidationError("Pick a range of two years or less.");
}

function personName(p: { full_name: string | null; email: string | null }): string {
  return p.full_name?.trim() || p.email || "Team member";
}

export async function fetchOverviewInputs(ctx: TenantServiceContext, period: OverviewPeriod, companyId: string | null): Promise<OverviewInputs> {
  const org = ctx.organizationId;
  const db = ctx.supabase;

  const [payments, depositQuotes, issued, open, bookings, sentQuotes, approvedQuotes, contacts, entries, rates, expenses, owed] = await Promise.all([
    readAll((a, b) => {
      let q = db
          .from("invoice_payments")
          .select("id, invoice_id, amount_cents, method, received_at")
          .eq("organization_id", org)
          .eq("status", "succeeded")
          .gte("received_at", period.prevFrom)
          .lt("received_at", period.to);
      if (companyId) q = q.eq("company_id", companyId);
      return q.order("received_at", { ascending: true }).range(a, b);
    }),
    readAll((a, b) => {
      let q = db
          .from("quotes")
          .select("id, contact_id, deposit_paid_at, approved_deposit_cents, deposit_cents, currency")
          .eq("organization_id", org)
          .gte("deposit_paid_at", period.prevFrom)
          .lt("deposit_paid_at", period.to);
      if (companyId) q = q.eq("company_id", companyId);
      return q.order("deposit_paid_at", { ascending: true }).range(a, b);
    }),
    readAll((a, b) => {
      let q = db
          .from("invoices")
          .select("id, issue_date, total_cents, currency, status")
          .eq("organization_id", org)
          .gte("issue_date", period.prevFromDate)
          .lt("issue_date", period.toDate);
      if (companyId) q = q.eq("company_id", companyId);
      return q.order("issue_date", { ascending: true }).range(a, b);
    }),
    readAll((a, b) => {
      let q = db
          .from("invoices")
          .select("id, balance_due_cents, pending_payment_cents, due_date, currency")
          .eq("organization_id", org)
          .in("status", ["sent", "viewed", "partially_paid"])
          .gt("balance_due_cents", 0);
      if (companyId) q = q.eq("company_id", companyId);
      return q.order("id", { ascending: true }).range(a, b);
    }),
    readAll((a, b) => {
      let q = db
          .from("bookings")
          .select("id, scheduled_for, status, contact_id")
          .eq("organization_id", org)
          .gte("scheduled_for", period.prevFrom)
          .lt("scheduled_for", period.to);
      if (companyId) q = q.eq("company_id", companyId);
      return q.order("scheduled_for", { ascending: true }).range(a, b);
    }),
    readAll((a, b) => {
      let q = db
          .from("quotes")
          .select("id, sent_at, approved_at, status, superseded_by, approved_total_cents, total_cents")
          .eq("organization_id", org)
          .gte("sent_at", period.prevFrom)
          .lt("sent_at", period.to);
      if (companyId) q = q.eq("company_id", companyId);
      return q.order("sent_at", { ascending: true }).range(a, b);
    }),
    readAll((a, b) => {
      let q = db
          .from("quotes")
          .select("id, sent_at, approved_at, status, superseded_by, approved_total_cents, total_cents")
          .eq("organization_id", org)
          .gte("approved_at", period.prevFrom)
          .lt("approved_at", period.to);
      if (companyId) q = q.eq("company_id", companyId);
      return q.order("approved_at", { ascending: true }).range(a, b);
    }),
    readAll((a, b) => {
      let q = db.from("contacts").select("id, created_at").eq("organization_id", org).gte("created_at", period.prevFrom).lt("created_at", period.to);
      if (companyId) q = q.eq("company_id", companyId);
      return q.order("created_at", { ascending: true }).range(a, b);
    }),
    // Crew time is org-wide; with a company selected keep that company's entries plus
    // general time (no company) — filtered below, since a missing company is "general".
    readAll((a, b) =>
      db
        .from("time_entries")
        .select("id, profile_id, booking_id, company_id, started_at, ended_at, break_minutes")
        .eq("organization_id", org)
        .gte("started_at", period.prevFrom)
        .lt("started_at", period.to)
        .order("started_at", { ascending: true })
        .range(a, b),
    ),
    db.from("member_pay_rates").select("profile_id, hourly_cost_cents").eq("organization_id", org),
    // Expenses: with a company selected keep that company's plus unassigned overhead (like crew time).
    readAll((a, b) =>
      db
        .from("expenses")
        .select("id, company_id, booking_id, spent_on, category, amount_cents, tax_cents")
        .eq("organization_id", org)
        .gte("spent_on", period.prevFromDate)
        .lt("spent_on", period.toDate)
        .order("spent_on", { ascending: true })
        .range(a, b),
    ),
    readAll((a, b) =>
      db
        .from("expenses")
        .select("id, company_id, amount_cents")
        .eq("organization_id", org)
        .eq("paid_with", "personal")
        .is("reimbursed_at", null)
        .order("id", { ascending: true })
        .range(a, b),
    ),
  ]);
  if (rates.error) throw rates.error;

  // Which customer each paid invoice belongs to (for "top customers").
  const invoiceIds = [...new Set(payments.map((p) => p.invoice_id))];
  const invoiceContacts: Record<string, string | null> = {};
  const invoiceCurrency: Record<string, string | null> = {};
  for (const ids of chunks(invoiceIds)) {
    const { data, error } = await db.from("invoices").select("id, contact_id, currency").eq("organization_id", org).in("id", ids);
    if (error) throw error;
    for (const row of data ?? []) {
      invoiceContacts[row.id] = row.contact_id;
      invoiceCurrency[row.id] = row.currency;
    }
  }

  const timeEntries = entries.filter((e) => !companyId || !e.company_id || e.company_id === companyId);

  // Online-booking deposit invoices: the job's own invoice later bills the full price and
  // credits the deposit, so counting both would invoice the deposit twice.
  const depositInvoiceIds = new Set<string>();
  for (const ids of chunks(issued.map((i) => i.id))) {
    const { data, error } = await db.from("bookings").select("deposit_invoice_id").eq("organization_id", org).in("deposit_invoice_id", ids);
    if (error) throw error;
    for (const b of data ?? []) if (b.deposit_invoice_id) depositInvoiceIds.add(b.deposit_invoice_id);
  }

  const quotesById = new Map<string, (typeof sentQuotes)[number]>();
  for (const q of [...sentQuotes, ...approvedQuotes]) quotesById.set(q.id, q);

  // Names: the top customers and the people who logged time.
  const contactIds = new Set<string>();
  for (const id of Object.values(invoiceContacts)) if (id) contactIds.add(id);
  for (const d of depositQuotes) if (d.contact_id) contactIds.add(d.contact_id);
  const contactNames: Record<string, string> = {};
  for (const ids of chunks([...contactIds])) {
    const { data, error } = await db.from("contacts").select("id, first_name, last_name").eq("organization_id", org).in("id", ids);
    if (error) throw error;
    for (const c of data ?? []) contactNames[c.id] = [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || "Customer";
  }
  const profileIds = [...new Set(timeEntries.map((e) => e.profile_id))];
  const people: Record<string, string> = {};
  for (const ids of chunks(profileIds)) {
    const { data, error } = await db.from("profiles").select("id, full_name, email").in("id", ids);
    if (error) throw error;
    for (const p of data ?? []) people[p.id] = personName(p);
  }

  return {
    payments: payments.map((p) => ({
      invoiceId: p.invoice_id,
      amountCents: p.amount_cents,
      method: p.method,
      receivedAt: p.received_at,
      currency: invoiceCurrency[p.invoice_id] ?? null,
    })),
    deposits: depositQuotes.map((q) => ({
      contactId: q.contact_id,
      cents: q.approved_deposit_cents ?? q.deposit_cents ?? 0,
      paidAt: q.deposit_paid_at as string,
      currency: q.currency,
    })),
    invoiceContacts,
    issued: issued
      .filter((i) => i.issue_date && i.status !== "draft" && i.status !== "void" && !depositInvoiceIds.has(i.id))
      .map((i) => ({ issueDate: i.issue_date as string, totalCents: i.total_cents, currency: i.currency })),
    open: open.map((o) => ({ balanceCents: o.balance_due_cents, pendingCents: o.pending_payment_cents, dueDate: o.due_date, currency: o.currency })),
    bookings: bookings.map((b) => ({ scheduledFor: b.scheduled_for, status: b.status, contactId: b.contact_id })),
    quotes: [...quotesById.values()].map((q) => ({
      sentAt: q.sent_at,
      approvedAt: q.approved_at,
      status: q.status,
      supersededBy: q.superseded_by,
      approvedTotalCents: q.approved_total_cents,
      totalCents: q.total_cents,
    })),
    newContacts: contacts.map((c) => c.created_at),
    timeEntries: timeEntries.map((e) => ({
      profileId: e.profile_id,
      bookingId: e.booking_id,
      startedAt: e.started_at,
      endedAt: e.ended_at,
      breakMinutes: e.break_minutes,
    })),
    rates: Object.fromEntries((rates.data ?? []).map((r) => [r.profile_id, r.hourly_cost_cents])),
    people,
    contactNames,
    expenses: expenses
      .filter((e) => !companyId || !e.company_id || e.company_id === companyId)
      .map((e) => ({ spentOn: e.spent_on, cents: Math.max(0, e.amount_cents - e.tax_cents), category: e.category, onJob: Boolean(e.booking_id) })),
    owedCents: owed.filter((e) => !companyId || !e.company_id || e.company_id === companyId).reduce((s, e) => s + e.amount_cents, 0),
  };
}

/** The whole overview for `[from, to)` (local calendar dates in the company's time zone). */
export async function getBusinessOverview(
  ctx: TenantServiceContext,
  opts: { from: string; to: string; companyId?: string | null },
  now: Date = new Date(),
): Promise<OverviewReport> {
  validateRange(opts.from, opts.to);
  const timeZone = await resolveCompanyTimeZone(ctx, opts.companyId ?? null);
  const period = buildPeriod(opts.from, opts.to, timeZone);
  const inputs = await fetchOverviewInputs(ctx, period, opts.companyId ?? null);
  return computeOverview(inputs, period, now);
}
