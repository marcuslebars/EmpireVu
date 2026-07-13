/**
 * React Query hooks for all EmpireVu UI endpoints.
 * Each hook is typed, deduped, and cached via @tanstack/react-query.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
  createContact,
  updateContactStage,
  assignContactOwner,
  updateContactNotes,
  updateContactFields,
  analyzeContactAI,
  type UpdateContactFields,
  createBooking,
  updateBookingStatus,
  createTask,
  updateTaskStatus,
  assignTaskUser,
  runWorkflowNow,
  runWorkflowTest,
  retryWorkflowJob,
  updateWorkflowStatus,
  updateWorkflow,
  createWorkflow,
  type CreateWorkflowInput,
  type UpdateWorkflowInput,
  type CreateContactInput,
  type CreateBookingInput,
  type CreateTaskInput,
  type RunWorkflowNowInput,
  type RunWorkflowTestInput,
} from "./api-client";

// ─── Dashboard ───────────────────────────────────────────────────────────────

export function useDashboardSummary(orgId: string) {
  return useQuery({
    queryKey: ["dashboard", "summary", orgId],
    queryFn: () => fetchDashboardSummary(orgId),
    enabled: Boolean(orgId),
    staleTime: 30_000,
  });
}

export function useDashboardActivity(
  orgId: string,
  params: { companyId?: string; limit?: number } = {},
  options: { refetchInterval?: number } = {},
) {
  return useQuery({
    queryKey: ["dashboard", "activity", orgId, params],
    queryFn: () => fetchDashboardActivity(orgId, params),
    enabled: Boolean(orgId),
    staleTime: 15_000,
    refetchInterval: options.refetchInterval,
  });
}

export function useAutomationImpact(orgId: string) {
  return useQuery({
    queryKey: ["dashboard", "automation-impact", orgId],
    queryFn: () => fetchAutomationImpact(orgId),
    enabled: Boolean(orgId),
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
    enabled: Boolean(orgId),
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
    enabled: Boolean(orgId),
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
    enabled: Boolean(orgId),
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
    enabled: Boolean(orgId),
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
    enabled: Boolean(orgId),
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
    enabled: Boolean(orgId),
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
    enabled: Boolean(orgId && entityType && entityId),
    staleTime: 10_000,
  });
}

// ─── Mutation Hooks ───────────────────────────────────────────────────────────

// Contact mutations

export function useCreateContact(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateContactInput) => createContact(orgId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["crm", "contacts", orgId] });
      void qc.invalidateQueries({ queryKey: ["dashboard", "summary", orgId] });
    },
  });
}

export function useUpdateContactStage(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ contactId, stage }: { contactId: string; stage: "lead" | "qualified" | "active" | "closed" }) =>
      updateContactStage(orgId, contactId, stage),
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: ["crm", "contacts", orgId] });
      void qc.invalidateQueries({ queryKey: ["crm", "contact", orgId, variables.contactId] });
    },
  });
}

export function useAssignContactOwner(orgId: string, contactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ownerProfileId: string) =>
      assignContactOwner(orgId, contactId, ownerProfileId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["crm", "contact", orgId, contactId] });
    },
  });
}

export function useUpdateContactNotes(orgId: string, contactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (notes: string | null) => updateContactNotes(orgId, contactId, notes),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["crm", "contact", orgId, contactId] });
    },
  });
}

export function useUpdateContactFields(orgId: string, contactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fields: UpdateContactFields) => updateContactFields(orgId, contactId, fields),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["crm", "contact", orgId, contactId] });
      void qc.invalidateQueries({ queryKey: ["crm", "contacts", orgId] });
    },
  });
}

export function useAnalyzeContactAI(orgId: string, contactId: string) {
  return useMutation({
    mutationFn: () => analyzeContactAI(orgId, contactId),
  });
}

// Booking mutations

export function useCreateBooking(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBookingInput) => createBooking(orgId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["calendar", "view", orgId] });
      void qc.invalidateQueries({ queryKey: ["calendar", "capacity", orgId] });
      void qc.invalidateQueries({ queryKey: ["dashboard", "summary", orgId] });
    },
  });
}

export function useUpdateBookingStatus(orgId: string, bookingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (status: "pending" | "confirmed" | "completed" | "cancelled" | "no_show") =>
      updateBookingStatus(orgId, bookingId, status),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["calendar", "view", orgId] });
      void qc.invalidateQueries({ queryKey: ["calendar", "booking", orgId, bookingId] });
      void qc.invalidateQueries({ queryKey: ["dashboard", "summary", orgId] });
    },
  });
}

// Task mutations

export function useCreateTask(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskInput) => createTask(orgId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tasks", "list", orgId] });
      void qc.invalidateQueries({ queryKey: ["dashboard", "summary", orgId] });
    },
  });
}

export function useUpdateTaskStatus(orgId: string, taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (status: "todo" | "in_progress" | "blocked" | "completed") =>
      updateTaskStatus(orgId, taskId, status),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tasks", "list", orgId] });
      void qc.invalidateQueries({ queryKey: ["tasks", "detail", orgId, taskId] });
      void qc.invalidateQueries({ queryKey: ["dashboard", "summary", orgId] });
    },
  });
}

export function useAssignTaskUser(orgId: string, taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (assignedToProfileId: string) =>
      assignTaskUser(orgId, taskId, assignedToProfileId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tasks", "detail", orgId, taskId] });
      void qc.invalidateQueries({ queryKey: ["tasks", "list", orgId] });
    },
  });
}

// Workflow action mutations

export function useRunWorkflowNow(orgId: string, workflowId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RunWorkflowNowInput) => runWorkflowNow(orgId, workflowId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["automations", "workflow", orgId, workflowId] });
      void qc.invalidateQueries({ queryKey: ["automations", "workflows", orgId] });
    },
  });
}

export function useTriggerWorkflow(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ workflowId, event }: { workflowId: string; event: RunWorkflowNowInput["event"] }) =>
      runWorkflowNow(orgId, workflowId, { event }),
    onSuccess: (_, { workflowId }) => {
      void qc.invalidateQueries({ queryKey: ["automations", "workflow", orgId, workflowId] });
      void qc.invalidateQueries({ queryKey: ["automations", "workflows", orgId] });
    },
  });
}

export function useRunWorkflowTest(orgId: string, workflowId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RunWorkflowTestInput) => runWorkflowTest(orgId, workflowId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["automations", "workflow", orgId, workflowId] });
    },
  });
}

export function useRetryWorkflowJob(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => retryWorkflowJob(orgId, jobId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["automations", "jobs", orgId] });
      void qc.invalidateQueries({ queryKey: ["automations", "workflow", orgId] });
    },
  });
}

export function useUpdateWorkflowStatus(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ workflowId, status }: { workflowId: string; status: "draft" | "active" | "paused" | "archived" }) =>
      updateWorkflowStatus(orgId, workflowId, status),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["automations", "workflows", orgId] });
      void qc.invalidateQueries({ queryKey: ["automations", "workflow", orgId] });
    },
  });
}

export function useCreateWorkflow(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWorkflowInput) => createWorkflow(orgId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["automations", "workflows", orgId] });
    },
  });
}

export function useUpdateWorkflow(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ workflowId, ...input }: UpdateWorkflowInput & { workflowId: string }) =>
      updateWorkflow(orgId, workflowId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["automations", "workflows", orgId] });
      void qc.invalidateQueries({ queryKey: ["automations", "workflow", orgId] });
    },
  });
}

// ─── Organizations & Companies ───────────────────────────────────────────────

import { fetchOrganizations, updateOrganization, fetchCompanies, createCompany, type CreateCompanyInput } from "./api-client";

export function useOrganizations() {
  return useQuery({
    queryKey: ["organizations"],
    queryFn: () => fetchOrganizations(),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

export function useCompanies(orgId: string) {
  return useQuery({
    queryKey: ["companies", orgId],
    queryFn: () => fetchCompanies(orgId),
    enabled: Boolean(orgId),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

export function useCreateCompany(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCompanyInput) => createCompany(orgId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["companies", orgId] });
    },
  });
}

export function useUpdateOrganization(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name?: string; slug?: string }) => updateOrganization(orgId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["organizations"] });
    },
  });
}
