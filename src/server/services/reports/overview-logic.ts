/**
 * Business overview report — PURE: plain rows in, numbers out. The reads live in
 * overview.ts; everything that decides what a number means lives here so the tests pin it.
 *
 * Definitions (also in docs/reports-dashboard.md):
 *  - collected: invoice payments with status 'succeeded' received in the period, plus quote
 *    deposits paid in the period (deposits are taken on the quote, before any invoice, and the
 *    invoice later credits them — so the two never double count). Pending, failed and
 *    refunded payments are not money in.
 *  - invoiced: invoices ISSUED in the period (issue_date, a calendar date), excluding drafts
 *    and void invoices.
 *  - receivables: open invoices (sent / viewed / partially paid) with a balance, as of today —
 *    not period-bound. Aging is by days past the due date. "In transit" is money a customer
 *    has already sent that hasn't cleared (e.g. a bank debit).
 *  - jobs: bookings scheduled in the period, by status.
 *  - quotes: sent = sent_at in the period (revisions replaced by a newer quote are skipped);
 *    won = of those, how many have been approved so far; approved value = quotes approved in
 *    the period. Win rate = won ÷ sent.
 *  - new customers: contacts created in the period.
 *  - crew hours: time entries that started in the period, less breaks; labour cost uses each
 *    person's pay rate (people with no rate are listed, not costed as $0).
 *  - previous period: a range starting on Jan 1 compares with the same dates a year earlier;
 *    one starting on the 1st of a month compares with the same span of months before it;
 *    anything else compares with the same number of days immediately before.
 */
import { addDays, daysBetween, localDateString } from "@/server/services/invoices/math";
import { categoryLabel } from "@/server/services/expenses/rules";
import { labourCents, weekStart, workedMinutes } from "@/server/services/time/logic";
import { tzOffsetMs } from "@/server/services/attribution";

export type Bucket = "day" | "week" | "month";

export interface OverviewPeriod {
  /** Local calendar dates; `toDate` is exclusive. */
  fromDate: string;
  toDate: string;
  prevFromDate: string;
  prevToDate: string;
  /** UTC instants of local midnight at each boundary. */
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  timeZone: string;
  bucket: Bucket;
}

