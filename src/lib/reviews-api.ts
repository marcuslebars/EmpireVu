/** Review requests: settings, the Reviews page list, and the contact-page button. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api-client";

export type ReviewTrigger = "job_done" | "invoice_paid";
export type ReviewChannel = "sms_or_email" | "sms" | "email";

export interface ReviewSettingsValues {
  enabled: boolean;
  trigger: ReviewTrigger;
  delayHours: number;
  channel: ReviewChannel;
  cooldownDays: number;
  smsTemplate: string;
  emailSubject: string;
  emailTemplate: string;
}

export interface ReviewSettingsView {
  companyId: string;
  companyName: string;
  reviewUrl: string | null;
  settings: ReviewSettingsValues;
  linkBase: string;
  emailConfigured: boolean;
  overlappingAutomations: Array<{ id: string; name: string; slug: string }>;
}

export type ReviewStatus = "scheduled" | "sending" | "sent" | "skipped" | "failed" | "cancelled";

export interface ReviewRequestView {
  id: string;
  contactId: string;
  customerName: string;
  jobTitle: string | null;
  source: "job_done" | "invoice_paid" | "manual";
  status: ReviewStatus;
  channel: "sms" | "email" | null;
  scheduledFor: string;
  sentAt: string | null;
  clickedAt: string | null;
  clickCount: number;
  reason: string | null;
}

export interface ReviewRequestList {
  requests: ReviewRequestView[];
  stats: { sent: number; clicked: number; clickRate: number | null; queued: number; skipped: number };
}

export interface ContactReviewStatus {
  reviewUrlSet: boolean;
  last: { status: ReviewStatus; sentAt: string | null; scheduledFor: string; clickedAt: string | null; channel: "sms" | "email" | null; reason: string | null } | null;
}

export interface ReviewSendOutcome {
  status: "sent" | "skipped" | "failed" | "cancelled" | "deferred" | "busy";
  reason: string | null;
  channel: "sms" | "email" | null;
  to: string | null;
}

const org = (orgId: string) => `/api/organizations/${orgId}`;
const KEY = "reviews";

export const fetchReviewSettings = (orgId: string, companyId: string) => apiFetch<ReviewSettingsView>(`${org(orgId)}/review-settings/${companyId}`);

export const saveReviewSettings = (orgId: string, companyId: string, body: { reviewUrl?: string | null; settings?: Partial<ReviewSettingsValues> }) =>
  apiFetch<ReviewSettingsView>(`${org(orgId)}/review-settings/${companyId}`, { method: "PUT", body: JSON.stringify(body) });

export function fetchReviewRequests(orgId: string, q: { companyId?: string | null; days: number; status?: string | null }): Promise<ReviewRequestList> {
  const p = new URLSearchParams({ days: String(q.days) });
  if (q.companyId) p.set("companyId", q.companyId);
  if (q.status) p.set("status", q.status);
  return apiFetch(`${org(orgId)}/review-requests?${p.toString()}`);
}

export const cancelReviewRequest = (orgId: string, id: string) => apiFetch<{ cancelled: boolean }>(`${org(orgId)}/review-requests/${id}/cancel`, { method: "POST" });

export const fetchContactReview = (orgId: string, contactId: string) => apiFetch<ContactReviewStatus>(`${org(orgId)}/contacts/${contactId}/review-request`);

export const askForReview = (orgId: string, contactId: string, body: { channel?: "sms" | "email" | null; force?: boolean }) =>
  apiFetch<ReviewSendOutcome>(`${org(orgId)}/contacts/${contactId}/review-request`, { method: "POST", body: JSON.stringify(body) });

/** Pause an automation that would ask for reviews a second time. */
export const pauseWorkflow = (orgId: string, workflowId: string) =>
  apiFetch(`${org(orgId)}/workflows/${workflowId}`, { method: "PATCH", body: JSON.stringify({ action: "updateStatus", status: "paused" }) });

export function useReviewSettings(orgId: string, companyId: string | null) {
  return useQuery({
    queryKey: [KEY, "settings", orgId, companyId],
    queryFn: () => fetchReviewSettings(orgId, companyId!),
    enabled: Boolean(orgId && companyId),
  });
}

export function useSaveReviewSettings(orgId: string, companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { reviewUrl?: string | null; settings?: Partial<ReviewSettingsValues> }) => saveReviewSettings(orgId, companyId, body),
    onSuccess: (data) => qc.setQueryData([KEY, "settings", orgId, companyId], data),
  });
}

export function useReviewRequests(orgId: string, q: { companyId?: string | null; days: number; status?: string | null }) {
  return useQuery({ queryKey: [KEY, "list", orgId, q], queryFn: () => fetchReviewRequests(orgId, q), enabled: Boolean(orgId) });
}

export function useCancelReviewRequest(orgId: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => cancelReviewRequest(orgId, id), onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }) });
}

export function useContactReview(orgId: string, contactId: string) {
  return useQuery({ queryKey: [KEY, "contact", orgId, contactId], queryFn: () => fetchContactReview(orgId, contactId), enabled: Boolean(orgId && contactId) });
}

export function useAskForReview(orgId: string, contactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { channel?: "sms" | "email" | null; force?: boolean }) => askForReview(orgId, contactId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export const DELAY_OPTIONS: Array<{ hours: number; label: string }> = [
  { hours: 0, label: "Right away" },
  { hours: 1, label: "1 hour later" },
  { hours: 2, label: "2 hours later" },
  { hours: 4, label: "4 hours later" },
  { hours: 24, label: "The next day" },
  { hours: 48, label: "2 days later" },
  { hours: 72, label: "3 days later" },
];

export const COOLDOWN_OPTIONS: Array<{ days: number; label: string }> = [
  { days: 0, label: "Ask after every job" },
  { days: 30, label: "At most once a month" },
  { days: 90, label: "At most every 3 months" },
  { days: 180, label: "At most every 6 months" },
  { days: 365, label: "At most once a year" },
];

/** Same substitution the server does, for the live preview. */
export function previewTemplate(tpl: string, vars: { firstName: string; company: string; link: string }): string {
  return tpl
    .replace(/\{\{\s*first_name\s*\}\}/g, vars.firstName)
    .replace(/\{\{\s*company\s*\}\}/g, vars.company)
    .replace(/\{\{\s*link\s*\}\}/g, vars.link);
}

export const STATUS_LABELS: Record<ReviewStatus, string> = {
  scheduled: "Queued",
  sending: "Sending",
  sent: "Sent",
  skipped: "Not sent",
  failed: "Failed",
  cancelled: "Cancelled",
};
