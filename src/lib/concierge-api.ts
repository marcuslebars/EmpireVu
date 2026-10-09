/** Concierge console API (operator-only; every route 404s for anyone else). */
import { apiFetch } from "@/lib/api-client";
import type { ConciergeAccountDetail, ConciergeAccountSummary, ConciergeActionResponse } from "@/lib/concierge";

export function fetchConciergeAccounts(): Promise<ConciergeAccountSummary[]> {
  return apiFetch<ConciergeAccountSummary[]>("/api/concierge/accounts", { credentials: "include" });
}

export function fetchConciergeAccount(organizationId: string): Promise<ConciergeAccountDetail> {
  return apiFetch<ConciergeAccountDetail>(`/api/concierge/accounts/${encodeURIComponent(organizationId)}`, { credentials: "include" });
}

export function runConciergeAction(
  organizationId: string,
  action: string,
  input: Record<string, unknown> = {},
  companyId?: string | null,
): Promise<ConciergeActionResponse> {
  return apiFetch<ConciergeActionResponse>(`/api/concierge/accounts/${encodeURIComponent(organizationId)}/actions`, {
    method: "POST",
    credentials: "include",
    body: JSON.stringify({ action, input, ...(companyId ? { companyId } : {}) }),
  });
}
