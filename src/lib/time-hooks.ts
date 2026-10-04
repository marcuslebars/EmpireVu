import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  addMaterial,
  clockIn,
  clockOut,
  createEntry,
  deleteEntry,
  deleteMaterial,
  fetchJobProfit,
  fetchJobTime,
  fetchMaterials,
  fetchMyClock,
  fetchProfitReport,
  fetchRates,
  fetchTimesheet,
  setRate,
  updateEntry,
  type EntryPayload,
} from "./time-api";

const TIME = "time";

function useInvalidateTime() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: [TIME] });
    void qc.invalidateQueries({ queryKey: ["jobs"] });
  };
}

export function useMyClock(orgId: string) {
  return useQuery({ queryKey: [TIME, "clock", orgId], queryFn: () => fetchMyClock(orgId), enabled: Boolean(orgId), staleTime: 30_000 });
}

export function useClockIn(orgId: string) {
  const invalidate = useInvalidateTime();
  return useMutation({ mutationFn: (bookingId: string | null) => clockIn(orgId, bookingId), onSuccess: invalidate });
}

export function useClockOut(orgId: string) {
  const invalidate = useInvalidateTime();
  return useMutation({ mutationFn: () => clockOut(orgId), onSuccess: invalidate });
}

export function useTimesheet(orgId: string, opts: { from: string; to: string; profileId?: string | null; companyId?: string | null }) {
  return useQuery({ queryKey: [TIME, "sheet", orgId, opts], queryFn: () => fetchTimesheet(orgId, opts), enabled: Boolean(orgId), staleTime: 15_000 });
}

export function useSaveEntry(orgId: string) {
  const invalidate = useInvalidateTime();
  return useMutation({
    mutationFn: (v: { id?: string; payload: EntryPayload }) => (v.id ? updateEntry(orgId, v.id, v.payload) : createEntry(orgId, v.payload)),
    onSuccess: invalidate,
  });
}

export function useDeleteEntry(orgId: string) {
  const invalidate = useInvalidateTime();
  return useMutation({ mutationFn: (id: string) => deleteEntry(orgId, id), onSuccess: invalidate });
}

export function useJobTime(orgId: string, bookingId: string) {
  return useQuery({ queryKey: [TIME, "job", orgId, bookingId], queryFn: () => fetchJobTime(orgId, bookingId), enabled: Boolean(orgId && bookingId) });
}

export function useMaterials(orgId: string, bookingId: string) {
  return useQuery({ queryKey: [TIME, "materials", orgId, bookingId], queryFn: () => fetchMaterials(orgId, bookingId), enabled: Boolean(orgId && bookingId) });
}

export function useAddMaterial(orgId: string, bookingId: string) {
  const invalidate = useInvalidateTime();
  return useMutation({ mutationFn: (m: { label: string; quantity: number; unitCostCents: number }) => addMaterial(orgId, bookingId, m), onSuccess: invalidate });
}

export function useDeleteMaterial(orgId: string, bookingId: string) {
  const invalidate = useInvalidateTime();
  return useMutation({ mutationFn: (id: string) => deleteMaterial(orgId, bookingId, id), onSuccess: invalidate });
}

export function useJobProfit(orgId: string, bookingId: string, enabled: boolean) {
  return useQuery({ queryKey: [TIME, "profit", orgId, bookingId], queryFn: () => fetchJobProfit(orgId, bookingId), enabled: Boolean(orgId && bookingId) && enabled });
}

export function useProfitReport(orgId: string, opts: { from: string; to: string; companyId?: string | null }, enabled: boolean) {
  return useQuery({ queryKey: [TIME, "report", orgId, opts], queryFn: () => fetchProfitReport(orgId, opts), enabled: Boolean(orgId) && enabled });
}

export function useRates(orgId: string, enabled: boolean) {
  return useQuery({ queryKey: [TIME, "rates", orgId], queryFn: () => fetchRates(orgId), enabled: Boolean(orgId) && enabled });
}

export function useSetRate(orgId: string) {
  const invalidate = useInvalidateTime();
  return useMutation({ mutationFn: (v: { profileId: string; hourlyCostCents: number | null }) => setRate(orgId, v.profileId, v.hourlyCostCents), onSuccess: invalidate });
}
