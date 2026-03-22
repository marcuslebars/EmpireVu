/**
 * React Query hooks for all Syncoree UI endpoints.
 * Each hook is typed, deduped, and cached via @tanstack/react-query.
 */

import { useQuery } from "@tanstack/react-query";
import {
  fetchDashboardSummary,
  fetchDashboardActivity,
  fetchAutomationImpact,
  fetchCalendarView,
  fetchCalendarCapacity,
  fetchBookingDetail,
  fetchCRMContacts,
  fetchContactDetail,
  fetchTasks,
  fetchTaskDetail,
  fetchWorkflows,
  fetchWorkflowDetail,
  fetchWorkflowJobs,
  fetchTrace,
} from "./api-client";

// ─── Dashboard ───────────────────────────────────────────────────────────────

export function useDashboardSummary(orgId: string) {
  return useQuery({
    queryKey: ["dashboard", "summary", orgId],
    queryFn: () => fetchDashboardSummary(orgId),
    staleTime: 30_000,
  });
}

export function useDashboardActivity(
  orgId: string,
  params: { companyId?: string; limit?: number } = {},
) {
  return useQuery({
    queryKey: ["dashboard", "activity", orgId, params],
    queryFn: () => fetchDashboardActivity(orgId, params),
    staleTime: 15_000,
  });
}

export function useAutomationImpact(orgId: string) {
  return useQuery({
    queryKey: ["dashboard", "automation-impact", orgId],
    queryFn: () => fetchAutomationImpact(orgId),
    staleTime: 30_000,
  });
}

// ─── Calendar ────────────────────────────────────────────────────────────────

export function useCalendarView(
  orgId: string,
  params: { start?: string; end?: string; companyId?: string; assignedUserId?: string; page?: number; pageSize?: number } = {},
) {
  return useQuery({
    queryKey: ["calendar", "view", orgId, params],
    queryFn: () => fetchCalendarView(orgId, params),
    staleTime: 20_000,
  });
}

export function useCalendarCapacity(
  orgId: string,
  params: { start?: string; end?: string; companyId?: string } = {},
) {
  return useQuery({
    queryKey: ["calendar", "capacity", orgId, params],
    queryFn: () => fetchCalendarCapacity(orgId, params),
    staleTime: 20_000,
  });
}

export function useBookingDetail(orgId: string, bookingId: string | null) {
  return useQuery({
    queryKey: ["calendar", "booking", orgId, bookingId],
    queryFn: () => fetchBookingDetail(orgId, bookingId!),
    enabled: Boolean(bookingId),
    staleTime: 10_000,
  });
}

// ─── CRM ─────────────────────────────────────────────────────────────────────

export function useCRMContacts(
  orgId: string,
  params: {
    search?: string;
    stage?: string;
    companyId?: string;
    ownerProfileId?: string;
    nextAction?: string;
    page?: number;
    pageSize?: number;
  } = {},
) {
  return useQuery({
    queryKey: ["crm", "contacts", orgId, params],
    queryFn: () => fetchCRMContacts(orgId, params),
    staleTime: 20_000,
  });
}

export function useContactDetail(orgId: string, contactId: string | null) {
  return useQuery({
    queryKey: ["crm", "contact", orgId, contactId],
    queryFn: () => fetchContactDetail(orgId, contactId!),
    enabled: Boolean(contactId),
    staleTime: 10_000,
  });
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

export function useTasks(
  orgId: string,
  params: {
    search?: string;
    status?: string;
    priority?: string;
    companyId?: string;
    assigneeId?: string;
    overdue?: boolean;
    page?: number;
    pageSize?: number;
  } = {},
) {
  return useQuery({
    queryKey: ["tasks", "list", orgId, params],
    queryFn: () => fetchTasks(orgId, params),
    staleTime: 20_000,
  });
}

export function useTaskDetail(orgId: string, taskId: string | null) {
  return useQuery({
    queryKey: ["tasks", "detail", orgId, taskId],
    queryFn: () => fetchTaskDetail(orgId, taskId!),
    enabled: Boolean(taskId),
    staleTime: 10_000,
  });
}

// ─── Automations ─────────────────────────────────────────────────────────────

export function useWorkflows(
  orgId: string,
  params: {
    search?: string;
    status?: string;
    triggerType?: string;
    companyId?: string;
    page?: number;
    pageSize?: number;
  } = {},
) {
  return useQuery({
    queryKey: ["automations", "workflows", orgId, params],
    queryFn: () => fetchWorkflows(orgId, params),
    staleTime: 20_000,
  });
}

export function useWorkflowDetail(orgId: string, workflowId: string | null) {
  return useQuery({
    queryKey: ["automations", "workflow", orgId, workflowId],
    queryFn: () => fetchWorkflowDetail(orgId, workflowId!),
    enabled: Boolean(workflowId),
    staleTime: 10_000,
  });
}

export function useWorkflowJobs(
  orgId: string,
  params: { status?: string; companyId?: string; page?: number; pageSize?: number } = {},
) {
  return useQuery({
    queryKey: ["automations", "jobs", orgId, params],
    queryFn: () => fetchWorkflowJobs(orgId, params),
    staleTime: 20_000,
  });
}

// ─── System Trace ─────────────────────────────────────────────────────────────

export function useTrace(
  orgId: string,
  entityType: "contact" | "booking" | "task" | null,
  entityId: string | null,
) {
  return useQuery({
    queryKey: ["trace", orgId, entityType, entityId],
    queryFn: () => fetchTrace(orgId, entityType!, entityId!),
    enabled: Boolean(entityType && entityId),
    staleTime: 10_000,
  });
}
