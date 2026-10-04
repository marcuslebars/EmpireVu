/** Client API for timesheets & job costing. */
import { apiAuthHeaders, apiFetch, resolveApiUrl } from "@/lib/api-client";

export interface TimeEntry {
  id: string;
  profileId: string;
  personName: string;
  bookingId: string | null;
  jobTitle: string | null;
  startedAt: string;
  endedAt: string | null;
  breakMinutes: number;
  minutes: number;
  notes: string | null;
  source: "clock" | "manual";
}

export interface PersonTotal {
  profileId: string;
  name: string;
  minutes: number;
  costCents: number | null;
  entries: number;
}

export interface TimesheetData {
  entries: TimeEntry[];
  summary: PersonTotal[];
  canSeeCosts: boolean;
}

export interface Material {
  id: string;
  label: string;
  quantity: number;
  unitCostCents: number;
  totalCents: number;
  createdBy: string | null;
}

export interface JobProfit {
  revenueCents: number;
  revenueSource: "invoice" | "estimate" | "none";
  labourMinutes: number;
  labourCents: number;
  materialsCents: number;
  costCents: number;
  profitCents: number;
  marginPct: number | null;
  missingRates: string[];
  missingRateNames: string[];
  running: boolean;
}

export interface ProfitRow extends Omit<JobProfit, "missingRateNames"> {
  bookingId: string;
  title: string;
  scheduledFor: string;
  contactName: string | null;
}

export interface ProfitReport {
  rows: ProfitRow[];
  totals: { revenueCents: number; costCents: number; profitCents: number; labourMinutes: number };
  missingRateNames: string[];
}

export interface PayRate {
  profileId: string;
  name: string;
  email: string | null;
  role: string;
  hourlyCostCents: number | null;
}

const org = (orgId: string) => `/api/organizations/${orgId}`;

export const fetchMyClock = (orgId: string) => apiFetch<TimeEntry | null>(`${org(orgId)}/time/clock`);
export const clockIn = (orgId: string, bookingId: string | null) =>
  apiFetch<TimeEntry>(`${org(orgId)}/time/clock`, { method: "POST", body: JSON.stringify({ bookingId }) });
export const clockOut = (orgId: string) => apiFetch<TimeEntry | null>(`${org(orgId)}/time/clock`, { method: "DELETE" });

export function fetchTimesheet(orgId: string, opts: { from: string; to: string; profileId?: string | null; companyId?: string | null }): Promise<TimesheetData> {
  const q = new URLSearchParams({ from: opts.from, to: opts.to });
  if (opts.profileId) q.set("profileId", opts.profileId);
  if (opts.companyId) q.set("companyId", opts.companyId);
  return apiFetch(`${org(orgId)}/time/entries?${q.toString()}`);
}

export interface EntryPayload {
  profileId?: string;
  bookingId?: string | null;
  startedAt: string;
  endedAt: string;
  breakMinutes?: number;
  notes?: string | null;
}

export const createEntry = (orgId: string, p: EntryPayload) => apiFetch<TimeEntry>(`${org(orgId)}/time/entries`, { method: "POST", body: JSON.stringify(p) });
export const updateEntry = (orgId: string, id: string, p: Partial<EntryPayload>) =>
  apiFetch<TimeEntry>(`${org(orgId)}/time/entries/${id}`, { method: "PATCH", body: JSON.stringify(p) });
export const deleteEntry = (orgId: string, id: string) => apiFetch<{ ok: true }>(`${org(orgId)}/time/entries/${id}`, { method: "DELETE" });

export const fetchJobTime = (orgId: string, bookingId: string) => apiFetch<TimeEntry[]>(`${org(orgId)}/jobs/${bookingId}/time`);
export const fetchMaterials = (orgId: string, bookingId: string) => apiFetch<Material[]>(`${org(orgId)}/jobs/${bookingId}/materials`);
export const addMaterial = (orgId: string, bookingId: string, m: { label: string; quantity: number; unitCostCents: number }) =>
  apiFetch<Material[]>(`${org(orgId)}/jobs/${bookingId}/materials`, { method: "POST", body: JSON.stringify(m) });
export const deleteMaterial = (orgId: string, bookingId: string, id: string) =>
  apiFetch<Material[]>(`${org(orgId)}/jobs/${bookingId}/materials/${id}`, { method: "DELETE" });
export const fetchJobProfit = (orgId: string, bookingId: string) => apiFetch<JobProfit>(`${org(orgId)}/jobs/${bookingId}/profit`);

export function fetchProfitReport(orgId: string, opts: { from: string; to: string; companyId?: string | null }): Promise<ProfitReport> {
  const q = new URLSearchParams({ from: opts.from, to: opts.to });
  if (opts.companyId) q.set("companyId", opts.companyId);
  return apiFetch(`${org(orgId)}/reports/job-profit?${q.toString()}`);
}

export const fetchRates = (orgId: string) => apiFetch<PayRate[]>(`${org(orgId)}/time/rates`);
export const setRate = (orgId: string, profileId: string, hourlyCostCents: number | null) =>
  apiFetch<PayRate[]>(`${org(orgId)}/time/rates`, { method: "PUT", body: JSON.stringify({ profileId, hourlyCostCents }) });

/** Download the timesheet CSV for a window (authenticated fetch → file save). */
export async function downloadTimesheetCsv(orgId: string, from: string, to: string, tz: string, filename: string): Promise<void> {
  const res = await fetch(resolveApiUrl(`${org(orgId)}/time/export?${new URLSearchParams({ from, to, tz }).toString()}`), {
    headers: await apiAuthHeaders(),
  });
  if (!res.ok) throw new Error(`Export failed (${res.status}).`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
