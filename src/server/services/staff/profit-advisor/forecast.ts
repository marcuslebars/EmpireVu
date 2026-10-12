/**
 * The 30/60/90-day cash forecast (docs/ai-staff.md → "Profit advisor"). Everything here is PURE:
 * forecast-data.ts loads the inputs (tolerantly), this turns them into dated money in / money out
 * with a "likely" and a "low" (cautious) case, and finds where the running total dips.
 *
 * There's no bank balance in the app, so the forecast is RELATIVE: it starts at $0 today and adds
 * what's expected in and takes off what's expected out, day by day. "Tight" means that running
 * total (likely case) drops below −cushion (setting, default $0: more going out than coming in) —
 * by a real amount: at least $1,000 AND at least a week of normal spending. A smaller dip is just
 * the few days between paying the bills and the next payment landing, which any running business
 * covers from the bank; calling that "tight" every week would teach the owner to ignore it.
 *
 * Money in (tax included — it's cash):
 *   • open invoices: due date + that customer's usual lateness (median days paid after the due
 *     date, last 12 months), else the company's, else 7 days. Already later than usual → in about a
 *     week (likely) / a month (low). More than 90 days overdue → half (likely) / nothing (low).
 *   • approved quotes: an unpaid deposit within a week; the balance after the job (job date + the
 *     company's usual days from invoice to paid, else 14) — 75% of it in the low case.
 *   • scheduled jobs (no quote, no invoice yet): their price (booking price, else the series
 *     price, else the price-list price) + HST after the job; 90% likely / 70% low. A job with no
 *     price counts half the company's average job (likely only).
 *   • recurring visits past what's generated (the recurring sweep books 60 days ahead): the series'
 *     own dates/rule × its price, like scheduled jobs.
 *   • annual service-plan renewals ending in the window: 70% likely, none in the low case.
 * Money out:
 *   • overhead: the last 90 days of expenses (all categories, receipts as paid, HST included)
 *     as a daily rate — single expenses over $2,500 are left out as one-offs; low case +10%.
 *   • payroll: the last 28 days of clocked hours × pay rates as a daily rate (crew with no rate at
 *     the average known rate); low case +10%.
 *   • HST: net tax of returns whose payment is due in the window (the Tax Clerk's worksheet).
 *   • open purchase orders: the low case adds each in full on its needed-by day; the likely case
 *     only adds what's beyond the usual materials spend already in the overhead rate.
 *   • equipment rentals still out (Fleet, when present): the daily rate until due back.
 */
import { addDays, daysBetween } from "./format";

export const HORIZON_DAYS = 90;
export const WINDOW_DAYS = [30, 60, 90] as const;
/** Expenses above this are one-offs (a truck, a big tool), not monthly overhead. */
export const ONE_OFF_CENTS = 250_000;
export const OUT_LOW_FACTOR = 1.1;
export const DEFAULT_DUE_LAG_DAYS = 7;
export const DEFAULT_PAY_AFTER_JOB_DAYS = 14;
export const HST_FACTOR = 1.13;
const LOW_DELAY_DAYS = 14;
/** A dip smaller than this (or than a week of normal spending) isn't "tight". */
export const MIN_SHORT_CENTS = 100_000;
const MIN_SHORT_DAYS = 7;
const EXPENSE_DAYS = 90;
const LABOUR_DAYS = 28;

export type InKind = "invoice" | "deposit" | "quote_balance" | "job" | "recurring" | "plan_renewal";
export type OutKind = "hst" | "materials" | "rental";

export interface CashItem<K extends string = string> {
  kind: K;
  label: string;
  /** Likely date and amount. */
  date: string;
  likelyCents: number;
  /** Cautious date and amount. */
  lowDate: string;
  lowCents: number;
}

export interface OpenInvoiceInput {
  id: string;
  label: string;
  contactId: string | null;
  balanceCents: number;
  dueDate: string | null;
  issueDate: string | null;
}

export interface PaidInvoiceInput {
  contactId: string | null;
  dueDate: string | null;
  issueDate: string | null;
  paidDate: string;
}

export interface QuoteInput {
  id: string;
  label: string;
  /** Deposit asked for and not paid yet (0 when paid or none). */
  depositDueCents: number;
  /** What's left after the deposit (tax included). */
  balanceCents: number;
  /** The booked job's local date, else null. */
  jobDate: string | null;
}

export interface JobInput {
  id: string;
  label: string;
  date: string;
  /** Tax-included price, or null when the job has no price yet. */
  expectedCents: number | null;
}

