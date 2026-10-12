/**
 * The HST worksheet (regular method only) — periods, due dates and the CRA lines. PURE except
 * the loaders at the bottom (service role, scoped by organization + company).
 *
 * Periods follow the fiscal year (it ends on the last day of `fiscalYearEndMonth`):
 *   monthly    each calendar month
 *   quarterly  3-month blocks from the fiscal year's first month ("Q3" = its third quarter)
 *   annual     the fiscal year
 * Due dates (CRA):
 *   monthly / quarterly          one month after the period ends (end of the next month)
 *   annual, individual, Dec 31   return June 15, payment April 30
 *   annual, everyone else        3 months after the fiscal year end (return and payment)
 *
 * Lines:
 *   101  sales and other revenue, before tax: invoices ISSUED in the period (issue_date), not
 *        draft / void, not imported (the old system already reported those). A credit note
 *        (an invoice with a negative subtotal) lowers it. Deposits applied (credit_cents) are
 *        payments, not price changes, so they don't.
 *   103  HST collected on those invoices (tax_cents, signed the same way).
 *   106  input tax credits: the sales tax on the period's expenses (spent_on); meals and
 *        entertainment count at 50%. PLUS late ITCs: receipts from an earlier period that came
 *        in after that period was closed (its packet emailed, else its due date passed) and
 *        after every period since — CRA lets you claim those in a later return (4 years).
 *   109  net tax = 103 - 106 (a negative number is a refund).
 * Prepared figures only — the owner or their accountant files the return.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db, ExpenseLite, FilerType, HstFrequency, InvoiceLite } from "./db-types";

export const DISCLAIMER = "Prepared figures - you or your accountant file the return.";

export interface HstSettingsLite {
  frequency: HstFrequency;
  fiscalYearEndMonth: number;
  filer: FilerType;
}

export interface HstPeriod {
  frequency: HstFrequency;
  start: string;
  end: string;
  /** "Q3", "Sep", "2026" / "FY2027". */
  label: string;
  /** "Jul 1 - Sep 30, 2026". */
  range: string;
  dueDate: string;
  paymentDueDate: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number) => String(n).padStart(2, "0");
