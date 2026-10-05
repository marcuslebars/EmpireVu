/**
 * Expenses & receipts — the pure parts: categories, input validation, receipt paths,
 * totals and CSV rows. Money is integer cents; `amountCents` is what was paid with tax
 * included and `taxCents` the sales tax inside it. Job costing and reports use the
 * pre-tax cost (amount − tax), because a tax-registered business claims that tax back,
 * and revenue on the same reports is also counted before tax.
 */
import { z } from "zod";

export const EXPENSE_CATEGORIES = [
  "materials",
  "fuel",
  "equipment",
  "tools",
  "subcontractor",
  "vehicle",
  "insurance",
  "office",
  "marketing",
  "meals",
  "travel",
  "utilities",
  "fees",
  "other",
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  materials: "Materials & supplies",
  fuel: "Fuel",
  equipment: "Equipment rental",
  tools: "Tools",
  subcontractor: "Subcontractors",
  vehicle: "Vehicle & repairs",
  insurance: "Insurance",
  office: "Office & software",
  marketing: "Marketing",
  meals: "Meals",
  travel: "Travel & parking",
  utilities: "Phone & utilities",
  fees: "Bank & card fees",
  other: "Other",
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category as ExpenseCategory] ?? "Other";
}

export const RECEIPT_TYPES = ["image/jpeg", "application/pdf"] as const;
export type ReceiptType = (typeof RECEIPT_TYPES)[number];

/** Longest window the list / export / summary will read in one go. */
export const MAX_RANGE_DAYS = 731;

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-05.");
const cents = z.number().int().min(0).max(100_000_000);

export const receiptRefSchema = z.object({
  path: z.string().max(512),
  type: z.enum(RECEIPT_TYPES),
});

const baseExpenseSchema = z.object({
  spentOn: ymd,
  vendor: z.string().trim().max(200).nullish(),
  description: z.string().trim().max(1000).nullish(),
  category: z.enum(EXPENSE_CATEGORIES).default("other"),
  amountCents: cents.refine((v) => v > 0, "Enter what it cost."),
  taxCents: cents.default(0),
  paidWith: z.enum(["business", "personal"]).default("business"),
  billable: z.boolean().default(false),
  bookingId: z.string().uuid().nullish(),
  companyId: z.string().uuid().nullish(),
  receipt: receiptRefSchema.nullish(),
});

export const expenseCreateSchema = baseExpenseSchema
  .refine((v) => v.taxCents <= v.amountCents, { message: "Tax can't be more than the total.", path: ["taxCents"] })
  .refine((v) => !v.billable || Boolean(v.bookingId), { message: "Only an expense on a job can be billed to the customer.", path: ["billable"] });

/** Every field optional; the cross-field rules are re-checked against the merged row. */
export const expenseUpdateSchema = baseExpenseSchema.partial().extend({
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  taxCents: cents.optional(),
  paidWith: z.enum(["business", "personal"]).optional(),
  billable: z.boolean().optional(),
});

export type ExpenseCreateInput = z.output<typeof expenseCreateSchema>;
export type ExpenseUpdateInput = z.output<typeof expenseUpdateSchema>;

export const expenseListQuerySchema = z
  .object({
    from: ymd,
    to: ymd,
    category: z.enum(EXPENSE_CATEGORIES).nullish(),
    bookingId: z.string().uuid().nullish(),
    profileId: z.string().uuid().nullish(),
    companyId: z.string().uuid().nullish(),
    /** "job" = on a job, "overhead" = not on a job. */
    kind: z.enum(["job", "overhead"]).nullish(),
    /** Paid out of pocket and not yet paid back. */
    owed: z.boolean().nullish(),
    q: z.string().trim().max(100).nullish(),
  })
  .refine((v) => v.from <= v.to, { message: "The start date must be before the end date.", path: ["to"] })
  // One job's expenses are few, whatever their dates; any other list stays within two years.
  .refine((v) => Boolean(v.bookingId) || dayDiff(v.from, v.to) <= MAX_RANGE_DAYS, { message: "Pick a range of two years or less.", path: ["to"] });

