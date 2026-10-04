/** Client API for recurring jobs. */
import { apiFetch } from "@/lib/api-client";

export type Frequency = "weekly" | "monthly" | "yearly";

export interface RecurringLine {
  label: string;
  quantity: number;
  unitPriceCents: number;
}

export interface RecurringJob {
  id: string;
  companyId: string;
  contactId: string | null;
  contactName: string | null;
  title: string;
  description: string | null;
  location: string | null;
  durationMinutes: number;
  frequency: Frequency;
  interval: number;
  weekdays: number[];
  startDate: string;
  timeOfDay: string;
  endsOn: string | null;
  maxOccurrences: number | null;
  crewProfileIds: string[];
  crewNames: string[];
  checklistTemplateId: string | null;
  lineItems: RecurringLine[];
  priceCents: number;
  status: "active" | "paused" | "ended";
  ruleText: string;
  nextVisitAt: string | null;
  upcomingCount: number;
  completedCount: number;
}

export interface RecurringJobPayload {
  companyId: string;
  contactId: string | null;
  title: string;
  description: string | null;
  location: string | null;
  durationMinutes: number;
  frequency: Frequency;
  interval: number;
  weekdays: number[];
  startDate: string;
  timeOfDay: string;
  endsOn: string | null;
  maxOccurrences: number | null;
  crewProfileIds: string[];
  checklistTemplateId: string | null;
  lineItems: RecurringLine[];
}

export interface RecurringWriteResult {
  job: RecurringJob;
  visitsCreated: number;
  visitsRemoved?: number;
}

const base = (orgId: string) => `/api/organizations/${orgId}/recurring-jobs`;

export function fetchRecurringJobs(orgId: string, companyId?: string | null): Promise<RecurringJob[]> {
  return apiFetch(companyId ? `${base(orgId)}?companyId=${encodeURIComponent(companyId)}` : base(orgId));
}

export function fetchRecurringJob(orgId: string, id: string): Promise<RecurringJob> {
  return apiFetch(`${base(orgId)}/${id}`);
}

export function createRecurringJob(orgId: string, payload: RecurringJobPayload): Promise<RecurringWriteResult> {
  return apiFetch(base(orgId), { method: "POST", body: JSON.stringify(payload) });
}

export function updateRecurringJob(orgId: string, id: string, payload: RecurringJobPayload): Promise<RecurringWriteResult> {
  return apiFetch(`${base(orgId)}/${id}`, { method: "PUT", body: JSON.stringify(payload) });
}

export function setRecurringJobStatus(orgId: string, id: string, status: RecurringJob["status"]): Promise<RecurringWriteResult> {
  return apiFetch(`${base(orgId)}/${id}/status`, { method: "POST", body: JSON.stringify({ status }) });
}