function ym(y: number, m: number): { y: number; m: number } {
  const idx = y * 12 + (m - 1);
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}
function lastDay(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function first(y: number, m: number): string {
  const v = ym(y, m);
  return `${v.y}-${pad(v.m)}-01`;
}
function last(y: number, m: number): string {
  const v = ym(y, m);
  return `${v.y}-${pad(v.m)}-${pad(lastDay(v.y, v.m))}`;
}
function parts(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split("-").map(Number);
  return { y, m, d };
}

/** "Oct 31" / "Oct 31, 2027" (with the year when it isn't `refYear`). */
export function shortDate(date: string, refYear?: number): string {
  const { y, m, d } = parts(date);
  return `${MONTHS[m - 1]} ${d}${refYear !== undefined && refYear !== y ? `, ${y}` : ""}`;
}

export function addDaysTo(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function rangeLabel(start: string, end: string): string {
  const s = parts(start);
  const e = parts(end);
  return `${MONTHS[s.m - 1]} ${s.d}${s.y !== e.y ? `, ${s.y}` : ""} - ${MONTHS[e.m - 1]} ${e.d}, ${e.y}`;
}

/** The HST period that contains `date`. PURE. */
export function periodContaining(date: string, settings: HstSettingsLite): HstPeriod {
  const { y, m } = parts(date);
  const fye = settings.fiscalYearEndMonth;
  const startMonth = (fye % 12) + 1;
  // The fiscal year containing `date` starts in startMonth of fyStartYear.
  const fyStartYear = m >= startMonth ? y : y - 1;
  const offset = (m - startMonth + 12) % 12;
  let start: string;
  let end: string;
  let label: string;
  if (settings.frequency === "monthly") {
    start = first(y, m);
    end = last(y, m);
    label = MONTHS[m - 1];
  } else if (settings.frequency === "quarterly") {
    const q = Math.floor(offset / 3);
    start = first(fyStartYear, startMonth + q * 3);
    end = last(fyStartYear, startMonth + q * 3 + 2);
    label = `Q${q + 1}`;
  } else {
    start = first(fyStartYear, startMonth);
    end = last(fyStartYear, startMonth + 11);
    const endYear = parts(end).y;
    label = fye === 12 ? String(endYear) : `FY${endYear}`;
  }
  const e = parts(end);
  let dueDate: string;
  let paymentDueDate: string;
  if (settings.frequency !== "annual") {
    dueDate = last(e.y, e.m + 1);
    paymentDueDate = dueDate;
  } else if (settings.filer === "individual" && fye === 12) {
    dueDate = `${e.y + 1}-06-15`;
    paymentDueDate = `${e.y + 1}-04-30`;
  } else {
    dueDate = last(e.y, e.m + 3);
    paymentDueDate = dueDate;
  }
  return { frequency: settings.frequency, start, end, label, range: rangeLabel(start, end), dueDate, paymentDueDate };
}

/** The period before `period`. PURE. */
export function previousPeriod(period: HstPeriod, settings: HstSettingsLite): HstPeriod {
  return periodContaining(addDaysTo(period.start, -1), settings);
}

/** The most recent period that has ended by `today` (the one being filed now). PURE. */
export function lastEndedPeriod(today: string, settings: HstSettingsLite): HstPeriod {
  return previousPeriod(periodContaining(today, settings), settings);
}

/** "Q3 HST" / "Sep HST" / "2026 HST". */
export function periodName(period: Pick<HstPeriod, "label">): string {
  return `${period.label} HST`;
}

// ── The worksheet ─────────────────────────────────────────────────────────────

export interface HstWorksheet {
  /** Line 101. */
  salesCents: number;
  /** Line 103. */
  collectedCents: number;
  /** Line 106 (incl. late ITCs). */
  itcCents: number;
  /** ITCs from earlier periods that weren't claimed before (part of itcCents). */
  lateItcCents: number;
  lateExpenseCount: number;
  /** Line 109 = 103 - 106 (negative → refund). */
  netCents: number;
  invoiceCount: number;
  creditNoteCount: number;
  /** Invoices left out because they came from the old system (imported_at set). */
  importedExcluded: number;
  expenseCount: number;
  /** Sales tax on meals left out (50% rule). */
  mealsDisallowedCents: number;
  /** Expenses with no receipt picture. */
  missingReceipts: number;
}

const COUNTED_STATUSES = new Set(["sent", "viewed", "partially_paid", "paid"]);

export function invoiceCounts(inv: Pick<InvoiceLite, "status" | "imported_at" | "issue_date">, period: Pick<HstPeriod, "start" | "end">): boolean {
  return COUNTED_STATUSES.has(inv.status) && !inv.imported_at && !!inv.issue_date && inv.issue_date >= period.start && inv.issue_date <= period.end;
}

/** The ITC an expense gives: its sales tax, half for meals. PURE. */
export function itcOf(e: Pick<ExpenseLite, "category" | "tax_cents">): number {
  const tax = Math.max(0, e.tax_cents ?? 0);
  return e.category === "meals" ? Math.round(tax / 2) : tax;
}

/** The CRA lines for one period from its invoices and expenses (already filtered by company). PURE. */
export function computeWorksheet(invoices: InvoiceLite[], expenses: ExpenseLite[], period: Pick<HstPeriod, "start" | "end">, late: ExpenseLite[] = []): HstWorksheet {
  let sales = 0;
  let collected = 0;
  let count = 0;
  let credits = 0;
  let imported = 0;
  for (const inv of invoices) {
    if (inv.issue_date && inv.issue_date >= period.start && inv.issue_date <= period.end && inv.imported_at && COUNTED_STATUSES.has(inv.status)) imported += 1;
    if (!invoiceCounts(inv, period)) continue;
    sales += inv.subtotal_cents ?? 0;
    collected += inv.tax_cents ?? 0;
    count += 1;
    if ((inv.subtotal_cents ?? 0) < 0) credits += 1;
  }
  let itc = 0;
  let meals = 0;
  let missing = 0;
  let expenseCount = 0;
  for (const e of expenses) {
    if (e.spent_on < period.start || e.spent_on > period.end) continue;
    expenseCount += 1;
    const credit = itcOf(e);
    itc += credit;
    meals += Math.max(0, e.tax_cents ?? 0) - credit;
    if (!e.receipt_path) missing += 1;
  }
  let lateItc = 0;
  for (const e of late) {
    const credit = itcOf(e);
    lateItc += credit;
    meals += Math.max(0, e.tax_cents ?? 0) - credit;
    if (!e.receipt_path) missing += 1;
  }
  itc += lateItc;
  return {
    salesCents: sales,
    collectedCents: collected,
    itcCents: itc,
    lateItcCents: lateItc,
    lateExpenseCount: late.length,
    netCents: collected - itc,
    invoiceCount: count,
    creditNoteCount: credits,
    importedExcluded: imported,
    expenseCount,
    mealsDisallowedCents: meals,
    missingReceipts: missing,
  };
}

/** "$1,240" / "$84.20". */
export function money(cents: number): string {
  const abs = Math.abs(cents);
  const s = `$${(abs / 100).toLocaleString("en-CA", { minimumFractionDigits: abs % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
  return cents < 0 ? `-${s}` : s;
}

/** "owing about $860" / "refund about $120" / "nothing owing". PURE. */
export function netPhrase(netCents: number): string {
  if (netCents === 0) return "nothing owing";
  return netCents > 0 ? `owing about ${money(netCents)}` : `refund about ${money(-netCents)}`;
}

/** The 10-day reminder text (also the accountant_packet summary's start). PURE. */
export function reminderText(period: HstPeriod, w: HstWorksheet, refYear: number): string {
  const late = w.lateItcCents ? ` (incl. ${money(w.lateItcCents)} from earlier periods)` : "";
  return `${periodName(period)}: collected ${money(w.collectedCents)}, ITCs ${money(w.itcCents)}${late}, ${netPhrase(w.netCents)}. Due ${shortDate(period.paymentDueDate, refYear)}.`;
}

/** The breakdown for "hst" (owner tool). PURE. */
export function breakdownText(period: HstPeriod, w: HstWorksheet, opts: { refYear: number; toDate?: boolean }): string {
  const bits = [
    `${periodName(period)} (${period.range}${opts.toDate ? ", so far" : ""}):`,
    `101 sales ${money(w.salesCents)}`,
    `103 HST collected ${money(w.collectedCents)}`,
    `106 ITCs ${money(w.itcCents)}${w.lateItcCents ? ` (incl. ${money(w.lateItcCents)} from earlier periods)` : ""}`,
    `109 net ${money(w.netCents)} (${netPhrase(w.netCents)}).`,
    `Due ${shortDate(period.paymentDueDate, opts.refYear)}${period.paymentDueDate !== period.dueDate ? ` (return by ${shortDate(period.dueDate, opts.refYear)})` : ""}.`,
  ];
  const notes: string[] = [];
  if (w.missingReceipts) notes.push(`${w.missingReceipts} expense${w.missingReceipts === 1 ? "" : "s"} without a receipt`);
  if (w.importedExcluded) notes.push(`${w.importedExcluded} imported invoice${w.importedExcluded === 1 ? "" : "s"} left out`);
  if (w.mealsDisallowedCents) notes.push("meals at 50%");
  return `${bits.join(" ")}${notes.length ? ` Notes: ${notes.join(", ")}.` : ""} ${DISCLAIMER}`;
}

// ── Loaders (service role) ───────────────────────────────────────────────────

const PAGE = 1000;

async function readAll<T>(make: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>, max = 20_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += PAGE) {
    const { data, error } = await make(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

const INVOICE_COLUMNS = "id, company_id, invoice_number, status, issue_date, subtotal_cents, tax_cents, total_cents, credit_cents, amount_paid_cents, balance_due_cents, bill_to, title, imported_at";
const EXPENSE_COLUMNS = "id, organization_id, company_id, booking_id, spent_on, vendor, description, category, amount_cents, tax_cents, paid_with, receipt_path, receipt_type, created_by, created_at";

/** True when the org has just this one company (its expenses without a company are this one's). */
async function onlyCompany(admin: AdminClient, organizationId: string): Promise<boolean> {
  const { data } = await (admin as Db).from("companies").select("id").eq("organization_id", organizationId).limit(2);
  return ((data ?? []) as unknown[]).length === 1;
}

export interface WorksheetCompany {
  organizationId: string;
  companyId: string;
  settings: { hst: HstSettingsLite };
}

/** An expense claimed in a later return, with the period it belongs to ("Q2 2026"). */
export type LateExpense = ExpenseLite & { fromLabel: string };

/** CRA: ITCs can be claimed up to 4 years later. */
const LATE_LOOKBACK_DAYS = 4 * 365;

interface PeriodRowLite {
  period_start: string;
  period_end: string;
  packet_emailed_at: string | null;
}

/** When a period was closed: its packet went to the accountant, else the day after its due date. */
export function closedAtMs(period: Pick<HstPeriod, "start" | "end" | "dueDate">, rows: PeriodRowLite[]): number {
  const row = rows.find((r) => r.period_start === period.start && r.period_end === period.end);
  if (row?.packet_emailed_at) return Date.parse(row.packet_emailed_at);
  return Date.parse(`${addDaysTo(period.dueDate, 1)}T05:00:00Z`);
}

/**
 * Which earlier-period expenses `period` claims late: the expense came in after its own period
 * closed AND after every period since closed (otherwise an earlier return already took it). PURE.
 */
export function lateExpensesFor(candidates: ExpenseLite[], period: Pick<HstPeriod, "start">, settings: HstSettingsLite, rows: PeriodRowLite[]): LateExpense[] {
  const thresholds = new Map<string, { at: number; label: string }>();
  const out: LateExpense[] = [];
  for (const e of candidates) {
    if (e.spent_on >= period.start) continue;
    const own = periodContaining(e.spent_on, settings);
    let t = thresholds.get(own.start);
    if (!t) {
      let at = 0;
      for (let q: HstPeriod = own; q.start < period.start; q = periodContaining(addDaysTo(q.end, 1), settings)) at = Math.max(at, closedAtMs(q, rows));
      t = { at, label: `${own.label}${own.label.length <= 3 ? ` ${own.end.slice(0, 4)}` : ""}` };
      thresholds.set(own.start, t);
    }
    if (Date.parse(e.created_at) > t.at) out.push({ ...e, fromLabel: t.label });
  }
  return out;
}

export async function loadPeriodRecords(
  admin: AdminClient,
  company: WorksheetCompany,
  range: { start: string; end: string },
): Promise<{ invoices: InvoiceLite[]; expenses: ExpenseLite[]; late: LateExpense[] }> {
  const db = admin as Db;
  const scope = { organizationId: company.organizationId, companyId: company.companyId };
  const single = await onlyCompany(admin, scope.organizationId);
  const expensesIn = async (from: string, toExclusive: string | null, through: string | null, createdSince: string | null) => {
    const one = (companyNull: boolean) =>
      readAll<ExpenseLite>((a, b) => {
        let q = db.from("expenses").select(EXPENSE_COLUMNS).eq("organization_id", scope.organizationId);
        q = companyNull ? q.is("company_id", null) : q.eq("company_id", scope.companyId);
        q = q.gte("spent_on", from);
        if (toExclusive) q = q.lt("spent_on", toExclusive);
        if (through) q = q.lte("spent_on", through);
        if (createdSince) q = q.gte("created_at", createdSince);
        return q.order("spent_on", { ascending: true }).range(a, b);
      });
    const rows = await one(false);
    return single ? [...rows, ...(await one(true))].sort((x, y) => x.spent_on.localeCompare(y.spent_on)) : rows;
  };
  const [invoices, inPeriod, periodRows] = await Promise.all([
    readAll<InvoiceLite>((from, to) =>
      db
        .from("invoices")
        .select(INVOICE_COLUMNS)
        .eq("organization_id", scope.organizationId)
        .eq("company_id", scope.companyId)
        .gte("issue_date", range.start)
        .lte("issue_date", range.end)
        .order("issue_date", { ascending: true })
        .range(from, to),
    ),
    expensesIn(range.start, null, range.end, null),
    readAll<PeriodRowLite>((from, to) =>
      db.from("hst_periods").select("period_start, period_end, packet_emailed_at").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).order("period_start", { ascending: true }).range(from, to),
    ).catch(() => [] as PeriodRowLite[]),
  ]);
  // Once this period's packet went out, receipts that came in later belong to the next return.
  const own = periodRows.find((r) => r.period_start === range.start && r.period_end === range.end);
  const sentAt = own?.packet_emailed_at ? Date.parse(own.packet_emailed_at) : null;
  const expenses = sentAt === null ? inPeriod : inPeriod.filter((e) => Date.parse(e.created_at) <= sentAt);
  // Late ones can only have come in after the previous period closed (≥ its end).
  const candidates = await expensesIn(addDaysTo(range.start, -LATE_LOOKBACK_DAYS), range.start, null, `${addDaysTo(range.start, -1)}T00:00:00Z`);
  let late = lateExpensesFor(candidates, range, company.settings.hst, periodRows);
  if (sentAt !== null) late = late.filter((e) => Date.parse(e.created_at) <= sentAt);
  return { invoices, expenses, late };
}

export async function worksheetFor(admin: AdminClient, company: WorksheetCompany, period: Pick<HstPeriod, "start" | "end">): Promise<HstWorksheet> {
  const { invoices, expenses, late } = await loadPeriodRecords(admin, company, period);
  return computeWorksheet(invoices, expenses, period, late);
}
