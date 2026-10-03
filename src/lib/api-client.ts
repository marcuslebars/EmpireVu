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

export interface ApiClientConfig {
  /** Origin the API is served from, e.g. https://empirevu.com. Empty = same origin (the web SPA). */
  baseUrl: string;
  /**
   * Supabase access token to send as `Authorization: Bearer`. The web SPA leaves this
   * null and relies on the same-origin auth cookie; the mobile app, which runs on a
   * local origin, supplies its session token.
   */
  getAccessToken: (() => Promise<string | null>) | null;
}

const apiConfig: ApiClientConfig = { baseUrl: "", getAccessToken: null };

export function configureApiClient(config: Partial<ApiClientConfig>): void {
  if (config.baseUrl !== undefined) apiConfig.baseUrl = config.baseUrl.replace(/\/$/, "");
  if (config.getAccessToken !== undefined) apiConfig.getAccessToken = config.getAccessToken;
}

/** Absolute URLs (from buildUrl) pass through; `/api/...` paths get the configured origin. */
export function resolveApiUrl(path: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(path) ? path : `${apiConfig.baseUrl}${path}`;
}

export async function apiAuthHeaders(): Promise<Record<string, string>> {
  const token = apiConfig.getAccessToken ? await apiConfig.getAccessToken() : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(resolveApiUrl(path), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(await apiAuthHeaders()),
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
    // Surface the server's actual message (routes return `{ error }`) instead of
    // a generic "API error 500" — otherwise the real reason (bad config, an
    // upstream rejection, a validation message) never reaches the user.
    const serverMessage =
      body && typeof body === "object" && "error" in body &&
      typeof (body as { error: unknown }).error === "string" &&
      (body as { error: string }).error.trim().length > 0
        ? (body as { error: string }).error
        : `API error ${res.status}: ${res.statusText}`;
    throw new ApiError(res.status, serverMessage, body);
  }

  const json = await res.json();
  return json.data as T;
}

