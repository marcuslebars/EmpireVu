/**
 * React Query hooks for crew dispatch. Any change to a job refreshes the job lists,
 * that job's sheet, and the calendar (crew shows there too).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  addChecklistItems,
  applyChecklistTemplate,
  completeJob,
  createChecklistTemplate,
  deleteChecklistItem,
  deleteChecklistTemplate,
  fetchChecklistTemplates,
  fetchJob,
  fetchJobPhotos,
  fetchJobs,
  markJobEnRoute,
  setJobCrew,
  startJob,
  toggleChecklistItem,
  updateChecklistTemplate,
  updateJob,
  uploadJobPhoto,
  type ChecklistItem,
  type FetchJobsOptions,
  type JobSheet,
} from "./jobs-api";

const JOBS = "jobs";
const TEMPLATES = "checklist-templates";

function useInvalidateJob(orgId: string, bookingId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: [JOBS] });
    void qc.invalidateQueries({ queryKey: ["calendar"] });
    void qc.invalidateQueries({ queryKey: [JOBS, "sheet", orgId, bookingId] });
  };
}

export function useJobs(orgId: string, opts: FetchJobsOptions, enabled = true) {
  return useQuery({
    queryKey: [JOBS, "list", orgId, opts],
    queryFn: () => fetchJobs(orgId, opts),
    enabled: Boolean(orgId) && enabled,
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
}

export function useJob(orgId: string, bookingId: string | null | undefined) {
  return useQuery({
    queryKey: [JOBS, "sheet", orgId, bookingId],
    queryFn: () => fetchJob(orgId, bookingId as string),
    enabled: Boolean(orgId && bookingId),
    staleTime: 10_000,
  });
}

/** Write the fresh sheet straight into the cache so the screen updates without a refetch. */
function useSheetMutation<V>(orgId: string, bookingId: string, fn: (vars: V) => Promise<JobSheet>) {
  const qc = useQueryClient();
  const invalidate = useInvalidateJob(orgId, bookingId);
  return useMutation({
    mutationFn: fn,
    onSuccess: (sheet) => {
      qc.setQueryData([JOBS, "sheet", orgId, bookingId], sheet);
      invalidate();
    },
  });
}

/** Checklist changes return the list; patch it into the cached sheet. */
function useChecklistMutation<V>(orgId: string, bookingId: string, fn: (vars: V) => Promise<ChecklistItem[]>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (items) => {
      qc.setQueryData<JobSheet | undefined>([JOBS, "sheet", orgId, bookingId], (prev) =>
        prev ? { ...prev, checklistItems: items, checklist: { done: items.filter((i) => i.doneAt).length, total: items.length } } : prev,
      );
      void qc.invalidateQueries({ queryKey: [JOBS, "list"] });
    },
  });
}

export function useUpdateJob(orgId: string, bookingId: string) {
  return useSheetMutation(orgId, bookingId, (patch: { location?: string | null; description?: string | null }) =>
    updateJob(orgId, bookingId, patch),
  );
}

export function useSetJobCrew(orgId: string, bookingId: string) {
  const invalidate = useInvalidateJob(orgId, bookingId);
  return useMutation({
    mutationFn: (profileIds: string[]) => setJobCrew(orgId, bookingId, profileIds),
    onSuccess: invalidate,
  });
}

export function useJobEnRoute(orgId: string, bookingId: string) {
  return useSheetMutation(orgId, bookingId, () => markJobEnRoute(orgId, bookingId));
}

export function useStartJob(orgId: string, bookingId: string) {
  return useSheetMutation(orgId, bookingId, () => startJob(orgId, bookingId));
}

export function useCompleteJob(orgId: string, bookingId: string) {
  const qc = useQueryClient();
  return useSheetMutation(orgId, bookingId, async (force: boolean) => {
    const sheet = await completeJob(orgId, bookingId, force);
    void qc.invalidateQueries({ queryKey: ["invoices"] });
    return sheet;
  });
}

export function useAddChecklistItems(orgId: string, bookingId: string) {
  return useChecklistMutation(orgId, bookingId, (labels: string[]) => addChecklistItems(orgId, bookingId, labels));
}

export function useToggleChecklistItem(orgId: string, bookingId: string) {
  return useChecklistMutation(orgId, bookingId, (v: { itemId: string; done: boolean }) =>
    toggleChecklistItem(orgId, bookingId, v.itemId, v.done),
  );
}

export function useDeleteChecklistItem(orgId: string, bookingId: string) {
  return useChecklistMutation(orgId, bookingId, (itemId: string) => deleteChecklistItem(orgId, bookingId, itemId));
}

export function useApplyChecklistTemplate(orgId: string, bookingId: string) {
  return useChecklistMutation(orgId, bookingId, (templateId: string) => applyChecklistTemplate(orgId, bookingId, templateId));
}

export function useChecklistTemplates(orgId: string, companyId: string | null | undefined) {
  return useQuery({
    queryKey: [TEMPLATES, orgId, companyId],
    queryFn: () => fetchChecklistTemplates(orgId, companyId as string),
    enabled: Boolean(orgId && companyId),
    staleTime: 60_000,
  });
}

export function useSaveChecklistTemplate(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id?: string; companyId: string; name: string; items: string[] }) =>
      v.id ? updateChecklistTemplate(orgId, v.id, { name: v.name, items: v.items }) : createChecklistTemplate(orgId, v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [TEMPLATES] }),
  });
}

export function useDeleteChecklistTemplate(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteChecklistTemplate(orgId, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [TEMPLATES] }),
  });
}

export function useJobPhotos(orgId: string, bookingId: string | null | undefined) {
  return useQuery({
    queryKey: [JOBS, "photos", orgId, bookingId],
    queryFn: () => fetchJobPhotos(orgId, bookingId as string),
    enabled: Boolean(orgId && bookingId),
    staleTime: 30 * 60_000, // signed URLs last an hour
  });
}

export function useUploadJobPhotos(orgId: string, bookingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) await uploadJobPhoto(orgId, bookingId, file);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: [JOBS, "photos", orgId, bookingId] }),
  });
}
