/** QuickBooks / Xero sync: client API + hooks (Settings → Accounting). */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api-client";

export type ProviderId = "quickbooks" | "xero";

export interface Ref {
  id: string;
  name: string;
  kind?: string | null;
}

export const EXPENSE_CATEGORY_KEYS = [
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
export type CategoryKey = (typeof EXPENSE_CATEGORY_KEYS)[number];

export interface AccountingSettings {
  syncInvoices: boolean;
  syncExpenses: boolean;
  incomeTarget: Ref | null;
  salesTaxCode: Ref | null;
  salesExemptCode: Ref | null;
  paymentAccount: Ref | null;
  expenseAccounts: Partial<Record<CategoryKey, Ref>>;
  expenseFallbackAccount: Ref | null;
  purchaseTaxCode: Ref | null;
  purchaseExemptCode: Ref | null;
  paidFromBusiness: Ref | null;
  paidFromPersonal: Ref | null;
  country?: string | null;
  currency?: string | null;
}

export interface AccountingJob {
  id: string;
  entityType: "invoice" | "payment" | "expense";
  entityId: string;
  label: string;
  status: "pending" | "running" | "done" | "skipped" | "failed";
  detail: string | null;
  lastError: string | null;
  attempts: number;
  updatedAt: string;
}

export interface AccountingStatus {
  companyId: string;
  providers: Array<{ id: ProviderId; label: string; configured: boolean }>;
  connection: null | {
    provider: ProviderId;
    providerLabel: string;
    remoteName: string | null;
    status: "active" | "needs_reauth";
    environment: string;
    connectedAt: string;
    lastSyncAt: string | null;
    lastError: string | null;
    syncStartDate: string;
    settings: AccountingSettings;
    missing: { invoices: string[]; expenses: string[] };
  };
  counts: { pending: number; failed: number; synced: number };
  recent: AccountingJob[];
}

export interface ProviderOptions {
  incomeTargets: Ref[];
  salesTaxCodes: Ref[];
  purchaseTaxCodes: Ref[];
  depositAccounts: Ref[];
  paidFromAccounts: Ref[];
  expenseAccounts: Ref[];
}

export interface SyncState {
  provider: string;
  status: "synced" | "pending" | "failed" | "not_synced";
  note: string | null;
  syncedAt: string | null;
  error: string | null;
}

const base = (orgId: string, companyId: string) => `/api/organizations/${orgId}/accounting/${companyId}`;
const KEY = "accounting";

export function useAccountingStatus(orgId: string, companyId: string | null) {
  return useQuery({
    queryKey: [KEY, "status", orgId, companyId],
    queryFn: () => apiFetch<AccountingStatus>(base(orgId, companyId as string)),
    enabled: Boolean(orgId && companyId),
    // Keep the activity list moving while work is queued.
    refetchInterval: (q) => ((q.state.data as AccountingStatus | undefined)?.counts.pending ? 8_000 : false),
  });
}

export function useAccountingOptions(orgId: string, companyId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: [KEY, "options", orgId, companyId],
    queryFn: () => apiFetch<{ options: ProviderOptions; suggested: Partial<AccountingSettings> }>(`${base(orgId, companyId as string)}/options`),
    enabled: Boolean(orgId && companyId) && enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

function useStatusSetter(orgId: string, companyId: string) {
  const qc = useQueryClient();
  return (data?: AccountingStatus) => {
    if (data) qc.setQueryData([KEY, "status", orgId, companyId], data);
    else void qc.invalidateQueries({ queryKey: [KEY] });
  };
}

export function useConnectAccounting(orgId: string, companyId: string) {
  return useMutation({
    mutationFn: (provider: ProviderId) => apiFetch<{ url: string }>(`${base(orgId, companyId)}/connect`, { method: "POST", body: JSON.stringify({ provider }) }),
    onSuccess: ({ url }) => {
      window.location.assign(url);
    },
  });
}

export function useDisconnectAccounting(orgId: string, companyId: string) {
  const set = useStatusSetter(orgId, companyId);
  return useMutation({ mutationFn: () => apiFetch<{ ok: true }>(`${base(orgId, companyId)}/disconnect`, { method: "POST" }), onSuccess: () => set() });
}

export function useSaveAccountingSettings(orgId: string, companyId: string) {
  const set = useStatusSetter(orgId, companyId);
  return useMutation({
    mutationFn: (body: { settings?: Partial<AccountingSettings>; syncStartDate?: string }) =>
      apiFetch<AccountingStatus>(base(orgId, companyId), { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: (data) => set(data),
  });
}

export function useSyncNow(orgId: string, companyId: string) {
  const set = useStatusSetter(orgId, companyId);
  return useMutation({ mutationFn: () => apiFetch<{ queued: number }>(`${base(orgId, companyId)}/sync`, { method: "POST" }), onSuccess: () => set() });
}

export function useSyncState(orgId: string, companyId: string | null | undefined, type: "invoice" | "expense", id: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: [KEY, "state", orgId, companyId, type, id],
    queryFn: () => apiFetch<SyncState | null>(`${base(orgId, companyId as string)}/state?type=${type}&id=${id}`),
    enabled: Boolean(orgId && companyId && id) && enabled,
    staleTime: 15_000,
  });
}