export interface SeriesInput {
  id: string;
  label: string;
  /** Tax-included price per visit. */
  visitCents: number;
  /** Visit dates not booked yet (past the generated horizon), inside the forecast. */
  dates: string[];
}

export interface RenewalInput {
  id: string;
  label: string;
  date: string;
  cents: number;
}

export interface ExpenseInput {
  spentOn: string;
  category: string;
  amountCents: number;
}

export interface LabourInput {
  profileId: string;
  minutes: number;
  rateCents: number | null;
}

export interface HstInput {
  label: string;
  dueDate: string;
  cents: number;
}

export interface PoInput {
  label: string;
  neededBy: string | null;
  cents: number;
}

export interface RentalInput {
  label: string;
  from: string;
  to: string;
  dailyCents: number;
}

export interface ForecastInputs {
  today: string;
  openInvoices: OpenInvoiceInput[];
  paidHistory: PaidInvoiceInput[];
  quotes: QuoteInput[];
  jobs: JobInput[];
  series: SeriesInput[];
  renewals: RenewalInput[];
  /** Expenses of the last 90 days. */
  expenses: ExpenseInput[];
  /** Time worked in the last 28 days, per person. */
  labour: LabourInput[];
  /** Average tax-included revenue of a finished job (for jobs with no price), else null. */
  averageJobCents: number | null;
  hst: HstInput[];
  pos: PoInput[];
  rentals: RentalInput[];
  /** What couldn't be read ("HST not included - couldn't read it"). */
  notes: string[];
}