export type ExpenseListQuery = z.output<typeof expenseListQuerySchema>;

export function dayDiff(fromYmd: string, toYmd: string): number {
  return Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86_400_000);
}

// ── Receipt paths ────────────────────────────────────────────────────────────

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export function receiptPathFor(organizationId: string, receiptId: string, type: ReceiptType): string {
  return `${organizationId}/${receiptId}.${type === "application/pdf" ? "pdf" : "jpg"}`;
}

/** The receipt's type when `path` is a receipt of this organization, else null. */
export function receiptTypeOfPath(organizationId: string, path: string): ReceiptType | null {
  const m = new RegExp(`^${organizationId.toLowerCase()}/${UUID}\\.(jpg|pdf)$`).exec(path.toLowerCase());
  if (!m || path !== path.toLowerCase()) return null;
  return m[1] === "pdf" ? "application/pdf" : "image/jpeg";
}

// ── Money ────────────────────────────────────────────────────────────────────

/** What the expense cost the business before (recoverable) sales tax. */
export function preTaxCents(e: { amount_cents: number; tax_cents: number }): number {
  return Math.max(0, e.amount_cents - e.tax_cents);
}

export interface SummaryRow {
  category: string;
  amount_cents: number;
  tax_cents: number;
  paid_with: string;
  reimbursed_at: string | null;
  booking_id: string | null;
  created_by: string | null;
}

export interface ExpenseSummary {
  count: number;
  totalCents: number;
  taxCents: number;
  preTaxCents: number;
  onJobsCents: number;
  overheadCents: number;
  byCategory: Array<{ category: string; label: string; cents: number; count: number }>;
  /** Paid out of pocket and not paid back yet, per person (amount incl. tax — that's what they're owed). */
  owed: Array<{ profileId: string | null; cents: number; count: number }>;
  owedCents: number;
}

/** Totals for a set of expenses. Category amounts are pre-tax; "owed" is the full amount paid. */
export function summarizeExpenses(rows: SummaryRow[]): ExpenseSummary {
  const byCat = new Map<string, { cents: number; count: number }>();
  const owed = new Map<string | null, { cents: number; count: number }>();
  let total = 0;
  let tax = 0;
  let onJobs = 0;
  for (const r of rows) {
    const pre = preTaxCents(r);
    total += r.amount_cents;
    tax += r.tax_cents;
    if (r.booking_id) onJobs += pre;
    const c = byCat.get(r.category) ?? { cents: 0, count: 0 };
    c.cents += pre;
    c.count += 1;
    byCat.set(r.category, c);
    if (r.paid_with === "personal" && !r.reimbursed_at) {
      const o = owed.get(r.created_by) ?? { cents: 0, count: 0 };
      o.cents += r.amount_cents;
      o.count += 1;
      owed.set(r.created_by, o);
    }
  }
  const pre = total - tax;
  const owedList = [...owed.entries()].map(([profileId, v]) => ({ profileId, ...v })).sort((a, b) => b.cents - a.cents);
  return {
    count: rows.length,
    totalCents: total,
    taxCents: tax,
    preTaxCents: pre,
    onJobsCents: onJobs,
    overheadCents: pre - onJobs,
    byCategory: [...byCat.entries()]
      .map(([category, v]) => ({ category, label: categoryLabel(category), ...v }))
      .sort((a, b) => b.cents - a.cents || a.label.localeCompare(b.label)),
    owed: owedList,
    owedCents: owedList.reduce((s, o) => s + o.cents, 0),
  };
}

