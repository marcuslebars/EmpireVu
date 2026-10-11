/**
 * The owner's money picture: who owes what (aging), and cash in / expected. The arithmetic is
 * PURE (fixture-tested); the loaders are tenant-scoped reads (organization_id + company_id).
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { localWallTimeToUtcMs, weekKeyForDate } from "@/server/services/monthly-scorecard/weeks";
import { OPEN_INVOICE_STATUSES, owingCents, type CompanyCtx } from "./context";
import { INVOICE_COLUMNS, type BookkeeperInvoice, type Db } from "./db-types";
import { daysBetween, fullNameOf, localParts } from "./format";

export const AGING_BUCKETS = ["0-30", "31-60", "61-90", "90+"] as const;
export type AgingBucketKey = (typeof AGING_BUCKETS)[number];

/** 0–30 includes invoices not yet due. PURE. */
export function bucketFor(dueDate: string | null, today: string): AgingBucketKey {
  const late = dueDate ? daysBetween(dueDate, today) : 0;
  if (late <= 30) return "0-30";
  if (late <= 60) return "31-60";
  if (late <= 90) return "61-90";
  return "90+";
}

export interface OwingLine {
  invoiceId: string;
  invoiceNumber: string | null;
  customer: string;
  owingCents: number;
  dueDate: string | null;
  daysOverdue: number;
}

export interface AgingSummary {
  buckets: Record<AgingBucketKey, { cents: number; count: number }>;
  outstandingCents: number;
  overdueCents: number;
  overdueCount: number;
  openCount: number;
  top: OwingLine[];
}

/** Aging buckets + the top owing (by balance). PURE. */
export function agingSummary(invoices: Array<BookkeeperInvoice & { customer?: string }>, today: string, topN = 5): AgingSummary {
  const buckets = Object.fromEntries(AGING_BUCKETS.map((b) => [b, { cents: 0, count: 0 }])) as AgingSummary["buckets"];
  let outstanding = 0;
  let overdue = 0;
  let overdueCount = 0;
  const lines: OwingLine[] = [];
  for (const inv of invoices) {
    if (!OPEN_INVOICE_STATUSES.includes(inv.status)) continue;
    const owing = owingCents(inv);
    if (owing <= 0) continue;
    const late = inv.due_date ? daysBetween(inv.due_date, today) : 0;
    const bucket = buckets[bucketFor(inv.due_date, today)];
    bucket.cents += owing;
    bucket.count += 1;
    outstanding += owing;
    if (late > 0) {
      overdue += owing;
      overdueCount += 1;
    }
    lines.push({ invoiceId: inv.id, invoiceNumber: inv.invoice_number, customer: inv.customer ?? "Customer", owingCents: owing, dueDate: inv.due_date, daysOverdue: Math.max(0, late) });
  }
  lines.sort((a, b) => b.owingCents - a.owingCents || b.daysOverdue - a.daysOverdue);
  return { buckets, outstandingCents: outstanding, overdueCents: overdue, overdueCount, openCount: lines.length, top: lines.slice(0, topN) };
}

export interface CashInputs {
  payments: Array<{ amount_cents: number; received_at: string; status: string }>;
  depositsPaid: Array<{ approved_deposit_cents: number | null; deposit_paid_at: string | null }>;
  depositsExpected: Array<{ approved_deposit_cents: number | null }>;
}

export interface CashSnapshot {
  collectedWeekCents: number;
  collectedMonthCents: number;
  outstandingCents: number;
  overdueCents: number;
  overdueCount: number;
  depositsExpectedCents: number;
  depositsExpectedCount: number;
  weekStart: string;
  monthStart: string;
}

/** Local Monday and 1st of the month, as UTC instants. PURE. */
export function periodStarts(nowMs: number, timeZone: string): { weekStart: string; monthStart: string; weekFromMs: number; monthFromMs: number } {
  const today = localParts(nowMs, timeZone).date;
  const weekStart = weekKeyForDate(today);
  const monthStart = `${today.slice(0, 8)}01`;
  return { weekStart, monthStart, weekFromMs: localWallTimeToUtcMs(weekStart, 0, 0, timeZone), monthFromMs: localWallTimeToUtcMs(monthStart, 0, 0, timeZone) };
}