export const MAX_RANGE_DAYS = 731;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function isYmd(value: string | null | undefined): value is string {
  if (!value || !YMD.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** UTC instant of local midnight starting `ymd` in `timeZone` (DST-safe). */
export function localMidnightUtc(ymd: string, timeZone: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0);
  // Two passes: the offset at the guessed instant can differ across a DST edge.
  let utc = naive - tzOffsetMs(naive, timeZone);
  utc = naive - tzOffsetMs(utc, timeZone);
  return new Date(utc).toISOString();
}

function shiftMonths(ymd: string, months: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** Whole months from the month of `from` to the month of `toExclusive − 1 day`, inclusive. */
function monthsSpanned(fromDate: string, toDate: string): number {
  const lastDay = addDays(toDate, -1);
  const [fy, fm] = fromDate.split("-").map(Number);
  const [ly, lm] = lastDay.split("-").map(Number);
  return (ly - fy) * 12 + (lm - fm) + 1;
}

export function previousRange(fromDate: string, toDate: string): { prevFromDate: string; prevToDate: string } {
  const days = daysBetween(fromDate, toDate);
  if (fromDate.endsWith("-01-01") && days > 62) {
    return { prevFromDate: shiftMonths(fromDate, -12), prevToDate: shiftMonths(toDate, -12) };
  }
  if (fromDate.endsWith("-01")) {
    const n = monthsSpanned(fromDate, toDate);
    return { prevFromDate: shiftMonths(fromDate, -n), prevToDate: shiftMonths(toDate, -n) };
  }
  return { prevFromDate: addDays(fromDate, -days), prevToDate: fromDate };
}

export function bucketFor(days: number): Bucket {
  if (days <= 45) return "day";
  if (days <= 200) return "week";
  return "month";
}

export function buildPeriod(fromDate: string, toDate: string, timeZone: string): OverviewPeriod {
  const days = daysBetween(fromDate, toDate);
  const { prevFromDate, prevToDate } = previousRange(fromDate, toDate);
  return {
    fromDate,
    toDate,
    prevFromDate,
    prevToDate,
    from: localMidnightUtc(fromDate, timeZone),
    to: localMidnightUtc(toDate, timeZone),
    prevFrom: localMidnightUtc(prevFromDate, timeZone),
    prevTo: localMidnightUtc(prevToDate, timeZone),
    timeZone,
    bucket: bucketFor(days),
  };
}

export function bucketKey(ymd: string, bucket: Bucket): string {
  if (bucket === "day") return ymd;
  if (bucket === "week") return weekStart(ymd);
  return ymd.slice(0, 7);
}

/** Every bucket key covering [fromDate, toDate), in order. */
export function bucketKeys(fromDate: string, toDate: string, bucket: Bucket): string[] {
  const keys: string[] = [];
  for (let day = fromDate; day < toDate; day = addDays(day, 1)) {
    const key = bucketKey(day, bucket);
    if (keys[keys.length - 1] !== key) keys.push(key);
  }
  return keys;
}

// ── Inputs ──────────────────────────────────────────────────────────────────

export interface OverviewInputs {
  /** Succeeded invoice payments received in [prevFrom, to). */
  payments: Array<{ invoiceId: string; amountCents: number; method: string; receivedAt: string; currency: string | null }>;
  /** Quote deposits paid in [prevFrom, to). */
  deposits: Array<{ contactId: string | null; cents: number; paidAt: string; currency: string | null }>;
  /** contact_id of every invoice a payment above belongs to. */
  invoiceContacts: Record<string, string | null>;
  /** Non-draft, non-void invoices issued in [prevFromDate, toDate). */
  issued: Array<{ issueDate: string; totalCents: number; currency: string | null }>;
  /** Open invoices with a balance, right now. */
  open: Array<{ balanceCents: number; pendingCents: number; dueDate: string | null; currency: string | null }>;
  /** Bookings scheduled in [prevFrom, to). */
  bookings: Array<{ scheduledFor: string; status: string; contactId: string | null }>;
  /** Quotes sent or approved in [prevFrom, to) (deduplicated). */
  quotes: Array<{ sentAt: string | null; approvedAt: string | null; status: string; supersededBy: string | null; approvedTotalCents: number | null; totalCents: number }>;
  /** created_at of contacts created in [prevFrom, to). */
  newContacts: string[];
  /** Time entries that started in [prevFrom, to). */
  timeEntries: Array<{ profileId: string; bookingId: string | null; startedAt: string; endedAt: string | null; breakMinutes: number }>;
  rates: Record<string, number | null>;
  people: Record<string, string>;
  contactNames: Record<string, string>;
  /** Expenses dated in [prevFromDate, toDate): pre-tax cost. */
  expenses: Array<{ spentOn: string; cents: number; category: string; onJob: boolean }>;
  /** Paid out of pocket and not paid back yet, right now (amount incl. tax). */
  owedCents: number;
}

export function emptyOverviewInputs(): OverviewInputs {
  return {
    payments: [],
    deposits: [],
    invoiceContacts: {},
    issued: [],
    open: [],
    bookings: [],
    quotes: [],
    newContacts: [],
    timeEntries: [],
    rates: {},
    people: {},
    contactNames: {},
    expenses: [],
    owedCents: 0,
  };
}

// ── Output ──────────────────────────────────────────────────────────────────

export interface Compare {
  value: number;
  previous: number;
}

export interface OverviewReport {
  period: {
    fromDate: string;
    toDate: string;
    prevFromDate: string;
    prevToDate: string;
    timeZone: string;
    bucket: Bucket;
  };
  currency: string;
  money: {
    collected: Compare;
    invoiced: Compare;
    invoicesIssued: Compare;
    averageInvoiceCents: number | null;
    depositsCents: number;
    byMethod: Array<{ method: string; cents: number; count: number }>;
  };
  receivables: {
    outstandingCents: number;
    overdueCents: number;
    inTransitCents: number;
    openInvoices: number;
    overdueInvoices: number;
    aging: Array<{ key: "current" | "1_30" | "31_60" | "61_90" | "90_plus"; label: string; cents: number; count: number }>;
  };
  jobs: {
    completed: Compare;
    scheduled: number;
    upcoming: number;
    cancelled: number;
    noShow: number;
  };
  quotes: {
    sent: Compare;
    won: number;
    stillOpen: number;
    winRate: number | null;
    previousWinRate: number | null;
    approvedCents: Compare;
    approvedCount: number;
  };
  customers: {
    newCustomers: Compare;
    payingCustomers: number;
  };
  crew: {
    minutes: Compare;
    labourCostCents: number | null;
    people: Array<{ profileId: string; name: string; minutes: number; jobs: number; costCents: number | null }>;
    missingRateNames: string[];
  };
  spending: {
    /** Before tax. */
    spent: Compare;
    count: number;
    onJobsCents: number;
    overheadCents: number;
    byCategory: Array<{ category: string; label: string; cents: number; count: number }>;
    owedCents: number;
  };
  series: Array<{ key: string; collectedCents: number; invoicedCents: number; jobsCompleted: number; minutes: number; spentCents: number }>;
  topCustomers: Array<{ contactId: string; name: string; collectedCents: number; jobsCompleted: number }>;
}

const AGING_LABELS = {
  current: "Not yet due",
  "1_30": "1–30 days late",
  "31_60": "31–60 days late",
  "61_90": "61–90 days late",
  "90_plus": "Over 90 days late",
} as const;

function within(iso: string | null | undefined, fromIso: string, toIso: string): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms >= Date.parse(fromIso) && ms < Date.parse(toIso);
}

function mostCommon(values: Array<string | null>, fallback: string): string {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = fallback;
  let bestN = 0;
  for (const [v, n] of counts) if (n > bestN) [best, bestN] = [v, n];
  return best;
}

export function computeOverview(inputs: OverviewInputs, period: OverviewPeriod, now: Date = new Date()): OverviewReport {
  const tz = period.timeZone;
  const today = localDateString(now, tz);
  const cur = (iso: string | null | undefined) => within(iso, period.from, period.to);
  const prev = (iso: string | null | undefined) => within(iso, period.prevFrom, period.prevTo);
  const localDay = (iso: string) => localDateString(new Date(iso), tz);

  const keys = bucketKeys(period.fromDate, period.toDate, period.bucket);
  const series = new Map(keys.map((key) => [key, { key, collectedCents: 0, invoicedCents: 0, jobsCompleted: 0, minutes: 0, spentCents: 0 }]));
  const slot = (iso: string) => series.get(bucketKey(localDay(iso), period.bucket));

  const currency = mostCommon(
    [...inputs.payments.map((p) => p.currency), ...inputs.issued.map((i) => i.currency), ...inputs.open.map((o) => o.currency)],
    "CAD",
  );

  // ── Money in ──
  let collected = 0;
  let prevCollected = 0;
  let deposits = 0;
  const byMethod = new Map<string, { cents: number; count: number }>();
  const byContact = new Map<string, number>();
  const credit = (contactId: string | null | undefined, cents: number) => {
    if (contactId) byContact.set(contactId, (byContact.get(contactId) ?? 0) + cents);
  };
  for (const p of inputs.payments) {
    if (cur(p.receivedAt)) {
      collected += p.amountCents;
      const m = byMethod.get(p.method) ?? { cents: 0, count: 0 };
      m.cents += p.amountCents;
      m.count += 1;
      byMethod.set(p.method, m);
      const s = slot(p.receivedAt);
      if (s) s.collectedCents += p.amountCents;
      credit(inputs.invoiceContacts[p.invoiceId], p.amountCents);
    } else if (prev(p.receivedAt)) prevCollected += p.amountCents;
  }
  for (const d of inputs.deposits) {
    if (cur(d.paidAt)) {
      collected += d.cents;
      deposits += d.cents;
      const s = slot(d.paidAt);
      if (s) s.collectedCents += d.cents;
      credit(d.contactId, d.cents);
    } else if (prev(d.paidAt)) prevCollected += d.cents;
  }
  if (deposits > 0) {
    const m = byMethod.get("deposit") ?? { cents: 0, count: 0 };
    m.cents += deposits;
    m.count += inputs.deposits.filter((d) => cur(d.paidAt)).length;
    byMethod.set("deposit", m);
  }

  let invoiced = 0;
  let prevInvoiced = 0;
  let issuedCount = 0;
  let prevIssuedCount = 0;
  for (const inv of inputs.issued) {
    if (inv.issueDate >= period.fromDate && inv.issueDate < period.toDate) {
      invoiced += inv.totalCents;
      issuedCount += 1;
      const s = series.get(bucketKey(inv.issueDate, period.bucket));
      if (s) s.invoicedCents += inv.totalCents;
    } else if (inv.issueDate >= period.prevFromDate && inv.issueDate < period.prevToDate) {
      prevInvoiced += inv.totalCents;
      prevIssuedCount += 1;
    }
  }

  // ── Receivables (as of today) ──
  const aging = new Map<keyof typeof AGING_LABELS, { cents: number; count: number }>(
    (Object.keys(AGING_LABELS) as Array<keyof typeof AGING_LABELS>).map((k) => [k, { cents: 0, count: 0 }]),
  );
  let outstanding = 0;
  let overdue = 0;
  let overdueCount = 0;
  let inTransit = 0;
  let openCount = 0;
  for (const o of inputs.open) {
    if (o.balanceCents <= 0) continue;
    openCount += 1;
    outstanding += o.balanceCents;
    inTransit += Math.min(o.pendingCents, o.balanceCents);
    const late = o.dueDate && o.dueDate < today ? daysBetween(o.dueDate, today) : 0;
    if (late > 0) {
      overdue += o.balanceCents;
      overdueCount += 1;
    }
    const key = late <= 0 ? "current" : late <= 30 ? "1_30" : late <= 60 ? "31_60" : late <= 90 ? "61_90" : "90_plus";
    const a = aging.get(key)!;
    a.cents += o.balanceCents;
    a.count += 1;
  }

  // ── Jobs ──
  let completed = 0;
  let prevCompleted = 0;
  let scheduled = 0;
  let upcoming = 0;
  let cancelled = 0;
  let noShow = 0;
  const jobsByContact = new Map<string, number>();
  for (const b of inputs.bookings) {
    if (cur(b.scheduledFor)) {
      if (b.status === "cancelled") cancelled += 1;
      else {
        scheduled += 1;
        if (b.status === "completed") {
          completed += 1;
          const s = slot(b.scheduledFor);
          if (s) s.jobsCompleted += 1;
          if (b.contactId) jobsByContact.set(b.contactId, (jobsByContact.get(b.contactId) ?? 0) + 1);
        } else if (b.status === "no_show") noShow += 1;
        else if (Date.parse(b.scheduledFor) >= now.getTime()) upcoming += 1;
      }
    } else if (prev(b.scheduledFor) && b.status === "completed") prevCompleted += 1;
  }

  // ── Quotes ──
  let sent = 0;
  let prevSent = 0;
  let won = 0;
  let prevWon = 0;
  let stillOpen = 0;
  let approvedCents = 0;
  let prevApprovedCents = 0;
  let approvedCount = 0;
  for (const q of inputs.quotes) {
    if (!q.supersededBy) {
      if (cur(q.sentAt)) {
        sent += 1;
        if (q.approvedAt) won += 1;
        else if (q.status === "sent" || q.status === "viewed") stillOpen += 1;
      } else if (prev(q.sentAt)) {
        prevSent += 1;
        if (q.approvedAt) prevWon += 1;
      }
    }
    const value = q.approvedTotalCents ?? q.totalCents;
    if (cur(q.approvedAt)) {
      approvedCents += value;
      approvedCount += 1;
    } else if (prev(q.approvedAt)) prevApprovedCents += value;
  }

  // ── Customers ──
  let newCustomers = 0;
  let prevNewCustomers = 0;
  for (const createdAt of inputs.newContacts) {
    if (cur(createdAt)) newCustomers += 1;
    else if (prev(createdAt)) prevNewCustomers += 1;
  }

  // ── Crew ──
  let minutes = 0;
  let prevMinutes = 0;
  const perPerson = new Map<string, { minutes: number; jobs: Set<string> }>();
  for (const e of inputs.timeEntries) {
    const m = workedMinutes({ started_at: e.startedAt, ended_at: e.endedAt, break_minutes: e.breakMinutes }, now);
    if (cur(e.startedAt)) {
      minutes += m;
      const p = perPerson.get(e.profileId) ?? { minutes: 0, jobs: new Set<string>() };
      p.minutes += m;
      if (e.bookingId) p.jobs.add(e.bookingId);
      perPerson.set(e.profileId, p);
      const s = slot(e.startedAt);
      if (s) s.minutes += m;
    } else if (prev(e.startedAt)) prevMinutes += m;
  }
  const missing: string[] = [];
  let labour = 0;
  const people = [...perPerson.entries()]
    .map(([profileId, p]) => {
      const rate = inputs.rates[profileId];
      const name = inputs.people[profileId] ?? "Team member";
      const costCents = rate === undefined || rate === null ? null : labourCents(p.minutes, rate);
      if (costCents === null) missing.push(name);
      else labour += costCents;
      return { profileId, name, minutes: p.minutes, jobs: p.jobs.size, costCents };
    })
    .sort((a, b) => b.minutes - a.minutes);

  // ── Spending ──
  let spent = 0;
  let prevSpent = 0;
  let spentCount = 0;
  let onJobs = 0;
  const byCategory = new Map<string, { cents: number; count: number }>();
  for (const e of inputs.expenses) {
    if (e.spentOn >= period.fromDate && e.spentOn < period.toDate) {
      spent += e.cents;
      spentCount += 1;
      if (e.onJob) onJobs += e.cents;
      const c = byCategory.get(e.category) ?? { cents: 0, count: 0 };
      c.cents += e.cents;
      c.count += 1;
      byCategory.set(e.category, c);
      const s = series.get(bucketKey(e.spentOn, period.bucket));
      if (s) s.spentCents += e.cents;
    } else if (e.spentOn >= period.prevFromDate && e.spentOn < period.prevToDate) prevSpent += e.cents;
  }

  const topCustomers = [...byContact.entries()]
    .filter(([, cents]) => cents > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([contactId, cents]) => ({
      contactId,
      name: inputs.contactNames[contactId] ?? "Customer",
      collectedCents: cents,
      jobsCompleted: jobsByContact.get(contactId) ?? 0,
    }));

  return {
    period: {
      fromDate: period.fromDate,
      toDate: period.toDate,
      prevFromDate: period.prevFromDate,
      prevToDate: period.prevToDate,
      timeZone: tz,
      bucket: period.bucket,
    },
    currency,
    money: {
      collected: { value: collected, previous: prevCollected },
      invoiced: { value: invoiced, previous: prevInvoiced },
      invoicesIssued: { value: issuedCount, previous: prevIssuedCount },
      averageInvoiceCents: issuedCount ? Math.round(invoiced / issuedCount) : null,
      depositsCents: deposits,
      byMethod: [...byMethod.entries()].map(([method, v]) => ({ method, ...v })).sort((a, b) => b.cents - a.cents),
    },
    receivables: {
      outstandingCents: outstanding,
      overdueCents: overdue,
      inTransitCents: inTransit,
      openInvoices: openCount,
      overdueInvoices: overdueCount,
      aging: [...aging.entries()].map(([key, v]) => ({ key, label: AGING_LABELS[key], ...v })),
    },
    jobs: { completed: { value: completed, previous: prevCompleted }, scheduled, upcoming, cancelled, noShow },
    quotes: {
      sent: { value: sent, previous: prevSent },
      won,
      stillOpen,
      winRate: sent ? won / sent : null,
      previousWinRate: prevSent ? prevWon / prevSent : null,
      approvedCents: { value: approvedCents, previous: prevApprovedCents },
      approvedCount,
    },
    customers: { newCustomers: { value: newCustomers, previous: prevNewCustomers }, payingCustomers: byContact.size },
    crew: {
      minutes: { value: minutes, previous: prevMinutes },
      labourCostCents: people.length === 0 ? null : labour,
      people,
      missingRateNames: missing,
    },
    spending: {
      spent: { value: spent, previous: prevSpent },
      count: spentCount,
      onJobsCents: onJobs,
      overheadCents: spent - onJobs,
      byCategory: [...byCategory.entries()]
        .map(([category, v]) => ({ category, label: categoryLabel(category), ...v }))
        .sort((a, b) => b.cents - a.cents || a.label.localeCompare(b.label)),
      owedCents: inputs.owedCents,
    },
    series: [...series.values()],
    topCustomers,
  };
}