/** The invoice line for a billable expense: at cost before tax (the invoice adds its own tax). */
export function billableLine(e: { vendor: string | null; description: string | null; category: string; amount_cents: number; tax_cents: number }): {
  label: string;
  description: string | null;
  quantity: number;
  unitPriceCents: number;
} {
  const what = e.description?.trim() || categoryLabel(e.category);
  const label = e.vendor?.trim() ? `${what} (${e.vendor.trim()})` : what;
  return { label: label.slice(0, 200), description: null, quantity: 1, unitPriceCents: preTaxCents(e) };
}

// ── CSV ──────────────────────────────────────────────────────────────────────

/** CSV-safe cell (quotes, commas, newlines; neutralises spreadsheet formulas). */
export function csvCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const dollars = (c: number) => (c / 100).toFixed(2);

export const CSV_HEADER = ["Date", "Vendor", "Description", "Category", "Total", "Tax", "Before tax", "Job", "Paid with", "Reimbursed", "Billable", "Logged by", "Receipt"];

export function csvRow(e: {
  spentOn: string;
  vendor: string | null;
  description: string | null;
  category: string;
  amountCents: number;
  taxCents: number;
  jobTitle: string | null;
  paidWith: string;
  reimbursedAt: string | null;
  billable: boolean;
  personName: string | null;
  hasReceipt: boolean;
}): string {
  return [
    csvCell(e.spentOn),
    csvCell(e.vendor),
    csvCell(e.description),
    csvCell(categoryLabel(e.category)),
    csvCell(dollars(e.amountCents)),
    csvCell(dollars(e.taxCents)),
    csvCell(dollars(e.amountCents - e.taxCents)),
    csvCell(e.jobTitle),
    csvCell(e.paidWith === "personal" ? "Out of pocket" : "Business"),
    csvCell(e.paidWith === "personal" ? (e.reimbursedAt ? e.reimbursedAt.slice(0, 10) : "Owed") : ""),
    csvCell(e.billable ? "Yes" : ""),
    csvCell(e.personName),
    csvCell(e.hasReceipt ? "Yes" : "No"),
  ].join(",");
}

// ── Receipt reading (AI) ─────────────────────────────────────────────────────

export const receiptScanSchema = z.object({
  vendor: z.string().max(200).nullable(),
  date: z.string().nullable(),
  totalCents: z.number().int().nullable(),
  taxCents: z.number().int().nullable(),
  category: z.string().nullable(),
  description: z.string().max(1000).nullable(),
});

export interface ReceiptScan {
  vendor: string | null;
  spentOn: string | null;
  amountCents: number | null;
  taxCents: number | null;
  category: ExpenseCategory | null;
  description: string | null;
}

/**
 * Clean up what the model read: a date must be a real YYYY-MM-DD within a year of today
 * (or a week ahead), money must be positive and tax no more than the total, and the
 * category must be one of ours. Anything doubtful comes back null for the person to fill.
 */
export function cleanReceiptScan(raw: z.infer<typeof receiptScanSchema>, today: string): ReceiptScan {
  let spentOn: string | null = null;
  if (raw.date && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) && !Number.isNaN(Date.parse(`${raw.date}T00:00:00Z`))) {
    const age = dayDiff(raw.date, today);
    if (age >= -7 && age <= 366 && new Date(`${raw.date}T00:00:00Z`).toISOString().slice(0, 10) === raw.date) spentOn = raw.date;
  }
  const amount = raw.totalCents !== null && raw.totalCents > 0 && raw.totalCents <= 100_000_000 ? raw.totalCents : null;
  const tax = raw.taxCents !== null && raw.taxCents >= 0 && (amount === null || raw.taxCents <= amount) ? raw.taxCents : null;
  const category = raw.category && (EXPENSE_CATEGORIES as readonly string[]).includes(raw.category) ? (raw.category as ExpenseCategory) : null;
  return {
    vendor: raw.vendor?.trim().slice(0, 200) || null,
    spentOn,
    amountCents: amount,
    taxCents: tax,
    category,
    description: raw.description?.trim().slice(0, 1000) || null,
  };
}
