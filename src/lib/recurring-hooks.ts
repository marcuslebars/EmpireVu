import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createRecurringJob,
  fetchRecurringJob,
  fetchRecurringJobs,
  setRecurringJobStatus,
  updateRecurringJob,
  type RecurringJob,
  type RecurringJobPayload,
} from "./recurring-api";

const KEY = "recurring-jobs";

/** A series change adds or removes visits: refresh the calendar and job lists too. */
function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: [KEY] });
    void qc.invalidateQueries({ queryKey: ["calendar"] });
    void qc.invalidateQueries({ queryKey: ["jobs"] });
  };
}

export function useRecurringJobs(orgId: string, companyId?: string | null) {
  return useQuery({
    queryKey: [KEY, "list", orgId, companyId ?? null],
    queryFn: () => fetchRecurringJobs(orgId, companyId),
    enabled: Boolean(orgId),
    staleTime: 30_000,
  });
}

export function useRecurringJob(orgId: string, id: string | null | undefined) {
  return useQuery({
    queryKey: [KEY, "one", orgId, id],
    queryFn: () => fetchRecurringJob(orgId, id as string),
    enabled: Boolean(orgId && id),
  });
}

export function useSaveRecurringJob(orgId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { id?: string; payload: RecurringJobPayload }) =>
      v.id ? updateRecurringJob(orgId, v.id, v.payload) : createRecurringJob(orgId, v.payload),
    onSuccess: invalidate,
  });
}

export function useSetRecurringStatus(orgId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: string; status: RecurringJob["status"] }) => setRecurringJobStatus(orgId, v.id, v.status),
    onSuccess: invalidate,
  });
}