/** Collected (invoice payments + quote deposits), outstanding, overdue, deposits expected. PURE. */
export function cashSnapshot(inputs: CashInputs, aging: Pick<AgingSummary, "outstandingCents" | "overdueCents" | "overdueCount">, nowMs: number, timeZone: string): CashSnapshot {
  const { weekStart, monthStart, weekFromMs, monthFromMs } = periodStarts(nowMs, timeZone);
  let week = 0;
  let month = 0;
  const add = (cents: number, at: string | null) => {
    const ms = at ? Date.parse(at) : Number.NaN;
    if (!Number.isFinite(ms) || ms > nowMs || !cents) return;
    if (ms >= monthFromMs) month += cents;
    if (ms >= weekFromMs) week += cents;
  };
  for (const p of inputs.payments) if (p.status === "succeeded") add(Number(p.amount_cents) || 0, p.received_at);
  for (const d of inputs.depositsPaid) add(Number(d.approved_deposit_cents) || 0, d.deposit_paid_at);
  const expected = inputs.depositsExpected.filter((d) => (d.approved_deposit_cents ?? 0) > 0);
  return {
    collectedWeekCents: week,
    collectedMonthCents: month,
    outstandingCents: aging.outstandingCents,
    overdueCents: aging.overdueCents,
    overdueCount: aging.overdueCount,
    depositsExpectedCents: expected.reduce((s, d) => s + (d.approved_deposit_cents ?? 0), 0),
    depositsExpectedCount: expected.length,
    weekStart,
    monthStart,
  };
}

// ── Loaders (tenant-scoped) ─────────────────────────────────────────────────────

/** Open invoices with a balance, with the customer's name. */
export async function loadOpenInvoicesWithNames(admin: AdminClient, scope: { organizationId: string; companyId: string }, limit = 1000): Promise<Array<BookkeeperInvoice & { customer: string }>> {
  const db = admin as Db;
  const { data } = await db
    .from("invoices")
    .select(INVOICE_COLUMNS)
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .in("status", OPEN_INVOICE_STATUSES)
    .gt("balance_due_cents", 0)
    .limit(limit);
  const invoices = (data ?? []) as BookkeeperInvoice[];
  const ids = [...new Set(invoices.map((i) => i.contact_id).filter((x): x is string => Boolean(x)))];
  const names = new Map<string, string>();
  if (ids.length) {
    const { data: contacts } = await db.from("contacts").select("id, first_name, last_name, phone").eq("organization_id", scope.organizationId).in("id", ids);
    for (const c of (contacts ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; phone: string | null }>) names.set(c.id, fullNameOf(c));
  }
  return invoices.map((inv) => {
    const billTo = inv.bill_to && typeof inv.bill_to === "object" ? (inv.bill_to as Record<string, unknown>) : {};
    const fallback = typeof billTo.name === "string" && billTo.name.trim() ? billTo.name.trim() : "Customer";
    return { ...inv, customer: (inv.contact_id && names.get(inv.contact_id)) || fallback };
  });
}

export async function loadCashInputs(admin: AdminClient, ctx: Pick<CompanyCtx, "organizationId" | "companyId" | "timeZone">, nowMs: number): Promise<CashInputs> {
  const db = admin as Db;
  const { monthFromMs, weekFromMs } = periodStarts(nowMs, ctx.timeZone);
  const since = new Date(Math.min(monthFromMs, weekFromMs)).toISOString();
  const [payments, depositsPaid, depositsExpected] = await Promise.all([
    db.from("invoice_payments").select("amount_cents, received_at, status").eq("organization_id", ctx.organizationId).eq("company_id", ctx.companyId).eq("status", "succeeded").gte("received_at", since).limit(5000),
    db.from("quotes").select("approved_deposit_cents, deposit_paid_at").eq("organization_id", ctx.organizationId).eq("company_id", ctx.companyId).gte("deposit_paid_at", since).limit(5000),
    db.from("quotes").select("approved_deposit_cents").eq("organization_id", ctx.organizationId).eq("company_id", ctx.companyId).eq("status", "approved").is("deposit_paid_at", null).limit(5000),
  ]);
  return {
    payments: (payments.data ?? []) as CashInputs["payments"],
    depositsPaid: (depositsPaid.data ?? []) as CashInputs["depositsPaid"],
    depositsExpected: (depositsExpected.data ?? []) as CashInputs["depositsExpected"],
  };
}
