/** Client API + hook for the business overview report (owners/admins). */
import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api-client";

export interface Compare {
  value: number;
  previous: number;
}

export type Bucket = "day" | "week" | "month";

export interface OverviewReport {
  period: { fromDate: string; toDate: string; prevFromDate: string; prevToDate: string; timeZone: string; bucket: Bucket };
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
  jobs: { completed: Compare; scheduled: number; upcoming: number; cancelled: number; noShow: number };
  quotes: {
    sent: Compare;
    won: number;
    stillOpen: number;
    winRate: number | null;
    previousWinRate: number | null;
    approvedCents: Compare;
    approvedCount: number;
  };
  customers: { newCustomers: Compare; payingCustomers: number };
  crew: {
    minutes: Compare;
    labourCostCents: number | null;
    people: Array<{ profileId: string; name: string; minutes: number; jobs: number; costCents: number | null }>;
    missingRateNames: string[];
  };
  series: Array<{ key: string; collectedCents: number; invoicedCents: number; jobsCompleted: number; minutes: number }>;
  topCustomers: Array<{ contactId: string; name: string; collectedCents: number; jobsCompleted: number }>;
}

export interface OverviewQuery {
  /** YYYY-MM-DD, inclusive. */
  from: string;
  /** YYYY-MM-DD, exclusive. */
  to: string;
  companyId?: string | null;
}

export function fetchOverview(orgId: string, q: OverviewQuery): Promise<OverviewReport> {
  const params = new URLSearchParams({ from: q.from, to: q.to });
  if (q.companyId) params.set("companyId", q.companyId);
  return apiFetch<OverviewReport>(`/api/organizations/${orgId}/reports/overview?${params.toString()}`);
}

export function useOverview(orgId: string, q: OverviewQuery, enabled: boolean) {
  return useQuery({
    queryKey: ["reports", "overview", orgId, q],
    queryFn: () => fetchOverview(orgId, q),
    enabled: Boolean(orgId) && enabled,
    staleTime: 60_000,
  });
}

// ── Date ranges (local calendar dates; `to` is exclusive) ─────────────────────

export type Preset = "this_month" | "last_month" | "last_30" | "this_quarter" | "last_quarter" | "ytd" | "last_12" | "custom";

export const PRESETS: Array<{ id: Preset; label: string }> = [
  { id: "this_month", label: "This month" },
  { id: "last_month", label: "Last month" },
  { id: "last_30", label: "Last 30 days" },
  { id: "this_quarter", label: "This quarter" },
  { id: "last_quarter", label: "Last quarter" },
  { id: "ytd", label: "Year to date" },
  { id: "last_12", label: "Last 12 months" },
  { id: "custom", label: "Custom" },
];

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDaysYmd(value: string, days: number): string {
  const [y, m, d] = value.split("-").map(Number);
  return ymd(new Date(y, m - 1, d + days));
}

export function presetRange(preset: Exclude<Preset, "custom">, today: Date = new Date()): { from: string; to: string } {
  const y = today.getFullYear();
  const m = today.getMonth();
  const tomorrow = ymd(new Date(y, m, today.getDate() + 1));
  const q = Math.floor(m / 3) * 3;
  switch (preset) {
    case "this_month":
      return { from: ymd(new Date(y, m, 1)), to: ymd(new Date(y, m + 1, 1)) };
    case "last_month":
      return { from: ymd(new Date(y, m - 1, 1)), to: ymd(new Date(y, m, 1)) };
    case "last_30":
      return { from: ymd(new Date(y, m, today.getDate() - 29)), to: tomorrow };
    case "this_quarter":
      return { from: ymd(new Date(y, q, 1)), to: ymd(new Date(y, q + 3, 1)) };
    case "last_quarter":
      return { from: ymd(new Date(y, q - 3, 1)), to: ymd(new Date(y, q, 1)) };
    case "ytd":
      return { from: ymd(new Date(y, 0, 1)), to: tomorrow };
    case "last_12":
      return { from: ymd(new Date(y, m - 11, 1)), to: ymd(new Date(y, m + 1, 1)) };
  }
}

/** Percent change, or null when there's nothing to compare with. */
export function change(c: Compare): number | null {
  if (c.previous === 0) return null;
  return (c.value - c.previous) / Math.abs(c.previous);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 1" / "Oct 1, 2025" from YYYY-MM-DD. */
export function shortDate(value: string, withYear = false): string {
  const [y, m, d] = value.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}${withYear ? `, ${y}` : ""}`;
}

/** "Oct 1 – Oct 31, 2026" for an inclusive-from / exclusive-to range. */
export function rangeLabel(from: string, toExclusive: string): string {
  const last = addDaysYmd(toExclusive, -1);
  if (from === last) return shortDate(from, true);
  const sameYear = from.slice(0, 4) === last.slice(0, 4);
  return `${shortDate(from, !sameYear)} – ${shortDate(last, true)}`;
}

export function bucketLabel(key: string, bucket: Bucket): string {
  if (bucket === "month") {
    const [y, m] = key.split("-").map(Number);
    return `${MONTHS[m - 1]} ${String(y).slice(2)}`;
  }
  return shortDate(key);
}

export const METHOD_LABELS: Record<string, string> = {
  card: "Card",
  bank_debit: "Bank debit (PAD)",
  etransfer: "e-Transfer",
  cheque: "Cheque",
  cash: "Cash",
  other: "Other",
  deposit: "Quote deposits",
};

function csvCell(v: string | number | null): string {
  const s = v === null ? "" : String(v);
  return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The report as a spreadsheet: headline figures, then the time series. */
export function overviewCsv(r: OverviewReport): string {
  const money = (c: number | null) => (c === null ? null : (c / 100).toFixed(2));
  const rows: Array<Array<string | number | null>> = [
    ["Metric", "This period", "Previous period"],
    ["Collected", money(r.money.collected.value), money(r.money.collected.previous)],
    ["Invoiced", money(r.money.invoiced.value), money(r.money.invoiced.previous)],
    ["Invoices issued", r.money.invoicesIssued.value, r.money.invoicesIssued.previous],
    ["Jobs completed", r.jobs.completed.value, r.jobs.completed.previous],
    ["Quotes sent", r.quotes.sent.value, r.quotes.sent.previous],
    ["Quote value approved", money(r.quotes.approvedCents.value), money(r.quotes.approvedCents.previous)],
    ["New customers", r.customers.newCustomers.value, r.customers.newCustomers.previous],
    ["Crew hours", (r.crew.minutes.value / 60).toFixed(2), (r.crew.minutes.previous / 60).toFixed(2)],
    ["Owed to you (today)", money(r.receivables.outstandingCents), null],
    ["Overdue (today)", money(r.receivables.overdueCents), null],
    [],
    ["Period starting", "Collected", "Invoiced", "Jobs completed", "Crew hours"],
    ...r.series.map((s) => [s.key, money(s.collectedCents), money(s.invoicedCents), s.jobsCompleted, (s.minutes / 60).toFixed(2)]),
  ];
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}