function buildUrl(base: string, params: Record<string, string | number | boolean | null | undefined>): string {
  const url = new URL(base, apiConfig.baseUrl || window.location.origin);
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

export function fetchDashboardSummary(
  orgId: string,
  params: { companyId?: string } = {},
): Promise<DashboardSummary> {
  return apiFetch(buildUrl(`/api/organizations/${orgId}/ui/dashboard/summary`, params));
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

/**
 * All-time totals — the endpoint takes no time window. Scoped to one company when
 * `companyId` is given; omitting it means "All companies", as on every other tile.
 */
export function fetchAutomationImpact(
  orgId: string,
  params: { companyId?: string } = {},
): Promise<AutomationImpact> {
  return apiFetch(buildUrl(`/api/organizations/${orgId}/ui/dashboard/automation-impact`, params));
}

// ─── Attribution ("Captured by EmpireVu") ─────────────────────────────────────

export interface AttributionBreakdownEntry {
  key: string;
  count: number;
  approvedCents: number;
  paidCents: number;
}

export interface AttributionSegment {
  count: number;
  approvedCents: number;
  paidCents: number;
}

export interface AttributionSummary {
  quotesCount: number;
  approvedCentsTotal: number;
  paidCentsTotal: number;
  voiceAi: AttributionSegment;
  automation: AttributionSegment;
  estimatedTimeSavedSeconds: number;
  bySource: AttributionBreakdownEntry[];
  byChannel: AttributionBreakdownEntry[];
}

export interface AttributionRow {
  quoteId: string;
  contactId: string | null;
  companyId: string | null;
  autoGenerated: boolean;
  firstTouchSource: string;
  firstTouchChannel: string;
  firstTouchAt: string | null;
  voiceAiInvolved: boolean;
  automationInvolved: boolean;
  approvedCents: number;
  paidCents: number;
  approvedAt: string | null;
  paidAt: string | null;
}

export interface AttributionResponse {
  range: { from: string; to: string };
  summary: AttributionSummary;
  rows?: AttributionRow[];
}

export function fetchAttribution(
  orgId: string,
  params: { companyId?: string; from?: string; to?: string; rows?: boolean } = {},
): Promise<AttributionResponse> {
  return apiFetch(
    buildUrl(`/api/organizations/${orgId}/ui/attribution`, {
      companyId: params.companyId,
      from: params.from,
      to: params.to,
      rows: params.rows ? "1" : undefined,
    }),
  );
}

// ─── Monthly results scorecard ─────────────────────────────────────────────────
// Mirrors src/server/services/monthly-scorecard/scorecard.ts (MonthlyScorecard / ScorecardView).

export type ScorecardLeadSource = "web_form" | "phone_ai" | "missed_call" | "text" | "referral" | "other";

export interface ScorecardMetrics {
  leads: { total: number; bySource: Record<ScorecardLeadSource, number> };
  missedCalls: { caught: number; textedBack: number };
  messages: { sent: number; automated: number; sms: number; email: number };
  automationsRun: number;
  firstResponse: { medianSeconds: number | null; responded: number; within5Min: number };
  quotes: {
    sent: number;
    approved: number;
    approvedCents: number;
    depositsCollected: number;
    depositCents: number;
    sentThenApproved: number;
    currency: string;
  };
  jobsBooked: number;
  jobsCompleted: number;
  reviewsRequested: number;
  receptionist: { callsHandled: number; minutes: number };
  attributedRevenue: { approvedCents: number; paidCents: number };
  recipeStatus: Record<string, string>;
}

export interface ScorecardMetricDelta {
  current: number;
  previous: number;
  change: number;
  pct: number | null;
}

export interface ScorecardSuggestion {
  id: string;
  title: string;
  detail: string;
  recipeSlug: string | null;
}

export interface MonthlyScorecard {
  companyId: string;
  companyName: string;
  month: string;
  monthLabel: string;
  monthLabelLong: string;
  timeZone: string;
  range: { from: string; to: string };
  partial: boolean;
  firstMonth: boolean;
  hasActivity: boolean;
  metrics: ScorecardMetrics;
  previous: ScorecardMetrics | null;
  deltas: {
    leads: ScorecardMetricDelta;
    missedCallsCaught: ScorecardMetricDelta;
    messagesSent: ScorecardMetricDelta;
    jobsBooked: ScorecardMetricDelta;
    quotesSent: ScorecardMetricDelta;
    quotesApproved: ScorecardMetricDelta;
    depositCents: ScorecardMetricDelta;
    attributedPaidCents: ScorecardMetricDelta;
    reviewsRequested: ScorecardMetricDelta;
    callsHandled: ScorecardMetricDelta;
    medianResponseSeconds: ScorecardMetricDelta | null;
  } | null;
  suggestions: ScorecardSuggestion[];
  operatorNote: string | null;
  lastSend: { status: string; emailStatus: string | null; sentAt: string | null; sendCount: number } | null;
}

export interface MonthlyScorecardView {
  companyId: string;
  companyName: string;
  timeZone: string;
  settings: { enabled: boolean };
  /** [this month so far, last month]. */
  months: MonthlyScorecard[];
}

export function fetchMonthlyScorecard(orgId: string, companyId: string): Promise<MonthlyScorecardView> {
  return apiFetch(buildUrl(`/api/organizations/${orgId}/ui/monthly-scorecard`, { companyId }));
}

export function updateMonthlyScorecard(
  orgId: string,
  input: { companyId: string; month?: string; operatorNote?: string | null; enabled?: boolean },
): Promise<{ operatorNote?: string | null; settings?: { enabled: boolean } }> {
  return apiFetch(`/api/organizations/${orgId}/ui/monthly-scorecard`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

// ─── Owner daily digest ────────────────────────────────────────────────────────

export type DigestChannel = "email" | "sms";

export interface DigestSettings {
  enabled: boolean;
  sendAtLocal: string;
  channels: DigestChannel[];
  alwaysSend: boolean;
}

export interface DigestTestResult {
  companyId: string;
  sent: boolean;
  quiet: boolean;
  smsStatus: string | null;
  emailStatus: string | null;
  channelsSent: string[];
}

export function fetchDigestSettings(orgId: string, companyId: string): Promise<DigestSettings> {
  return apiFetch(buildUrl(`/api/organizations/${orgId}/ui/digest`, { companyId }));
}

export function updateDigestSettings(
  orgId: string,
  companyId: string,
  patch: Partial<Omit<DigestSettings, "channels">> & { channels?: DigestChannel[] },
): Promise<DigestSettings> {
  return apiFetch(`/api/organizations/${orgId}/ui/digest`, {
    method: "PUT",
    body: JSON.stringify({ companyId, ...patch }),
  });
}

export function sendTestDigest(orgId: string, companyId: string): Promise<DigestTestResult> {
  return apiFetch(`/api/organizations/${orgId}/ui/digest/test`, {
    method: "POST",
    body: JSON.stringify({ companyId }),
  });
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
  comments: Array<{
    author: ActorSummary | null;
    body: string;
    createdAt: string;
    id: string;
  }>;
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
    /** The business account this contact bills to, if any. */
    customerAccountId: string | null;
    email: string | null;
    id: string;
    metadata: Record<string, unknown>;
    name: string;
    notes: string | null;
    owner: UserSummary | null;
    phone: string | null;
    stage: string;
  };
  comments: Array<{
    author: ActorSummary | null;
    body: string;
    createdAt: string;
    id: string;
  }>;
  financialSummary: {
    pipelineValueCents: number | null;
    realizedRevenueCents: number;
    upcomingRevenueCents: number;
  };
  linkedBookings: BookingCalendarRow[];
  linkedTasks: TaskListRow[];
  linkedQuotes: Array<{
    id: string;
    quoteNumber: string | null;
    status: string;
    title: string | null;
    totalCents: number;
    depositCents: number;
    currency: string;
    publicToken: string;
    createdAt: string;
  }>;
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
      resumeAt: string | null;
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

export interface OrganizationMemberSummary {
  email: string;
  id: string;
  name: string;
  role: string;
}

/** Team members of the organization — used to populate assignee/owner pickers. */
export function fetchOrganizationMembers(orgId: string): Promise<OrganizationMemberSummary[]> {
  return apiFetch(`/api/organizations/${orgId}/members`);
}

export function deleteContact(orgId: string, contactId: string): Promise<{ id: string }> {
  return apiFetch(`/api/organizations/${orgId}/contacts/${contactId}`, { method: "DELETE" });
}

// ─── Team members & invitations ──────────────────────────────────────────────

export type MembershipRole = "owner" | "admin" | "member";

export interface InvitationSummary {
  createdAt: string;
  email: string;
  expiresAt: string;
  id: string;
  role: MembershipRole;
  status: string;
  token: string;
}

export interface CreateInvitationResult {
  emailSent: boolean;
  invitation: InvitationSummary;
  inviteUrl: string;
}

export interface InvitationPreview {
  email: string;
  expired: boolean;
  organizationId: string;
  organizationName: string;
  role: MembershipRole;
  status: string;
}

export function fetchInvitations(orgId: string): Promise<InvitationSummary[]> {
  return apiFetch(`/api/organizations/${orgId}/members/invitations`);
}

export function createInvitation(
  orgId: string,
  input: { email: string; role: "admin" | "member" },
): Promise<CreateInvitationResult> {
  return apiFetch(`/api/organizations/${orgId}/members/invitations`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function revokeInvitation(orgId: string, invitationId: string): Promise<{ id: string }> {
  return apiFetch(`/api/organizations/${orgId}/members/invitations/${invitationId}`, { method: "DELETE" });
}

export function updateMemberRole(
  orgId: string,
  profileId: string,
  role: MembershipRole,
): Promise<OrganizationMemberSummary> {
  return apiFetch(`/api/organizations/${orgId}/members/${profileId}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

export function removeMember(orgId: string, profileId: string): Promise<{ id: string }> {
  return apiFetch(`/api/organizations/${orgId}/members/${profileId}`, { method: "DELETE" });
}

export function fetchInvitationPreview(token: string): Promise<InvitationPreview> {
  return apiFetch(`/api/invitations/${token}`);
}

export function acceptInvitation(token: string): Promise<{ organizationId: string }> {
  return apiFetch(`/api/invitations/${token}/accept`, { method: "POST" });
}

// ─── Billing ─────────────────────────────────────────────────────────────────

export type PurchasablePlan = "launch" | "operate" | "front_desk";

export interface BillingState {
  gating: Record<string, boolean>;
  organization: {
    id: string;
    name: string;
    plan: string;
    subscription_status: string;
    stripe_customer_id: string | null;
    trial_ends_at: string | null;
    /** CrankLeads offer bought (catch | close | front_desk), null otherwise. */
    crankleads_tier?: string | null;
  };
  subscription: {
    current_period_end: string | null;
    plan: string;
    status: string;
    stripe_subscription_id: string;
  } | null;
}

export interface PlanPricing {
  amountCents: number | null;
  available: boolean;
  currency: string | null;
  features: Record<string, boolean>;
  interval: string | null;
  plan: PurchasablePlan;
  priceId: string | null;
  setupFeeCents: number | null;
}

export function fetchBilling(orgId: string): Promise<BillingState> {
  return apiFetch(`/api/organizations/${orgId}/billing`);
}

export function fetchBillingPlans(orgId: string): Promise<PlanPricing[]> {
  return apiFetch(`/api/organizations/${orgId}/billing/plans`);
}

export function createCheckout(orgId: string, plan: PurchasablePlan): Promise<{ sessionId: string; url: string }> {
  return apiFetch(`/api/organizations/${orgId}/billing/checkout`, {
    method: "POST",
    body: JSON.stringify({ plan }),
  });
}

export function createBillingPortal(orgId: string): Promise<{ url: string }> {
  return apiFetch(`/api/organizations/${orgId}/billing/portal`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export interface MonthlyUsage {
  voiceMinutes: number;
  voiceMinutesCap: number | null;
  voiceOverageMinutes: number;
  smsSent: number;
  smsReceived: number;
  emailsSent: number;
  aiCostCents: number;
  totalCostCents: number;
}

export function fetchMonthlyUsage(orgId: string): Promise<MonthlyUsage> {
  return apiFetch(`/api/organizations/${orgId}/usage/monthly`);
}

// ── Integrations: intake keys + voice numbers (Task 7) ───────────────────────

export interface IntakeKey {
  id: string;
  companyId: string | null;
  keyPrefix: string;
  label: string | null;
  active: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface CreatedIntakeKey {
  key: string;
  keyPrefix: string;
  view: IntakeKey;
}

export function fetchIntakeKeys(orgId: string): Promise<IntakeKey[]> {
  return apiFetch(`/api/organizations/${orgId}/intake-keys`);
}

export function createIntakeKey(
  orgId: string,
  input: { companyId?: string | null; label?: string | null },
): Promise<CreatedIntakeKey> {
  return apiFetch(`/api/organizations/${orgId}/intake-keys`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function revokeIntakeKey(orgId: string, keyId: string): Promise<{ ok: true }> {
  return apiFetch(`/api/organizations/${orgId}/intake-keys/${keyId}/revoke`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export interface VoiceNumber {
  id: string;
  companyId: string;
  phoneE164: string;
  provider: string;
  providerAgentId: string | null;
  brandLabel: string | null;
  active: boolean;
  createdAt: string;
}

export function fetchVoiceNumbers(orgId: string): Promise<VoiceNumber[]> {
  return apiFetch(`/api/organizations/${orgId}/voice-numbers`);
}

export function createVoiceNumber(
  orgId: string,
  input: {
    companyId: string;
    phone: string;
    provider: "retell" | "telnyx";
    providerAgentId?: string | null;
    brandLabel?: string | null;
  },
): Promise<VoiceNumber> {
  return apiFetch(`/api/organizations/${orgId}/voice-numbers`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function deactivateVoiceNumber(orgId: string, numberId: string): Promise<{ ok: true }> {
  return apiFetch(`/api/organizations/${orgId}/voice-numbers/${numberId}/deactivate`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

// ─── Payments (Stripe Connect) ───────────────────────────────────────────────

export type ConnectState = "not_connected" | "onboarding_incomplete" | "ready";

export interface CompanyConnectStatus {
  companyId: string;
  companyName: string | null;
  accountId: string | null;
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  state: ConnectState;
  requirements: string[];
}

export function fetchConnectAccounts(orgId: string): Promise<CompanyConnectStatus[]> {
  return apiFetch(`/api/organizations/${orgId}/connect`);
}

export function createConnectOnboarding(orgId: string, companyId: string): Promise<{ url: string }> {
  return apiFetch(`/api/organizations/${orgId}/connect/${companyId}/onboarding`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function refreshConnectAccount(orgId: string, companyId: string): Promise<CompanyConnectStatus> {
  return apiFetch(`/api/organizations/${orgId}/connect/${companyId}/refresh`, {
    method: "POST",
    body: JSON.stringify({}),
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

/** Pulls outcomes for this contact's finished calls. Idempotent. */
export function syncContactCalls(orgId: string, contactId: string): Promise<{ synced: number }> {
  return apiFetch(`/api/organizations/${orgId}/contacts/${contactId}/calls/sync`, {
    method: "POST",
  });
}

// ─── Call recordings & transcripts ─────────────────────────────────────────────

export interface CallTranscriptSegment {
  role: string;
  content: string;
}

export interface ContactCall {
  id: string;
  callId: string;
  direction: string | null;
  startedAt: string | null;
  durationSeconds: number | null;
  summary: string | null;
  sentiment: string | null;
  inVoicemail: boolean;
  recordingUrl: string | null;
  transcript: string | null;
  segments: CallTranscriptSegment[];
}

/** This contact's Marina calls — recording URL + transcript, newest first. */
export function fetchContactCalls(orgId: string, contactId: string): Promise<ContactCall[]> {
  return apiFetch(`/api/organizations/${orgId}/contacts/${contactId}/calls`);
}

/** Places an ad-hoc call to a raw number with Marina — no contact record needed. */
export function startQuickCall(
  orgId: string,
  input: { phone: string; name?: string },
): Promise<ContactCallResult> {
  return apiFetch(`/api/organizations/${orgId}/voice/call`, {
    method: "POST",
    body: JSON.stringify(input),
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

export interface RescheduleBookingInput {
  scheduledFor: string;
  durationMinutes?: number;
}

export function rescheduleBooking(
  orgId: string,
  bookingId: string,
  input: RescheduleBookingInput,
): Promise<unknown> {
  return apiFetch(`/api/organizations/${orgId}/bookings/${bookingId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
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

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  priority?: "low" | "medium" | "high" | "urgent";
  dueAt?: string | null;
}

export function updateTask(orgId: string, taskId: string, input: UpdateTaskInput): Promise<unknown> {
  return apiFetch(`/api/organizations/${orgId}/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "updateTask", ...input }),
  });
}

export function deleteTask(orgId: string, taskId: string): Promise<{ id: string }> {
  return apiFetch(`/api/organizations/${orgId}/tasks/${taskId}`, { method: "DELETE" });
}

// Workflow action mutations

export interface RunWorkflowNowInput {
  dryRun?: boolean;
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

/** A proven starter automation (Task 10), annotated for a company. */
export interface RecipeCatalogEntry {
  slug: string;
  name: string;
  description: string;
  triggerEvent: string;
  defaultStatus: "active" | "draft";
  requires: Array<"sms" | "email" | "voice">;
  estimatedTimeSavedSeconds: number;
  textsCustomers: boolean;
  missingRequirements: Array<"sms" | "email" | "voice">;
  installed: boolean;
  installedWorkflowId: string | null;
}

export function fetchRecipeCatalog(orgId: string, companyId?: string | null): Promise<RecipeCatalogEntry[]> {
  const qs = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
  return apiFetch(`/api/organizations/${orgId}/workflows/recipes${qs}`);
}

export interface InstallRecipesResult {
  installed: Array<{ slug: string; workflowId: string; status: "active" | "draft"; disabledReason: string | null }>;
  skipped: Array<{ slug: string; reason: string }>;
}

export function installRecipes(
  orgId: string,
  input: { companyId: string; only?: string[] },
): Promise<InstallRecipesResult> {
  return apiFetch(`/api/organizations/${orgId}/workflows/recipes/install`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// ─── Unified inbox (Task 12) ─────────────────────────────────────────────────

/** One conversation row in the org-level inbox list (ui_inbox_v). */
export interface InboxRow {
  organization_id: string | null;
  contact_id: string | null;
  company_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  company_name: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_activity_at: string | null;
  needs_reply: boolean | null;
  unread: boolean | null;
  channel: string | null;
  snippet: string | null;
  search_text: string | null;
}

/** One item in a contact's unified conversation thread (ui_conversation_thread). */
export interface ConversationThreadItem {
  id: string;
  kind: "message" | "call" | "event" | "draft" | "lead" | string;
  occurred_at: string;
  direction: string | null;
  channel: string | null;
  title: string | null;
  body: string | null;
  status: string | null;
  metadata: Record<string, unknown>;
}

/** The route's own default is 50 and its ceiling is 100; ask for the ceiling so counts
 * taken from `rows.length` — the Home tile, the tab badge — aren't quietly capped at 50.
 * `limit` stays optional, so existing callers are unaffected. */
export const INBOX_MAX_LIMIT = 100;

export function fetchInbox(
  orgId: string,
  params: { companyId?: string | null; needsReply?: boolean; search?: string | null; limit?: number } = {},
): Promise<InboxRow[]> {
  const qs = new URLSearchParams();
  if (params.companyId) qs.set("companyId", params.companyId);
  if (params.needsReply) qs.set("needsReply", "true");
  if (params.search) qs.set("search", params.search);
  qs.set("limit", String(params.limit ?? INBOX_MAX_LIMIT));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiFetch(`/api/organizations/${orgId}/inbox${suffix}`);
}

export function fetchConversationThread(
  orgId: string,
  contactId: string,
  params: { before?: string | null; limit?: number } = {},
): Promise<ConversationThreadItem[]> {
  const qs = new URLSearchParams();
  if (params.before) qs.set("before", params.before);
  if (params.limit) qs.set("limit", String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiFetch(`/api/organizations/${orgId}/inbox/${contactId}${suffix}`);
}

export function markContactRead(orgId: string, contactId: string): Promise<{ lastReadAt: string }> {
  return apiFetch(`/api/organizations/${orgId}/inbox/${contactId}/read`, { method: "POST" });
}

export interface SendMessageResult {
  status: "sent" | "failed" | "blocked";
  reason?: string;
  providerRef?: string | null;
  body: string;
}

export function sendContactMessage(
  orgId: string,
  contactId: string,
  input: { channel: "sms" | "email"; body: string; subject?: string },
): Promise<SendMessageResult> {
  return apiFetch(`/api/organizations/${orgId}/contacts/${contactId}/messages`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// ─── Onboarding wizard (Task 13) ─────────────────────────────────────────────

export interface OnboardingProgressStep {
  step: string;
  status: string;
  data: Record<string, unknown>;
  completed_at: string | null;
}
export interface OnboardingProgressResponse {
  company: { id: string; name: string } | null;
  steps: OnboardingProgressStep[];
  nextStep?: string;
}
export interface CatalogDraft {
  name: string;
  description?: string | null;
  pricingType: string;
  baseCents?: number | null;
}

export function fetchOnboardingProgress(orgId: string): Promise<OnboardingProgressResponse> {
  return apiFetch(`/api/organizations/${orgId}/onboarding/progress`);
}

/** CrankLeads setup checklist (server: services/crankleads/setup-checklist.ts). */
export interface SetupChecklistStep {
  key: "services" | "phone" | "forwarding" | "test_call" | "payments" | "website" | "automations";
  title: string;
  action: string;
  done: boolean;
  wizardStep: string;
  path: string;
  deepLink: string;
}
export interface SetupChecklist {
  organizationId: string;
  companyId: string;
  tier: "catch" | "close" | "front_desk";
  phonePath: "missed_call_catcher" | "ai_receptionist";
  steps: SetupChecklistStep[];
  doneCount: number;
  totalCount: number;
  isLive: boolean;
  nextStep: SetupChecklistStep | null;
}

/** null for orgs that aren't CrankLeads purchases. */
export function fetchSetupChecklist(orgId: string): Promise<SetupChecklist | null> {
  return apiFetch(`/api/organizations/${orgId}/setup-checklist`);
}

export function upsertOnboardingStep(
  orgId: string,
  input: { companyId: string; step: string; status?: string; data?: Record<string, unknown>; completed?: boolean; event?: "start" | "complete" | "error" },
): Promise<OnboardingProgressStep> {
  return apiFetch(`/api/organizations/${orgId}/onboarding/progress`, { method: "POST", body: JSON.stringify(input) });
}

export interface SaveBusinessInput {
  companyId?: string;
  name: string;
  website?: string | null;
  timezone?: string | null;
  hours?: Record<string, unknown> | null;
  serviceArea?: string | null;
  ownerEmail?: string | null;
  ownerPhone?: string | null;
  brandLogoUrl?: string | null;
  brandPrimaryColor?: string | null;
  brandAccentColor?: string | null;
}
export function saveOnboardingBusiness(orgId: string, input: SaveBusinessInput): Promise<{ company: { id: string; name: string } }> {
  return apiFetch(`/api/organizations/${orgId}/onboarding/business`, { method: "POST", body: JSON.stringify(input) });
}

/** Multipart logo upload (raw fetch — apiFetch forces JSON). Returns the public URL. */
export async function uploadOnboardingLogo(orgId: string, companyId: string, file: File): Promise<{ url: string }> {
  const form = new FormData();
  form.set("companyId", companyId);
  form.set("file", file);
  const res = await fetch(resolveApiUrl(`/api/organizations/${orgId}/onboarding/logo`), {
    method: "POST",
    body: form,
    headers: await apiAuthHeaders(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (json as { error?: string }).error ?? `Upload failed (${res.status})`, json);
  return (json as { data: { url: string } }).data;
}

export function parseWebsiteCatalog(orgId: string, url: string): Promise<{ drafts: CatalogDraft[]; sourceChars: number }> {
  return apiFetch(`/api/organizations/${orgId}/onboarding/services/parse`, { method: "POST", body: JSON.stringify({ url }) });
}

export interface CatalogItemInput {
  label: string;
  description?: string | null;
  pricingType: string;
  rateCents: number;
  minimumCents?: number;
  unitLabel?: string | null;
}
export function saveCatalogItems(orgId: string, companyId: string, items: CatalogItemInput[]): Promise<{ created: number }> {
  return apiFetch(`/api/organizations/${orgId}/onboarding/services`, { method: "POST", body: JSON.stringify({ companyId, items }) });
}

export function fetchOnboardingPhoneNumbers(
  orgId: string,
): Promise<{ configured: boolean; numbers: Array<{ phoneNumber: string; pretty: string | null }> }> {
  return apiFetch(`/api/organizations/${orgId}/onboarding/phone`);
}
export function provisionOnboardingPhone(
  orgId: string,
  input: { companyId: string; areaCode?: number; attachNumber?: string },
): Promise<{ phoneNumber: string; phoneNumberPretty: string | null; purchased: boolean }> {
  return apiFetch(`/api/organizations/${orgId}/onboarding/phone`, { method: "POST", body: JSON.stringify(input) });
}

export function sendOnboardingTestLead(orgId: string, companyId: string): Promise<{ leadId: string }> {
  return apiFetch(`/api/organizations/${orgId}/onboarding/test-lead`, { method: "POST", body: JSON.stringify({ companyId }) });
}

export interface OnboardingFunnelStep {
  step: string;
  started: number;
  completed: number;
  medianSeconds: number | null;
}
export interface OnboardingFunnel {
  steps: OnboardingFunnelStep[];
  companiesStarted: number;
  companiesCompletedAll: number;
  overallMedianSeconds: number | null;
}
export function fetchOnboardingFunnel(opsToken: string): Promise<OnboardingFunnel> {
  return apiFetch(`/api/ops/onboarding-funnel`, { headers: { Authorization: `Bearer ${opsToken}` } });
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
  return apiFetch<OrganizationSummary>(`/api/organizations/${orgId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export interface CreateOrganizationInput {
  name: string;
  slug?: string;
}

export function createOrganization(input: CreateOrganizationInput): Promise<OrganizationSummary> {
  return apiFetch("/api/organizations", {
    method: "POST",
    body: JSON.stringify(input),
  });
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

// ─── Voice profiles (Marina outbound) ─────────────────────────────────────────

export interface VoiceProfile {
  companyId: string;
  retellOutboundAgentId: string | null;
  fromNumber: string | null;
  brandLabel: string | null;
  systemPrompt: string | null;
  dynamicVariables: Record<string, string>;
  active: boolean;
}

export interface UpsertVoiceProfileInput {
  companyId: string;
  retellOutboundAgentId?: string | null;
  fromNumber?: string | null;
  brandLabel?: string | null;
  systemPrompt?: string | null;
  dynamicVariables?: Record<string, string>;
  active?: boolean;
}

export function fetchVoiceProfiles(orgId: string): Promise<VoiceProfile[]> {
  return apiFetch(`/api/organizations/${orgId}/voice-profiles`);
}

export function upsertVoiceProfile(orgId: string, input: UpsertVoiceProfileInput): Promise<VoiceProfile> {
  return apiFetch(`/api/organizations/${orgId}/voice-profiles`, {
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

// ─── Quotes (Stripe-native) ──────────────────────────────────────────────────
// Every route 404s while STRIPE_QUOTES_ENABLED is off, which the Quotes screen
// surfaces as "not enabled for this org" rather than an error.

export interface QuoteSummary {
  id: string;
  quote_number: string | null;
  public_token: string;
  status: string;
  title: string | null;
  intro_message: string | null;
  currency: string;
  line_items: unknown;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  deposit_cents: number;
  bundle_id: string | null;
  input_snapshot: unknown;
  notes: string | null;
  valid_until: string | null;
  sent_at: string | null;
  auto_generated: boolean;
  created_at: string;
}

/** The create/update payload — mirrors the route's zod schema. */
export interface QuoteWritePayload {
  contactId?: string;
  companyId?: string;
  services: {
    serviceId: string;
    lengthFt?: number;
    engineType?: "outboard" | "sterndrive" | "inboard";
    engineCount?: number;
    quantity?: number;
    distanceKm?: number;
    optional?: boolean;
    selected?: boolean;
    /** Modifier choices (tier, boat type…) keyed by group. */
    modifiers?: Record<string, string>;
  }[];
  customLines?: {
    label: string;
    description?: string;
    amountCents: number;
    optional?: boolean;
    selected?: boolean;
  }[];
  hullType?: string;
  bundleId?: string;
  title?: string;
  introMessage?: string;
  notes?: string;
}

export interface FetchQuotesOptions {
  /**
   * The auto-quote review window: machine-written quotes that are out with a
   * customer and not yet paid — the only window where a wrong price can still be
   * voided and reissued for free.
   */
  review?: boolean;
  limit?: number;
}

export function fetchQuotes(orgId: string, opts: FetchQuotesOptions = {}): Promise<QuoteSummary[]> {
  const params = new URLSearchParams();
  if (opts.review) params.set("review", "1");
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return apiFetch<QuoteSummary[]>(`/api/organizations/${orgId}/quotes${qs ? `?${qs}` : ""}`);
}

export function createQuote(orgId: string, payload: QuoteWritePayload): Promise<QuoteSummary> {
  return apiFetch<QuoteSummary>(`/api/organizations/${orgId}/quotes`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateQuote(
  orgId: string,
  quoteId: string,
  payload: QuoteWritePayload,
): Promise<QuoteSummary> {
  return apiFetch<QuoteSummary>(`/api/organizations/${orgId}/quotes/${quoteId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export interface EmailOutcome {
  delivered: boolean;
  reason: string | null;
}

export interface SendQuoteResult {
  quote: QuoteSummary;
  email: EmailOutcome;
}

/**
 * Draft → sent: allocates the quote number and stamps valid_until.
 *
 * Resolves even when the email does not go out. The quote is sent either way —
 * numbered, stamped and payable — and `email.delivered` says whether anyone was
 * mailed. Treating a failed email as a failed send previously produced a 500 for
 * a quote that was live, which is worse than saying so plainly.
 */
export async function sendQuote(orgId: string, quoteId: string): Promise<SendQuoteResult> {
  const res = await fetch(resolveApiUrl(`/api/organizations/${orgId}/quotes/${quoteId}/send`), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await apiAuthHeaders()) },
  });
  const body = (await res.json().catch(() => ({}))) as {
    data?: QuoteSummary;
    email?: EmailOutcome;
    error?: string;
  };
  if (!res.ok || !body.data) {
    throw new ApiError(res.status, body.error ?? `API error ${res.status}: ${res.statusText}`, body);
  }
  return { quote: body.data, email: body.email ?? { delivered: true, reason: null } };
}

/** Void a quote (status → cancelled), with no successor. */
export function voidQuote(orgId: string, quoteId: string): Promise<QuoteSummary> {
  return apiFetch<QuoteSummary>(`/api/organizations/${orgId}/quotes/${quoteId}/void`, {
    method: "POST",
  });
}

// ─── Comments (polymorphic across entities) ──────────────────────────────────

export interface CreateCommentInput {
  body: string;
  entityType: "company" | "contact" | "booking" | "task" | "workflow" | "workflow_run" | "activity_event";
  entityId: string;
  companyId?: string | null;
}

/** Post a comment on any entity; the entity's detail view returns the thread. */
export function createComment(orgId: string, input: CreateCommentInput): Promise<{ id: string }> {
  return apiFetch(`/api/organizations/${orgId}/comments`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// ─── Industry starter packs ──────────────────────────────────────────────────

export interface IndustryPackService {
  key: string;
  label: string;
  /** Singular unit noun — shown as "per <unit>". */
  unit: string;
  pricingType: string;
  category: string;
  description: string;
}

export interface IndustryPackSummary {
  id: string;
  version: number;
  name: string;
  tagline: string;
  description: string;
  services: IndustryPackService[];
  recipes: string[];
  reviewRequestDelay: string;
  hasBookingDefaults: boolean;
}

export interface AppliedIndustryPack {
  id: string;
  version: number;
  appliedAt: string;
  recipes: string[];
}

export interface NeedsPriceItem {
  id: string;
  label: string;
  unit: string | null;
  pricingType: string;
}

export interface IndustryPackListing {
  packs: IndustryPackSummary[];
  applied: AppliedIndustryPack | null;
  needsPrices: NeedsPriceItem[];
}

export interface ApplyIndustryPackInput {
  companyId: string;
  packId: string;
  services?: boolean;
  recipes?: "all" | "none" | string[];
  bookingPolicy?: boolean;
}

export interface ApplyIndustryPackReport {
  pack: { id: string; version: number; name: string };
  services: { created: Array<{ id: string; label: string }>; skipped: Array<{ label: string; reason: string }> };
  needsPrices: NeedsPriceItem[];
  recipes: {
    installed: Array<{ slug: string; workflowId: string; status: "active" | "draft"; disabledReason: string | null }>;
    updated: Array<{ slug: string; workflowId: string }>;
    unchanged: string[];
    skippedOwnerEdited: Array<{ slug: string; workflowId: string }>;
  };
  bookingPolicy: "applied" | "kept_existing" | "not_requested" | "not_in_pack";
  applied: AppliedIndustryPack;
}

export function fetchIndustryPacks(orgId: string, companyId?: string | null): Promise<IndustryPackListing> {
  const qs = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
  return apiFetch(`/api/organizations/${orgId}/industry-packs${qs}`);
}

export function applyIndustryPack(orgId: string, input: ApplyIndustryPackInput): Promise<ApplyIndustryPackReport> {
  return apiFetch(`/api/organizations/${orgId}/industry-packs/apply`, { method: "POST", body: JSON.stringify(input) });
}

export function saveCatalogPrices(
  orgId: string,
  input: { companyId: string; items: Array<{ id: string; rateCents: number }> },
): Promise<{ updated: number }> {
  return apiFetch(`/api/organizations/${orgId}/industry-packs/prices`, { method: "PATCH", body: JSON.stringify(input) });
}

// ── Missed-call catcher (docs/missed-call-catcher.md) ───────────────────────────
type ForwardingInstructions = import("./carrier-forwarding").ForwardingInstructions;

export interface MissedCallCatcherStatus {
  configured: boolean;
  number: { id: string; phoneNumber: string; phoneNumberPretty: string; createdAt: string } | null;
  instructions: ForwardingInstructions | null;
}

export interface MissedCallCatcherProvisionResult {
  phoneNumber: string;
  phoneNumberPretty: string;
  numberSid: string;
  purchased: boolean;
  webhooksUpdated: boolean;
  instructions: ForwardingInstructions;
}

export function getMissedCallCatcher(orgId: string, companyId: string): Promise<MissedCallCatcherStatus> {
  return apiFetch(`/api/organizations/${orgId}/missed-call-catcher?companyId=${encodeURIComponent(companyId)}`);
}

export function provisionMissedCallCatcher(
  orgId: string,
  input: { companyId: string; areaCode?: number; attachNumber?: string },
): Promise<MissedCallCatcherProvisionResult> {
  return apiFetch(`/api/organizations/${orgId}/missed-call-catcher`, { method: "POST", body: JSON.stringify(input) });
}

// ── Forwarding verification (docs/missed-call-catcher.md → Forwarding verification) ──
export type ForwardingTestStatus = "calling" | "passed" | "answered" | "busy" | "not_forwarded" | "failed";

export interface ForwardingTestView {
  id: string;
  status: ForwardingTestStatus;
  trigger: "owner" | "scheduled";
  startedAt: string;
  completedAt: string | null;
  callerId: string;
  callerIdPretty: string;
  businessLinePretty: string;
  answeredBy: string | null;
  errorMessage: string | null;
}

export interface ForwardingVerificationStatus {
  hasCatcher: boolean;
  verifiedAt: string | null;
  lastTestAt: string | null;
  lastTestResult: string | null;
  businessLinePretty: string | null;
  callerIdPretty: string | null;
  blockedReason: string | null;
  latestTest: ForwardingTestView | null;
}

export function getForwardingVerification(orgId: string, companyId: string): Promise<ForwardingVerificationStatus> {
  return apiFetch(
    `/api/organizations/${orgId}/missed-call-catcher/forwarding-test?companyId=${encodeURIComponent(companyId)}`,
  );
}

export function startForwardingTest(orgId: string, companyId: string): Promise<ForwardingTestView> {
  return apiFetch(`/api/organizations/${orgId}/missed-call-catcher/forwarding-test`, {
    method: "POST",
    body: JSON.stringify({ companyId }),
  });
}