export function median(values: number[]): number | null {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export interface PayLags {
  /** Median days paid after the due date, per customer. */
  byContact: Map<string, number>;
  /** The company's median days paid after the due date. */
  companyDueLag: number;
  /** The company's median days from invoice date to paid (for jobs not invoiced yet). */
  payAfterJob: number;
}

/** How late each customer (and the company's customers overall) usually pay. PURE. */
export function payLags(history: PaidInvoiceInput[]): PayLags {
  const perContact = new Map<string, number[]>();
  const dueLags: number[] = [];
  const issueLags: number[] = [];
  for (const h of history) {
    if (h.dueDate) {
      const lag = clamp(daysBetween(h.dueDate, h.paidDate), -30, 120);
      dueLags.push(lag);
      if (h.contactId) perContact.set(h.contactId, [...(perContact.get(h.contactId) ?? []), lag]);
    }
    if (h.issueDate) issueLags.push(clamp(daysBetween(h.issueDate, h.paidDate), 0, 150));
  }
  const byContact = new Map<string, number>();
  for (const [id, lags] of perContact) byContact.set(id, median(lags) ?? DEFAULT_DUE_LAG_DAYS);
  return {
    byContact,
    companyDueLag: median(dueLags) ?? DEFAULT_DUE_LAG_DAYS,
    payAfterJob: median(issueLags) ?? DEFAULT_PAY_AFTER_JOB_DAYS,
  };
}

const later = (a: string, b: string) => (a > b ? a : b);

/** Open invoices → expected payments. PURE. */
export function invoiceItems(invoices: OpenInvoiceInput[], lags: PayLags, today: string): CashItem<"invoice">[] {
  const out: CashItem<"invoice">[] = [];
  for (const inv of invoices) {
    if (!(inv.balanceCents > 0)) continue;
    const due = inv.dueDate ?? (inv.issueDate ? addDays(inv.issueDate, 14) : today);
    const lag = (inv.contactId ? lags.byContact.get(inv.contactId) : undefined) ?? lags.companyDueLag;
    const expected = addDays(due, Math.max(0, lag));
    const daysLate = daysBetween(due, today);
    const veryLate = daysLate > 90;
    const behind = expected < today;
    out.push({
      kind: "invoice",
      label: inv.label,
      date: behind ? addDays(today, 7) : expected,
      likelyCents: veryLate ? Math.round(inv.balanceCents / 2) : inv.balanceCents,
      lowDate: behind ? addDays(today, 30) : addDays(expected, LOW_DELAY_DAYS),
      lowCents: veryLate ? 0 : inv.balanceCents,
    });
  }
  return out;
}

/** Approved quotes → deposit + balance. PURE. */
export function quoteItems(quotes: QuoteInput[], lags: PayLags, today: string): CashItem<"deposit" | "quote_balance">[] {
  const out: CashItem<"deposit" | "quote_balance">[] = [];
  for (const q of quotes) {
    if (q.depositDueCents > 0) {
      out.push({ kind: "deposit", label: `${q.label} deposit`, date: addDays(today, 7), likelyCents: q.depositDueCents, lowDate: addDays(today, 21), lowCents: Math.round(q.depositDueCents / 2) });
    }
    if (q.balanceCents > 0) {
      const jobDay = q.jobDate ? later(q.jobDate, today) : addDays(today, 30);
      const date = addDays(jobDay, lags.payAfterJob);
      out.push({ kind: "quote_balance", label: q.label, date, likelyCents: q.balanceCents, lowDate: addDays(date, LOW_DELAY_DAYS), lowCents: Math.round(q.balanceCents * 0.75) });
    }
  }
  return out;
}

/** Scheduled jobs (no quote, no invoice) → paid after the job. PURE. */
export function jobItems(jobs: JobInput[], lags: PayLags, averageJobCents: number | null, today: string): CashItem<"job">[] {
  const out: CashItem<"job">[] = [];
  for (const j of jobs) {
    const date = addDays(later(j.date, today), lags.payAfterJob);
    if (j.expectedCents != null && j.expectedCents > 0) {
      out.push({ kind: "job", label: j.label, date, likelyCents: Math.round(j.expectedCents * 0.9), lowDate: addDays(date, LOW_DELAY_DAYS), lowCents: Math.round(j.expectedCents * 0.7) });
    } else if (j.expectedCents == null && averageJobCents && averageJobCents > 0) {
      out.push({ kind: "job", label: `${j.label} (no price)`, date, likelyCents: Math.round(averageJobCents / 2), lowDate: addDays(date, LOW_DELAY_DAYS), lowCents: 0 });
    }
  }
  return out;
}

/** Recurring visits not booked yet → like scheduled jobs. PURE. */
export function seriesItems(series: SeriesInput[], lags: PayLags, today: string): CashItem<"recurring">[] {
  const out: CashItem<"recurring">[] = [];
  for (const s of series) {
    if (!(s.visitCents > 0)) continue;
    for (const d of s.dates) {
      if (d < today) continue;
      const date = addDays(d, lags.payAfterJob);
      out.push({ kind: "recurring", label: s.label, date, likelyCents: Math.round(s.visitCents * 0.9), lowDate: addDays(date, LOW_DELAY_DAYS), lowCents: Math.round(s.visitCents * 0.7) });
    }
  }
  return out;
}

/** Annual plan renewals ending in the window. PURE. */
export function renewalItems(renewals: RenewalInput[], today: string): CashItem<"plan_renewal">[] {
  return renewals
    .filter((r) => r.cents > 0)
    .map((r) => ({ kind: "plan_renewal" as const, label: r.label, date: later(r.date, today), likelyCents: Math.round(r.cents * 0.7), lowDate: later(r.date, today), lowCents: 0 }));
}

export interface OverheadRate {
  dailyCents: number;
  /** The materials part of the daily rate (open POs are on top of this). */
  materialsDailyCents: number;
  byCategory: Array<{ category: string; monthlyCents: number }>;
  oneOffCount: number;
  oneOffCents: number;
}

/** The last 90 days of expenses → a daily rate (one-offs over ONE_OFF_CENTS left out). PURE. */
export function overheadRate(expenses: ExpenseInput[], days = EXPENSE_DAYS, oneOffCents = ONE_OFF_CENTS): OverheadRate {
  const by = new Map<string, number>();
  let oneOffCount = 0;
  let oneOff = 0;
  for (const e of expenses) {
    const cents = Math.max(0, Math.round(e.amountCents));
    if (cents > oneOffCents) {
      oneOffCount += 1;
      oneOff += cents;
      continue;
    }
    by.set(e.category, (by.get(e.category) ?? 0) + cents);
  }
  const total = [...by.values()].reduce((s, c) => s + c, 0);
  return {
    dailyCents: total / days,
    materialsDailyCents: (by.get("materials") ?? 0) / days,
    byCategory: [...by.entries()].map(([category, cents]) => ({ category, monthlyCents: Math.round((cents / days) * 30) })).sort((a, b) => b.monthlyCents - a.monthlyCents),
    oneOffCount,
    oneOffCents: oneOff,
  };
}

export interface PayrollRate {
  dailyCents: number;
  minutes: number;
  people: number;
  /** People who worked but have no pay rate (counted at the average known rate). */
  missingRate: number;
}

/** The last 28 days of hours × rates → a daily rate. PURE. */
export function payrollRate(labour: LabourInput[], days = LABOUR_DAYS): PayrollRate {
  let knownMinutes = 0;
  let knownCents = 0;
  let unknownMinutes = 0;
  let minutes = 0;
  const people = new Set<string>();
  const missing = new Set<string>();
  for (const l of labour) {
    if (!(l.minutes > 0)) continue;
    minutes += l.minutes;
    people.add(l.profileId);
    if (l.rateCents != null && l.rateCents > 0) {
      knownMinutes += l.minutes;
      knownCents += (l.minutes * l.rateCents) / 60;
    } else {
      unknownMinutes += l.minutes;
      missing.add(l.profileId);
    }
  }
  const avgRate = knownMinutes > 0 ? knownCents / knownMinutes : 0;
  return { dailyCents: (knownCents + unknownMinutes * avgRate) / days, minutes, people: people.size, missingRate: missing.size };
}

/** Open POs: the low case pays each in full; the likely case only what's beyond the usual materials spend. PURE. */
export function poItems(pos: PoInput[], materialsDailyCents: number, today: string): CashItem<"materials">[] {
  const open = pos.filter((p) => p.cents > 0);
  if (open.length === 0) return [];
  const total = open.reduce((s, p) => s + p.cents, 0);
  const lastDay = open.reduce((d, p) => later(p.neededBy ?? today, d), today);
  const span = Math.max(7, daysBetween(today, lastDay) + 1);
  const extra = Math.max(0, 1 - (materialsDailyCents * span) / total);
  return open.map((p) => {
    const date = later(p.neededBy ?? today, today);
    return { kind: "materials" as const, label: p.label, date, likelyCents: Math.round(p.cents * extra), lowDate: date, lowCents: p.cents };
  });
}

/** Rentals still out: the daily rate until due back (inside the horizon), paid on return. PURE. */
export function rentalItems(rentals: RentalInput[], today: string, horizonDays = HORIZON_DAYS): CashItem<"rental">[] {
  const end = addDays(today, horizonDays - 1);
  const out: CashItem<"rental">[] = [];
  for (const r of rentals) {
    if (!(r.dailyCents > 0)) continue;
    const from = later(r.from, today);
    const to = r.to < end ? r.to : end;
    const days = daysBetween(from, to) + 1;
    if (days <= 0) continue;
    const cents = Math.round(days * r.dailyCents);
    out.push({ kind: "rental", label: r.label, date: to, likelyCents: cents, lowDate: to, lowCents: cents });
  }
  return out;
}

export function hstItems(hst: HstInput[], today: string): CashItem<"hst">[] {
  return hst.filter((h) => h.cents > 0).map((h) => ({ kind: "hst" as const, label: h.label, date: later(h.dueDate, today), likelyCents: h.cents, lowDate: later(h.dueDate, today), lowCents: h.cents }));
}

export interface WindowTotals {
  days: number;
  inLikelyCents: number;
  inLowCents: number;
  outLikelyCents: number;
  outLowCents: number;
  netLikelyCents: number;
  netLowCents: number;
}

export interface Dip {
  /** The likely running total drops below −cushion. */
  tight: boolean;
  /** The day the running total is lowest, and how far below −cushion it is then. */
  date: string | null;
  shortCents: number;
  lowestCents: number;
}

export interface Forecast {
  today: string;
  horizonDays: number;
  cushionCents: number;
  windows: WindowTotals[];
  /** Likely case: over the first 30 days, and the whole horizon. */
  tight30: Dip;
  tight90: Dip;
  /** The low case over the whole horizon (for "it could get tight"). */
  lowCase: Dip;
  moneyIn: CashItem<InKind>[];
  moneyOut: CashItem<OutKind>[];
  overhead: OverheadRate;
  payroll: PayrollRate;
  dailyOutLikelyCents: number;
  dailyOutLowCents: number;
  notes: string[];
}

function dip(path: number[], days: string[], cushionCents: number, upTo: number, minShortCents: number): Dip {
  let lowest = 0;
  let at: string | null = null;
  for (let i = 0; i < Math.min(upTo, path.length); i++) {
    if (path[i] < lowest) {
      lowest = path[i];
      at = days[i];
    }
  }
  const tight = -cushionCents - lowest >= minShortCents;
  return { tight, date: tight ? at : null, shortCents: tight ? Math.round(-cushionCents - lowest) : 0, lowestCents: Math.round(lowest) };
}

/** The whole forecast from its inputs. PURE. */
export function buildForecast(inputs: ForecastInputs, opts: { cushionCents?: number; horizonDays?: number } = {}): Forecast {
  const horizon = opts.horizonDays ?? HORIZON_DAYS;
  const cushion = Math.max(0, opts.cushionCents ?? 0);
  const today = inputs.today;
  const lags = payLags(inputs.paidHistory);
  const overhead = overheadRate(inputs.expenses);
  const payroll = payrollRate(inputs.labour);
  const moneyIn: CashItem<InKind>[] = [
    ...invoiceItems(inputs.openInvoices, lags, today),
    ...quoteItems(inputs.quotes, lags, today),
    ...jobItems(inputs.jobs, lags, inputs.averageJobCents, today),
    ...seriesItems(inputs.series, lags, today),
    ...renewalItems(inputs.renewals, today),
  ];
  const moneyOut: CashItem<OutKind>[] = [...hstItems(inputs.hst, today), ...poItems(inputs.pos, overhead.materialsDailyCents, today), ...rentalItems(inputs.rentals, today, horizon)];
  const dailyLikely = overhead.dailyCents + payroll.dailyCents;
  const dailyLow = dailyLikely * OUT_LOW_FACTOR;

  const days = Array.from({ length: horizon }, (_, i) => addDays(today, i));
  const index = new Map(days.map((d, i) => [d, i]));
  const at = (date: string) => index.get(date < today ? today : date);
  const inLikely = new Array<number>(horizon).fill(0);
  const inLow = new Array<number>(horizon).fill(0);
  const outLikely = new Array<number>(horizon).fill(dailyLikely);
  const outLow = new Array<number>(horizon).fill(dailyLow);
  for (const item of moneyIn) {
    const i = at(item.date);
    if (i !== undefined) inLikely[i] += item.likelyCents;
    const j = at(item.lowDate);
    if (j !== undefined) inLow[j] += item.lowCents;
  }
  for (const item of moneyOut) {
    const i = at(item.date);
    if (i !== undefined) outLikely[i] += item.likelyCents;
    const j = at(item.lowDate);
    if (j !== undefined) outLow[j] += item.lowCents;
  }
  const likelyPath: number[] = [];
  const lowPath: number[] = [];
  let cl = 0;
  let cw = 0;
  for (let i = 0; i < horizon; i++) {
    cl += inLikely[i] - outLikely[i];
    cw += inLow[i] - outLow[i];
    likelyPath.push(cl);
    lowPath.push(cw);
  }
  const floor = (daily: number) => Math.max(MIN_SHORT_CENTS, Math.round(daily * MIN_SHORT_DAYS));
  const sum = (a: number[], n: number) => Math.round(a.slice(0, n).reduce((s, v) => s + v, 0));
  const windows = WINDOW_DAYS.filter((n) => n <= horizon).map((n) => {
    const w = { days: n, inLikelyCents: sum(inLikely, n), inLowCents: sum(inLow, n), outLikelyCents: sum(outLikely, n), outLowCents: sum(outLow, n) };
    return { ...w, netLikelyCents: w.inLikelyCents - w.outLikelyCents, netLowCents: w.inLowCents - w.outLowCents };
  });
  const notes = [...inputs.notes];
  if (payroll.missingRate > 0) notes.push(`${payroll.missingRate} crew ${payroll.missingRate === 1 ? "has" : "have"} no pay rate - payroll uses the average rate.`);
  if (overhead.oneOffCount > 0) notes.push(`${overhead.oneOffCount} big one-off expense${overhead.oneOffCount === 1 ? "" : "s"} left out of the monthly spend.`);
  return {
    today,
    horizonDays: horizon,
    cushionCents: cushion,
    windows,
    tight30: dip(likelyPath, days, cushion, 30, floor(dailyLikely)),
    tight90: dip(likelyPath, days, cushion, horizon, floor(dailyLikely)),
    lowCase: dip(lowPath, days, cushion, horizon, floor(dailyLow)),
    moneyIn: moneyIn.sort((a, b) => a.date.localeCompare(b.date)),
    moneyOut: moneyOut.sort((a, b) => a.date.localeCompare(b.date)),
    overhead,
    payroll,
    dailyOutLikelyCents: Math.round(dailyLikely),
    dailyOutLowCents: Math.round(dailyLow),
    notes,
  };
}
