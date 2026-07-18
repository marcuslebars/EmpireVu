/**
 * Centralized API client for EmpireVu UI endpoints.
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

export async function fetchDashboardActivity(
  orgId: string,
  params: { companyId?: string; limit?: number } = {},
): Promise<DashboardActivityItem[]> {
  const url = buildUrl(`/api/organizations/${orgId}/ui/dashboard/activity`, params);
  // The endpoint returns a paginated envelope ({ items, pagination }), not a
  // bare array — unwrap items so callers get the array they expect.
  const result = await apiFetch<{ items: DashboardActivityItem[] }>(url);
  return result?.items ?? [];
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
      actionsExecutedCount: number;
      completedAt: string | null;
      conditionResults: Array<{ actualValue: unknown; field: string; matched: boolean; operator: string; value: unknown }>;
      createdAt: string;
      createdTasksCount: number;
      failureReason: string | null;
      id: string;
      status: string;
      timeSavedSeconds: number;
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

// ─── Mutations ────────────────────────────────────────────────────────────────

// Contact mutations

export interface CreateContactInput {
  companyId: string;
  email?: string | null;
  firstName: string;
  lastName?: string | null;
  metadata?: Record<string, unknown>;
  notes?: string | null;
  phone?: string | null;
  stage?: "lead" | "qualified" | "active" | "closed";
}

export function createContact(orgId: string, input: CreateContactInput): Promise<unknown> {
  return apiFetch(`/api/organizations/${orgId}/contacts`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateContactStage(
  orgId: string,
  contactId: string,
  stage: "lead" | "qualified" | "active" | "closed",
): Promise<unknown> {
  return apiFetch(`/api/organizations/${orgId}/contacts/${contactId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "updateStage", stage }),
  });
}

export function assignContactOwner(
  orgId: string,
  contactId: string,
  ownerProfileId: string,
): Promise<unknown> {
  return apiFetch(`/api/organizations/${orgId}/contacts/${contactId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "assignOwner", ownerProfileId }),
  });
}

export function updateContactNotes(
  orgId: string,
  contactId: string,
  notes: string | null,
): Promise<unknown> {
  return apiFetch(`/api/organizations/${orgId}/contacts/${contactId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "updateNotes", notes }),
  });
}

export interface UpdateContactFields {
  firstName: string;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
}

export function updateContactFields(
  orgId: string,
  contactId: string,
  fields: UpdateContactFields,
): Promise<unknown> {
  return apiFetch(`/api/organizations/${orgId}/contacts/${contactId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "updateContact", ...fields }),
  });
}

// AI

export interface ProposedSlot {
  startsAt: string;
  durationMinutes: number;
  reason: string;
}

export interface ContactAIAnalysis {
  summary: string;
  intent: string;
  urgency: "low" | "medium" | "high";
  fitScore: number;
  suggestedStage: "lead" | "qualified" | "active" | "closed";
  suggestedActions: string[];
  draftedEmail: { subject: string; body: string };
  draftedSms: string;
  proposedSlots: ProposedSlot[];
}

export type AIDraftSendStatus = "draft" | "sent" | "failed";

/** A persisted AI draft — the analysis plus the editable, sendable reply. */
export interface AIDraft {
  id: string;
  organization_id: string;
  company_id: string;
  contact_id: string;
  analysis: ContactAIAnalysis;
  email_subject: string | null;
  email_body: string | null;
  sms_body: string | null;
  proposed_slots: ProposedSlot[];
  booking_id: string | null;
  email_status: AIDraftSendStatus;
  email_sent_at: string | null;
  email_error: string | null;
  sms_status: AIDraftSendStatus;
  sms_sent_at: string | null;
  sms_error: string | null;
  workflow_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AIDraftBooking {
  id: string;
  title: string;
  scheduled_for: string;
}

// NOTE: apiFetch already unwraps the route's { data } envelope, so these return
// its result directly. Reading `.data` off it again yields undefined.

/** Runs Claude and persists the result as a reviewable draft. */
export function analyzeContactAI(orgId: string, contactId: string): Promise<AIDraft> {
  return apiFetch(`/api/organizations/${orgId}/contacts/${contactId}/ai/analyze`, {
    method: "POST",
  });
}

export function fetchContactAIDrafts(orgId: string, contactId: string): Promise<AIDraft[]> {
  return apiFetch(`/api/organizations/${orgId}/contacts/${contactId}/ai/drafts`);
}

export interface UpdateAIDraftInput {
  emailSubject?: string | null;
  emailBody?: string | null;
  smsBody?: string | null;
}

export function updateAIDraft(
  orgId: string,
  contactId: string,
  draftId: string,
  input: UpdateAIDraftInput,
): Promise<AIDraft> {
  return apiFetch(`/api/organizations/${orgId}/contacts/${contactId}/ai/drafts/${draftId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function sendAIDraft(
  orgId: string,
  contactId: string,
  draftId: string,
  channel: "email" | "sms",
): Promise<AIDraft> {
  return apiFetch(`/api/organizations/${orgId}/contacts/${contactId}/ai/drafts/${draftId}/send`, {
    method: "POST",
    body: JSON.stringify({ channel }),
  });
}

export function confirmAIDraftSlot(
  orgId: string,
  contactId: string,
  draftId: string,
  input: { startsAt: string; title?: string },
): Promise<{ booking: AIDraftBooking; draft: AIDraft }> {
  return apiFetch(`/api/organizations/${orgId}/contacts/${contactId}/ai/drafts/${draftId}/booking`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface ContactCallResult {
  agentCallId: string | null;
  toNumber: string;
}

/** Places an on-demand voice call to this contact with the Cartesia agent (Marina). */
export function startContactCall(orgId: string, contactId: string): Promise<ContactCallResult> {
  return apiFetch(`/api/organizations/${orgId}/contacts/${contactId}/call`, {
    method: "POST",
  });
}

// Booking mutations

export interface CreateBookingInput {
  companyId: string;
  contactId?: string | null;
  description?: string | null;
  durationMinutes?: number;
  scheduledFor: string;
  status?: "pending" | "confirmed" | "completed" | "cancelled";
  title: string;
}

export function createBooking(orgId: string, input: CreateBookingInput): Promise<unknown> {
  return apiFetch(`/api/organizations/${orgId}/bookings`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateBookingStatus(
  orgId: string,
  bookingId: string,
  status: "pending" | "confirmed" | "completed" | "cancelled" | "no_show",
): Promise<unknown> {
  return apiFetch(`/api/organizations/${orgId}/bookings/${bookingId}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

// Task mutations

export interface CreateTaskInput {
  assignedToProfileId?: string | null;
  bookingId?: string | null;
  companyId?: string | null;
  contactId?: string | null;
  description?: string | null;
  dueAt?: string | null;
  priority?: "low" | "medium" | "high" | "urgent";
  status?: "todo" | "in_progress" | "blocked" | "completed";
  title: string;
  workflowId?: string | null;
}

export function createTask(orgId: string, input: CreateTaskInput): Promise<unknown> {
  return apiFetch(`/api/organizations/${orgId}/tasks`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateTaskStatus(
  orgId: string,
  taskId: string,
  status: "todo" | "in_progress" | "blocked" | "completed",
): Promise<unknown> {
  return apiFetch(`/api/organizations/${orgId}/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "updateStatus", status }),
  });
}

export function assignTaskUser(
  orgId: string,
  taskId: string,
  assignedToProfileId: string,
): Promise<unknown> {
  return apiFetch(`/api/organizations/${orgId}/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "assignUser", assignedToProfileId }),
  });
}

// Workflow action mutations

export interface RunWorkflowNowInput {
  eventId?: string;
  event?: {
    companyId?: string | null;
    entityId?: string | null;
    entityType: string;
    eventType: string;
    metadata?: Record<string, unknown>;
    relatedEntityId?: string | null;
    relatedEntityType?: string | null;
  };
}

export function runWorkflowNow(
  orgId: string,
  workflowId: string,
  input: RunWorkflowNowInput,
): Promise<unknown> {
  return apiFetch(`/api/organizations/${orgId}/workflows/${workflowId}/run-now`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface RunWorkflowTestInput {
  dryRun?: boolean;
  sampleEvent: {
    companyId?: string | null;
    entityId?: string | null;
    entityType: string;
    eventType: string;
    metadata?: Record<string, unknown>;
    relatedEntityId?: string | null;
    relatedEntityType?: string | null;
  };
}

export function runWorkflowTest(
  orgId: string,
  workflowId: string,
  input: RunWorkflowTestInput,
): Promise<unknown> {
  return apiFetch(`/api/organizations/${orgId}/workflows/${workflowId}/run-test`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function retryWorkflowJob(orgId: string, jobId: string): Promise<unknown> {
  return apiFetch(`/api/organizations/${orgId}/workflow-event-jobs/${jobId}/retry`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function updateWorkflowStatus(
  orgId: string,
  workflowId: string,
  status: "draft" | "active" | "paused" | "archived",
): Promise<unknown> {
  return apiFetch(`/api/organizations/${orgId}/workflows/${workflowId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "updateStatus", status }),
  });
}

export interface UpdateWorkflowInput {
  name?: string;
  description?: string | null;
  triggerEvent?: string;
  definition?: Record<string, unknown>;
  status?: "draft" | "active" | "paused" | "archived";
}

export function updateWorkflow(
  orgId: string,
  workflowId: string,
  input: UpdateWorkflowInput,
): Promise<unknown> {
  return apiFetch(`/api/organizations/${orgId}/workflows/${workflowId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "update", ...input }),
  });
}

export interface CreateWorkflowInput {
  name: string;
  triggerEvent: string;
  definition?: Record<string, unknown>;
  description?: string | null;
  status?: "draft" | "active" | "paused" | "archived";
  companyId?: string | null;
}

export function createWorkflow(orgId: string, input: CreateWorkflowInput): Promise<unknown> {
  return apiFetch(`/api/organizations/${orgId}/workflows`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** An AI-proposed automation, already compiled + validated against the engine schema. */
export interface WorkflowSuggestion {
  name: string;
  rationale: string;
  triggerEvent: string;
  actions: Array<{ type: string; title?: string; priority?: string; status?: string }>;
  definition: Record<string, unknown>;
}

export function suggestWorkflows(orgId: string): Promise<WorkflowSuggestion[]> {
  return apiFetch(`/api/organizations/${orgId}/workflows/suggest`, { method: "POST" });
}

// ─── Organizations & Companies ───────────────────────────────────────────────

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
}

export function fetchOrganizations(): Promise<OrganizationSummary[]> {
  return apiFetch("/api/organizations");
}

export async function updateOrganization(
  orgId: string,
  input: { name?: string; slug?: string },
): Promise<OrganizationSummary> {
  const result = await apiFetch<{ data: OrganizationSummary }>(`/api/organizations/${orgId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  return result.data;
}

export function fetchCompanies(orgId: string): Promise<CompanySummary[]> {
  return apiFetch(`/api/organizations/${orgId}/companies`);
}

export interface CreateCompanyInput {
  name: string;
  stage?: "prospect" | "active" | "paused" | "archived";
  website?: string | null;
  notes?: string | null;
}

export function createCompany(orgId: string, input: CreateCompanyInput): Promise<CompanySummary> {
  return apiFetch(`/api/organizations/${orgId}/companies`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// ─── Internal Ops ─────────────────────────────────────────────────────────────

export interface OpsJobDetailResponse {
  data: {
    id: string;
    activityEventId: string;
    attemptCount: number;
    availableAt: string;
    companyId: string | null;
    companyName: string | null;
    completedAt: string | null;
    createdAt: string;
    lastAttemptedAt: string | null;
    lastError: string | null;
    lockedAt: string | null;
    lockedBy: string | null;
    maxAttempts: number;
    organizationId: string;
    startedAt: string | null;
    status: string;
    updatedAt: string;
    activityEventType: string | null;
    retryEligible: boolean;
    remainingAttempts: number;
  };
}

export interface OpsRunDetailResponse {
  data: {
    id: string;
    workflowId: string;
    workflowName: string | null;
    companyId: string | null;
    companyName: string | null;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    actionsExecutedCount: number;
    createdTasksCount: number;
    timeSavedSeconds: number;
    failureReason: string | null;
    createdAt: string;
    triggerEventId: string | null;
    logs: Array<{
      actionType?: string;
      at: string;
      details?: Record<string, unknown>;
      level: "debug" | "error" | "info" | "warn";
      message: string;
    }>;
  };
}

export interface OpsContactRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  stage: string;
  companyId: string | null;
  companyName: string | null;
  ownerId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  createdAt: string;
}

export interface OpsTaskRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueAt: string | null;
  companyId: string | null;
  companyName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  assigneeEmail: string | null;
  createdAt: string;
  isOverdue: boolean;
}

export interface OpsBookingRow {
  id: string;
  title: string;
  status: string;
  scheduledFor: string;
  durationMinutes: number;
  companyId: string | null;
  companyName: string | null;
  contactId: string | null;
  contactName: string | null;
  description: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface OpsProfileRow {
  id: string;
  email: string;
  fullName: string | null;
}

export function fetchOpsJobDetail(
  orgId: string,
  jobId: string,
): Promise<OpsJobDetailResponse["data"]> {
  return apiFetch(`/api/organizations/${orgId}/ops/jobs/${jobId}`);
}

export function fetchOpsRunDetail(
  orgId: string,
  runId: string,
): Promise<OpsRunDetailResponse["data"]> {
  return apiFetch(`/api/organizations/${orgId}/ops/workflow-runs/${runId}`);
}

export function fetchOpsContacts(
  orgId: string,
  params: { limit?: number } = {},
): Promise<OpsContactRow[]> {
  const searchParams = new URLSearchParams();
  if (params.limit) searchParams.set("limit", String(params.limit));
  const query = searchParams.toString();
  return apiFetch(`/api/organizations/${orgId}/ops/contacts${query ? `?${query}` : ""}`);
}

export function fetchOpsTasks(
  orgId: string,
  params: { limit?: number } = {},
): Promise<OpsTaskRow[]> {
  const searchParams = new URLSearchParams();
  if (params.limit) searchParams.set("limit", String(params.limit));
  const query = searchParams.toString();
  return apiFetch(`/api/organizations/${orgId}/ops/tasks${query ? `?${query}` : ""}`);
}

export function fetchOpsBookings(
  orgId: string,
  params: { limit?: number } = {},
): Promise<OpsBookingRow[]> {
  const searchParams = new URLSearchParams();
  if (params.limit) searchParams.set("limit", String(params.limit));
  const query = searchParams.toString();
  return apiFetch(`/api/organizations/${orgId}/ops/bookings${query ? `?${query}` : ""}`);
}

export function fetchOpsProfiles(
  orgId: string,
): Promise<OpsProfileRow[]> {
  return apiFetch(`/api/organizations/${orgId}/ops/profiles`);
}

export function fetchOpsWorkflowRuns(
  orgId: string,
  params: { status?: string; companyId?: string; workflowId?: string; limit?: number } = {},
): Promise<Array<{
  id: string;
  workflowId: string;
  workflowName: string | null;
  companyId: string | null;
  companyName: string | null;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  actionsExecutedCount: number;
  createdTasksCount: number;
  timeSavedSeconds: number;
  failureReason: string | null;
  createdAt: string;
  triggerEventId: string | null;
}>> {
  const searchParams = new URLSearchParams();
  if (params.status) searchParams.set("status", params.status);
  if (params.companyId) searchParams.set("companyId", params.companyId);
  if (params.workflowId) searchParams.set("workflowId", params.workflowId);
  if (params.limit) searchParams.set("limit", String(params.limit));
  const query = searchParams.toString();
  return apiFetch(`/api/organizations/${orgId}/ops/workflow-runs${query ? `?${query}` : ""}`);
}

export interface OpsJobsHealthResponse {
  data: {
    completedRecentCount: number;
    failedCount: number;
    pendingCount: number;
    runningCount: number;
    suspiciousRunningCount: number;
  };
}

export function fetchOpsJobsHealth(
  orgId: string,
  params: { companyId?: string } = {},
): Promise<OpsJobsHealthResponse["data"]> {
  const searchParams = new URLSearchParams();
  if (params.companyId) searchParams.set("companyId", params.companyId);
  const query = searchParams.toString();
  return apiFetch(`/api/organizations/${orgId}/ops/jobs-health${query ? `?${query}` : ""}`);
}
