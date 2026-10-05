/** Expenses & receipts: client API + hooks. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiAuthHeaders, apiFetch, resolveApiUrl } from "@/lib/api-client";
import { toJpeg } from "@/lib/jobs-api";
import { supabase } from "@/lib/supabase";

export const EXPENSE_CATEGORIES = [
  { value: "materials", label: "Materials & supplies" },
  { value: "fuel", label: "Fuel" },
  { value: "equipment", label: "Equipment rental" },
  { value: "tools", label: "Tools" },
  { value: "subcontractor", label: "Subcontractors" },
  { value: "vehicle", label: "Vehicle & repairs" },
  { value: "insurance", label: "Insurance" },
  { value: "office", label: "Office & software" },
  { value: "marketing", label: "Marketing" },
  { value: "meals", label: "Meals" },
  { value: "travel", label: "Travel & parking" },
  { value: "utilities", label: "Phone & utilities" },
  { value: "fees", label: "Bank & card fees" },
  { value: "other", label: "Other" },
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]["value"];

export function categoryLabel(value: string): string {
  return EXPENSE_CATEGORIES.find((c) => c.value === value)?.label ?? "Other";
}

export type ReceiptType = "image/jpeg" | "application/pdf";

export interface Expense {
  id: string;
  spentOn: string;
  vendor: string | null;
  description: string | null;
  category: ExpenseCategory;
  amountCents: number;
  taxCents: number;
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
  receiptType: ReceiptType | null;
  createdBy: string | null;
  personName: string | null;
  createdAt: string;
  canEdit: boolean;
}

export interface ExpenseSummary {
  count: number;
  totalCents: number;
  taxCents: number;
  preTaxCents: number;
  onJobsCents: number;
  overheadCents: number;
  byCategory: Array<{ category: string; label: string; cents: number; count: number }>;
  owed: Array<{ profileId: string | null; cents: number; count: number }>;
  owedCents: number;
  owedNames: Record<string, string>;
}

export interface ExpenseList {
  expenses: Expense[];
  summary: ExpenseSummary;
  truncated: boolean;
  canManage: boolean;
}

export interface ExpenseQuery {
  from: string;
  to: string;
  category?: string | null;
  bookingId?: string | null;
  profileId?: string | null;
  companyId?: string | null;
  kind?: "job" | "overhead" | null;
  owed?: boolean | null;
  q?: string | null;
}

export interface ExpensePayload {
  spentOn: string;
  vendor: string | null;
  description: string | null;
  category: ExpenseCategory;
  amountCents: number;
  taxCents: number;
  paidWith: "business" | "personal";
  billable: boolean;
  bookingId: string | null;
  companyId?: string | null;
  /** Omit to keep the current receipt; null removes it. */
  receipt?: { path: string; type: ReceiptType } | null;
}

export interface ReceiptScan {
  vendor: string | null;
  spentOn: string | null;
  amountCents: number | null;
  taxCents: number | null;
  category: ExpenseCategory | null;
  description: string | null;
}

const base = (orgId: string) => `/api/organizations/${orgId}/expenses`;

function qs(q: ExpenseQuery): string {
  const p = new URLSearchParams({ from: q.from, to: q.to });
  for (const k of ["category", "bookingId", "profileId", "companyId", "kind", "q"] as const) if (q[k]) p.set(k, String(q[k]));
  if (q.owed) p.set("owed", "true");
  return p.toString();
}

export const fetchExpenses = (orgId: string, q: ExpenseQuery) => apiFetch<ExpenseList>(`${base(orgId)}?${qs(q)}`);
export const createExpense = (orgId: string, body: ExpensePayload) => apiFetch<Expense>(base(orgId), { method: "POST", body: JSON.stringify(body) });
export const updateExpense = (orgId: string, id: string, body: Partial<ExpensePayload>) =>
  apiFetch<Expense>(`${base(orgId)}/${id}`, { method: "PATCH", body: JSON.stringify(body) });
export const deleteExpense = (orgId: string, id: string) => apiFetch<{ ok: true }>(`${base(orgId)}/${id}`, { method: "DELETE" });
export const setReimbursed = (orgId: string, ids: string[], reimbursed: boolean) =>
  apiFetch<{ updated: number }>(`${base(orgId)}/reimburse`, { method: "POST", body: JSON.stringify({ ids, reimbursed }) });
export const scanReceipt = (orgId: string, path: string) => apiFetch<ReceiptScan>(`${base(orgId)}/receipt-scan`, { method: "POST", body: JSON.stringify({ path }) });

/** Photo → JPEG (resized, EXIF/GPS stripped); PDF as-is. Returns the stored path. */
export async function uploadReceipt(orgId: string, file: File): Promise<{ path: string; type: ReceiptType }> {
  if (!supabase) throw new Error("Receipt uploads aren't available right now.");
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (isPdf && file.size > 10 * 1024 * 1024) throw new Error("That PDF is over 10 MB.");
  const type: ReceiptType = isPdf ? "application/pdf" : "image/jpeg";
  const blob = isPdf ? file : (await toJpeg(file)).blob;
  const upload = await apiFetch<{ path: string; token: string }>(`${base(orgId)}/receipt-upload`, {
    method: "POST",
    body: JSON.stringify({ type, receiptId: crypto.randomUUID() }),
  });
  const { error } = await supabase.storage.from("expense-receipts").uploadToSignedUrl(upload.path, upload.token, blob, { contentType: type, upsert: true });
  if (error) throw new Error(error.message || "Upload failed.");
  return { path: upload.path, type };
}

export async function downloadExpensesCsv(orgId: string, q: ExpenseQuery): Promise<void> {
  const res = await fetch(resolveApiUrl(`${base(orgId)}/export?${qs(q)}`), { headers: await apiAuthHeaders() });
  if (!res.ok) throw new Error(`Export failed (${res.status}).`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = `expenses-${q.from}-to-${q.to}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Hooks ────────────────────────────────────────────────────────────────────

const KEY = "expenses";

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: [KEY] });
    void qc.invalidateQueries({ queryKey: ["time"] }); // job profit
    void qc.invalidateQueries({ queryKey: ["reports"] });
  };
}

export function useExpenses(orgId: string, q: ExpenseQuery, enabled = true) {
  return useQuery({ queryKey: [KEY, orgId, q], queryFn: () => fetchExpenses(orgId, q), enabled: Boolean(orgId) && enabled, staleTime: 15_000 });
}

export function useSaveExpense(orgId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { id?: string; payload: ExpensePayload }) => (v.id ? updateExpense(orgId, v.id, v.payload) : createExpense(orgId, v.payload)),
    onSuccess: invalidate,
  });
}

export function useDeleteExpense(orgId: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => deleteExpense(orgId, id), onSuccess: invalidate });
}

export function useSetReimbursed(orgId: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (v: { ids: string[]; reimbursed: boolean }) => setReimbursed(orgId, v.ids, v.reimbursed), onSuccess: invalidate });
}
