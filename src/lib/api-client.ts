/**
 * Centralized API client for Syncoree UI endpoints.
 * All requests are organization-scoped under:
 *   /api/organizations/:organizationId/ui/...
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    throw new ApiError(res.status, `API error ${res.status}: ${res.statusText}`, body);
  }

  const json = await res.json();
  return json.data as T;
}

function buildUrl(base: string, params: Record<string, string | number | boolean | null | undefined>): string {
  const url = new URL(base, window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

export interface DashboardSummary {
  activeWorkflowCount: number;
  failedWorkflowJobCount: number;
  newLeadCount: number;
  overdueTaskCount: number;
  revenueSnapshot: {
    todayCents: number;
    weekCents: number;
  };
  todayBookingCount: number;
  upcomingBookingCount: number;
  urgentTaskCount: number;
}

export interface DashboardActivityItem {
  company: { id: string; name: string; stage: string } | null;
  entity: { id: string; label: string; type: string } | null;
  eventType: string;
  id: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
  relatedEntity: { id: string; label: string; type: string } | null;
}

export interface AutomationImpact {
  estimatedTimeSavedSeconds: number;
  failedJobsCount: number;
  successRate: number;
  tasksAutoCreated: number;
  totalWorkflowRuns: number;
}

export function fetchDashboardSummary(orgId: string): Promise<DashboardSummary> {
  return apiFetch(`/api/organizations/${orgId}/ui/dashboard/summary`);
}

export function fetchDashboardActivity(
  orgId: string,
  params: { companyId?: string; limit?: number } = {},
): Promise<DashboardActivityItem[]> {
  const url = buildUrl(`/api/organizations/${orgId}/ui/dashboard/activity`, params);
  return apiFetch(url);
}

export function fetchAutomationImpact(orgId: string): Promise<AutomationImpact> {
  return apiFetch(`/api/organizations/${orgId}/ui/dashboard/automation-impact`);
}

// ─── Calendar ────────────────────────────────────────────────────────────────

export interface UserSummary {
  id: string;
  initials: string;
  name: string;
}

export interface CompanySummary {
  id: string;
  name: string;
  stage: string;
}

export interface ContactRowSummary {
  company: CompanySummary | null;
  email: string | null;
  id: string;
  name: string;
  phone: string | null;
  stage: string;
}

export interface BookingCalendarRow {
  assignedUserSummary: {
    count: number;
    primary: UserSummary | null;
    users: UserSummary[];
  };
  company: CompanySummary | null;
  contact: ContactRowSummary | null;
  durationMinutes: number;
  id: string;
  priority: string | null;
  revenueCents: number | null;
  scheduledFor: string;
  status: string;
  taskCount: number;
  title: string;
}

export interface CalendarViewResponse {
  assignedUsers: Array<{
    bookingCount: number;
    totalDurationMinutes: number;
    user: UserSummary;
  }>;
  bookings: {
    items: BookingCalendarRow[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  };
  range: { end: string; start: string };
}

export interface CapacityResponse {
  users: Array<{
    bookingCount: number;
    conflictCount: number;
    conflictIndicators: string[];
    isOverloaded: boolean;
    overloadIndicator: string | null;
    totalDurationMinutes: number;
    user: UserSummary;
  }>;
}

export interface BookingTaskSummary {
  assignee: UserSummary | null;
  dueAt: string | null;
  id: string;
  priority: string;
  status: string;
  title: string;
  workflowId: string | null;
}

export interface BookingDetailResponse {
  booking: {
    company: CompanySummary | null;
    contact: ContactRowSummary | null;
    description: string | null;
    durationMinutes: number;
    id: string;
    revenueCents: number | null;
    scheduledFor: string;
    status: string;
    title: string;
  };
  trace: TraceRecord[];
  triggeredWorkflowRuns: Array<{
    completedAt: string | null;
    createdAt: string;
    failureReason: string | null;
    id: string;
    status: string;
    workflow: { id: string; label: string; type: string } | null;
  }>;
  tasks: BookingTaskSummary[];
}

export function fetchCalendarView(
  orgId: string,
  params: { start?: string; end?: string; companyId?: string; assignedUserId?: string; page?: number; pageSize?: number } = {},
): Promise<CalendarViewResponse> {
  const url = buildUrl(`/api/organizations/${orgId}/ui/calendar`, params);
  return apiFetch(url);
}

export function fetchCalendarCapacity(
  orgId: string,
  params: { start?: string; end?: string; companyId?: string } = {},
): Promise<CapacityResponse> {
  const url = buildUrl(`/api/organizations/${orgId}/ui/calendar/capacity`, params);
  return apiFetch(url);
}

export function fetchBookingDetail(orgId: string, bookingId: string): Promise<BookingDetailResponse> {
  return apiFetch(`/api/organizations/${orgId}/ui/calendar/bookings/${bookingId}`);
}

// ─── CRM ─────────────────────────────────────────────────────────────────────

export interface NextActionSummary {
  detail: string;
  dueAt: string | null;
  label: string;
  type: "urgent" | "action" | "wait" | "done";
}

export interface CRMContactRow {
  bookingsCount: number;
  company: CompanySummary | null;
  email: string | null;
  id: string;
  lastActivity: { eventType: string; occurredAt: string; title: string } | null;
  name: string;
  nextAction: NextActionSummary;
  owner: UserSummary | null;
  phone: string | null;
  pipelineValueCents: number | null;
  realizedRevenueCents: number;
  stage: string;
  upcomingBookingsCount: number;
}

export interface CRMContactsResponse {
  pipelineSummary: Array<{ count: number; stage: string; valueCents: number }>;
  rows: {
    items: CRMContactRow[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  };
}

export interface ContactDetailResponse {
  contact: {
    company: CompanySummary | null;
    createdAt: string;
    email: string | null;
    id: string;
    metadata: Record<string, unknown>;
    name: string;
    notes: string | null;
    owner: UserSummary | null;
    phone: string | null;
    stage: string;
  };
  financialSummary: {
    pipelineValueCents: number | null;
    realizedRevenueCents: number;
    upcomingRevenueCents: number;
  };
  linkedBookings: BookingCalendarRow[];
  linkedTasks: TaskListRow[];
  nextAction: NextActionSummary;
  timeline: TraceRecord[];
  workflowTraces: Array<{
    completedAt: string | null;
    createdAt: string;
    failureReason: string | null;
    id: string;
    status: string;
    workflow: { id: string; label: string; type: string } | null;
  }>;
}

export function fetchCRMContacts(
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
): Promise<CRMContactsResponse> {
  const url = buildUrl(`/api/organizations/${orgId}/ui/crm/contacts`, params);
  return apiFetch(url);
}

export function fetchContactDetail(orgId: string, contactId: string): Promise<ContactDetailResponse> {
  return apiFetch(`/api/organizations/${orgId}/ui/crm/contacts/${contactId}`);
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

export interface TaskListRow {
  assignee: UserSummary | null;
  booking: { id: string; label: string; type: string } | null;
  commentsCount: number;
  company: CompanySummary | null;
  contact: ContactRowSummary | null;
  dueAt: string | null;
  id: string;
  isOverdue: boolean;
  priority: string;
  status: string;
  title: string;
  workflow: { id: string; label: string; type: string } | null;
}

export interface TasksListResponse {
  rows: {
    items: TaskListRow[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  };
  summary: {
    blockedCount: number;
    completedCount: number;
    inProgressCount: number;
    overdueCount: number;
    todoCount: number;
  };
}

export interface ActorSummary {
  email: string;
  id: string;
  name: string;
}

export interface TaskDetailResponse {
  comments: Array<{
    author: ActorSummary | null;
    body: string;
    createdAt: string;
    id: string;
  }>;
  linkedEntities: {
    booking: { id: string; label: string; type: string } | null;
    company: CompanySummary | null;
    contact: ContactRowSummary | null;
    workflow: { id: string; label: string; type: string } | null;
  };
  task: {
    assignee: UserSummary | null;
    createdAt: string;
    description: string | null;
    dueAt: string | null;
    id: string;
    isOverdue: boolean;
    priority: string;
    status: string;
    title: string;
  };
  trace: TraceRecord[];
  workflowOrigin: {
    latestRun: {
      completedAt: string | null;
      createdAt: string;
      failureReason: string | null;
      id: string;
      status: string;
    } | null;
    workflow: { id: string; label: string; type: string } | null;
  };
}

export function fetchTasks(
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
): Promise<TasksListResponse> {
  const url = buildUrl(`/api/organizations/${orgId}/ui/tasks`, params);
  return apiFetch(url);
}

export function fetchTaskDetail(orgId: string, taskId: string): Promise<TaskDetailResponse> {
  return apiFetch(`/api/organizations/${orgId}/ui/tasks/${taskId}`);
}

// ─── Automations ─────────────────────────────────────────────────────────────

export interface WorkflowListRow {
  company: CompanySummary | null;
  createdAt: string;
  description: string | null;
  id: string;
  metrics: {
    failedRuns: number;
    successRate: number;
    successfulRuns: number;
    totalRuns: number;
  };
  name: string;
  recentRunSummary: {
    lastRunAt: string | null;
    lastRunStatus: string | null;
    recentRunsCount: number;
  };
  status: string;
  triggerType: string;
}

export interface WorkflowsListResponse {
  rows: {
    items: WorkflowListRow[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  };
}

export interface WorkflowDetailResponse {
  relatedFailedJobs: Array<{
    activityEvent: { id: string; label: string; type: string } | null;
    failedAt: string | null;
    id: string;
    lastError: string | null;
    retryEligible: boolean;
    status: string;
  }>;
  workflow: {
    company: CompanySummary | null;
    createdAt: string;
    definition: unknown;
    description: string | null;
    id: string;
    name: string;
    status: string;
    triggerType: string;
  };
  workflowRuns: {
    items: Array<{
      completedAt: string | null;
      createdAt: string;
      failureReason: string | null;
      id: string;
      status: string;
      triggerEvent: { id: string; label: string; type: string } | null;
    }>;
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  };
}

export interface WorkflowJobsResponse {
  rows: {
    items: Array<{
      activityEvent: { id: string; label: string; type: string } | null;
      attemptCount: number;
      availableAt: string;
      company: CompanySummary | null;
      completedAt: string | null;
      id: string;
      lastAttemptedAt: string | null;
      lastError: string | null;
      retryEligible: boolean;
      status: string;
    }>;
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  };
}

export function fetchWorkflows(
  orgId: string,
  params: {
    search?: string;
    status?: string;
    triggerType?: string;
    companyId?: string;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<WorkflowsListResponse> {
  const url = buildUrl(`/api/organizations/${orgId}/ui/automations/workflows`, params);
  return apiFetch(url);
}

export function fetchWorkflowDetail(orgId: string, workflowId: string): Promise<WorkflowDetailResponse> {
  return apiFetch(`/api/organizations/${orgId}/ui/automations/workflows/${workflowId}`);
}

export function fetchWorkflowJobs(
  orgId: string,
  params: { status?: string; companyId?: string; page?: number; pageSize?: number } = {},
): Promise<WorkflowJobsResponse> {
  const url = buildUrl(`/api/organizations/${orgId}/ui/automations/jobs`, params);
  return apiFetch(url);
}

// ─── System Trace ─────────────────────────────────────────────────────────────

export interface TraceRecord {
  actor: ActorSummary | null;
  company: CompanySummary | null;
  detail: string;
  entity: { id: string; label: string; type: string } | null;
  id: string;
  kind: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
  relatedEntity: { id: string; label: string; type: string } | null;
  status: string | null;
  title: string;
}

export interface UnifiedTraceResponse {
  entity: { id: string; label: string; type: string };
  trace: TraceRecord[];
}

export function fetchTrace(
  orgId: string,
  entityType: "contact" | "booking" | "task",
  entityId: string,
): Promise<UnifiedTraceResponse> {
  return apiFetch(`/api/organizations/${orgId}/ui/trace/${entityType}/${entityId}`);
}
