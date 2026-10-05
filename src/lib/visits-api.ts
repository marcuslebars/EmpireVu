/** Confirm & reschedule: the public visit page, and the staff settings / job link. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api-client";
import type { PortalBrand } from "@/lib/portal-api";

export type VisitState = "scheduled" | "confirmed" | "on_the_way" | "in_progress" | "done" | "cancelled" | "missed" | "past";

export interface Visit {
  brand: PortalBrand;
  customerName: string;
  title: string;
  date: string;
  time: string;
  windowLabel: string | null;
  location: string | null;
  state: VisitState;
  confirmedAt: string | null;
  canConfirm: boolean;
  canReschedule: boolean;
  canCancel: boolean;
  lockedReason: string | null;
}

export interface OpenTime {
  startsAt: string;
  day: string;
  dayLabel: string;
  label: string;
  windowKey: string | null;
}

const pub = (token: string) => `/api/public/visits/${encodeURIComponent(token)}`;

export const fetchVisit = (token: string) => apiFetch<Visit>(pub(token));
export const fetchOpenTimes = (token: string) => apiFetch<OpenTime[]>(`${pub(token)}/times`);
export const confirmVisit = (token: string) => apiFetch<Visit>(`${pub(token)}/confirm`, { method: "POST", body: "{}" });
export const rescheduleVisit = (token: string, t: Pick<OpenTime, "startsAt" | "windowKey">) =>
  apiFetch<Visit>(`${pub(token)}/reschedule`, { method: "POST", body: JSON.stringify({ startsAt: t.startsAt, windowKey: t.windowKey }) });
export const cancelVisit = (token: string, reason: string | null) =>
  apiFetch<Visit>(`${pub(token)}/cancel`, { method: "POST", body: JSON.stringify({ reason }) });

// ── Staff ────────────────────────────────────────────────────────────────────

export interface VisitSettingsValues {
  allowReschedule: boolean;
  allowCancel: boolean;
  cutoffHours: number;
}

export interface VisitSettingsView {
  companyId: string;
  settings: VisitSettingsValues;
  linkBase: string;
  reminders: Array<{ id: string; name: string; status: string; hasLink: boolean }>;
}

export interface VisitLink {
  url: string | null;
  customerConfirmedAt: string | null;
}

const org = (orgId: string) => `/api/organizations/${orgId}`;
const KEY = "visits";

export function useVisitSettings(orgId: string, companyId: string | null) {
  return useQuery({
    queryKey: [KEY, "settings", orgId, companyId],
    queryFn: () => apiFetch<VisitSettingsView>(`${org(orgId)}/visit-settings/${companyId}`),
    enabled: Boolean(orgId && companyId),
  });
}

export function useSaveVisitSettings(orgId: string, companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<VisitSettingsValues>) => apiFetch<VisitSettingsView>(`${org(orgId)}/visit-settings/${companyId}`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: (data) => qc.setQueryData([KEY, "settings", orgId, companyId], data),
  });
}

export function useAddLinkToReminders(orgId: string, companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<VisitSettingsView>(`${org(orgId)}/visit-settings/${companyId}/add-link`, { method: "POST" }),
    onSuccess: (data) => qc.setQueryData([KEY, "settings", orgId, companyId], data),
  });
}

export function useVisitLink(orgId: string, bookingId: string) {
  return useQuery({
    queryKey: [KEY, "link", orgId, bookingId],
    queryFn: () => apiFetch<VisitLink>(`${org(orgId)}/jobs/${bookingId}/visit-link`),
    enabled: Boolean(orgId && bookingId),
  });
}

export const CUTOFF_OPTIONS = [0, 2, 12, 24, 48, 72];
