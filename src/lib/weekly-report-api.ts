/** Weekly "what your front desk did" report (docs/front-desk-ai.md → "Weekly report"). */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api-client";

export type WeeklyReportChannel = "sms" | "email";

export interface WeeklyReportMetrics {
  version: 1;
  weekStart: string;
  timeZone: string;
  textConversations: number;
  approvals: { asked: number; approved: number };
  calls: { answered: number; afterHours: number | null; minutes: number };
  missedCalls: { caught: number; textedBack: number };
  leads: number;
  quotes: { sent: number; approved: number; approvedCents: number };
  jobsBooked: number;
  collected: { cents: number; deposits: number; payments: number };
  reviewsRequested: number;
  currency: string;
  hoursSaved: { minutes: number; hours: number; wageValueCents: number };
  hasActivity: boolean;
}

export interface WeeklyReportWeek {
  weekStart: string;
  label: string;
  partial: boolean;
  metrics: WeeklyReportMetrics;
  send: { status: string; sentAt: string | null; channels: string[] } | null;
}

export interface WeeklyReportView {
  companyId: string;
  companyName: string;
  timeZone: string;
  isCrankleads: boolean;
  brandName: string;
  settings: { enabled: boolean; channels: WeeklyReportChannel[] };
  ownerPhoneOnFile: boolean;
  assumptions: {
    text: string;
    values: {
      minutesPerTextConversation: number;
      minutesPerCallAnswered: number;
      minutesPerQuoteSent: number;
      minutesPerJobBooked: number;
      minutesPerMissedCallTextBack: number;
      receptionistHourlyWageCents: number;
    };
  };
  weeks: WeeklyReportWeek[];
}

export interface WeeklyReportTestResult {
  week: string;
  emailTo: string | null;
  smsTo: string | null;
  status: Record<string, string>;
  sent: string[];
  sms: string;
  subject: string;
}

const KEY = "weekly-report";

export function fetchWeeklyReport(
  orgId: string,
  companyId: string,
  options: { weeks?: number; includeCurrent?: boolean } = {},
): Promise<WeeklyReportView> {
  const params = new URLSearchParams({ companyId, weeks: String(options.weeks ?? 8) });
  if (options.includeCurrent) params.set("includeCurrent", "1");
  return apiFetch(`/api/organizations/${orgId}/ui/weekly-report?${params.toString()}`);
}

export interface WeeklyReportSettingsView {
  enabled: boolean;
  channels: WeeklyReportChannel[];
  isCrankleads: boolean;
  brandName: string;
  ownerPhoneOnFile: boolean;
  ownerEmailOnFile: boolean;
  canManage: boolean;
}

const settingsPath = (orgId: string, companyId: string) =>
  `/api/organizations/${orgId}/companies/${companyId}/ai-settings/weekly-report`;

export function fetchWeeklyReportSettings(orgId: string, companyId: string): Promise<WeeklyReportSettingsView> {
  return apiFetch(settingsPath(orgId, companyId));
}

export function updateWeeklyReportSettings(
  orgId: string,
  companyId: string,
  body: { enabled?: boolean; channels?: WeeklyReportChannel[] },
): Promise<WeeklyReportSettingsView> {
  return apiFetch(settingsPath(orgId, companyId), { method: "PATCH", body: JSON.stringify(body) });
}

export function sendWeeklyReportTest(orgId: string, companyId: string): Promise<WeeklyReportTestResult> {
  return apiFetch(`${settingsPath(orgId, companyId)}/test`, { method: "POST", body: "{}" });
}

export function useWeeklyReport(
  orgId: string,
  companyId: string | null,
  options: { weeks?: number; includeCurrent?: boolean } = {},
) {
  return useQuery({
    queryKey: [KEY, orgId, companyId, options.weeks ?? 8, Boolean(options.includeCurrent)],
    queryFn: () => fetchWeeklyReport(orgId, companyId!, options),
    enabled: Boolean(orgId && companyId),
    staleTime: 5 * 60_000,
  });
}

export function useWeeklyReportSettings(orgId: string, companyId: string | null) {
  return useQuery({
    queryKey: [KEY, "settings", orgId, companyId],
    queryFn: () => fetchWeeklyReportSettings(orgId, companyId!),
    enabled: Boolean(orgId && companyId),
    staleTime: 30_000,
  });
}

export function useUpdateWeeklyReportSettings(orgId: string, companyId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { enabled?: boolean; channels?: WeeklyReportChannel[] }) =>
      updateWeeklyReportSettings(orgId, companyId!, body),
    onSuccess: (data) => {
      qc.setQueryData([KEY, "settings", orgId, companyId], data);
      void qc.invalidateQueries({ queryKey: [KEY, orgId, companyId] });
    },
  });
}

export function useSendWeeklyReportTest(orgId: string, companyId: string | null) {
  return useMutation({ mutationFn: () => sendWeeklyReportTest(orgId, companyId!) });
}

// ── Formatting shared by the card, the page and the settings section ────────────

export function wholeDollars(cents: number): string {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 }).format(
    Math.round(cents / 100),
  );
}

/** 390 → "6.5 h", 45 → "45 min". */
export function hoursSavedShort(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours % 1 === 0 ? hours.toFixed(0) : hours.toFixed(1)} h`;
}
