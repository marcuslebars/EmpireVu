/** Owner approvals (docs/front-desk-ai.md "## Owner by text"): the dashboard list + Approve / Skip. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api-client";

export interface ApprovalItem {
  id: string;
  companyId: string;
  companyName: string | null;
  contactId: string | null;
  kind: string;
  summary: string;
  status: string;
  shortCode: number | null;
  createdAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
  decidedVia: string | null;
  resultMessage: string | null;
}

export interface ApprovalList {
  pending: ApprovalItem[];
  recent: ApprovalItem[];
}

export interface DecideResponse {
  outcome: "done" | "already" | "expired" | "not_found";
  message: string;
}

const KEY = "approvals";

export function fetchApprovals(orgId: string, companyId?: string | null): Promise<ApprovalList> {
  const q = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
  return apiFetch<ApprovalList>(`/api/organizations/${orgId}/approvals${q}`);
}

export const decideApproval = (orgId: string, id: string, decision: "approve" | "skip") =>
  apiFetch<DecideResponse>(`/api/organizations/${orgId}/approvals/${id}/decide`, { method: "POST", body: JSON.stringify({ decision }) });

export function useApprovals(orgId: string, companyId?: string | null) {
  return useQuery({
    queryKey: [KEY, orgId, companyId ?? null],
    queryFn: () => fetchApprovals(orgId, companyId),
    enabled: Boolean(orgId),
    refetchInterval: 60_000,
  });
}

export function useDecideApproval(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; decision: "approve" | "skip" }) => decideApproval(orgId, input.id, input.decision),
    onSettled: () => qc.invalidateQueries({ queryKey: [KEY, orgId] }),
  });
}
