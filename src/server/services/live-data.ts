import type { Json, Tables } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";
import { listComments } from "@/server/services/comments";
import {
  getWorkflowEventJobsHealthSummary,
  isWorkflowEventJobRetryEligible,
  listWorkflowEventJobs,
} from "@/server/services/workflow-event-jobs";
import { getContactTrace, getBookingTrace, getTaskTrace } from "@/server/services/traces";
import { getQuotesConfig } from "@/server/services/quotes/config";
import { listQuotes } from "@/server/services/quotes/service";
import {
  assertCompanyInOrganization,
  type TenantServiceContext,
} from "@/server/services/shared";

type TraceEntityType = "contact" | "booking" | "task";
type NextActionType = "urgent" | "action" | "wait" | "done";

interface PaginationInput {
  page: number;
  pageSize: number;
}

interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

interface PaginatedResult<T> {
  items: T[];
  pagination: PaginationMeta;
}

export interface ActorSummary {
  email: string;
  id: string;
  name: string;
}

export interface CompanySummary {
  id: string;
  name: string;
  stage: Tables<"companies">["stage"];
}

export interface EntityReferenceSummary {
  id: string;
  label: string;
  type: string;
}

export interface NextActionSummary {
  detail: string;
  dueAt: string | null;
  label: string;
  type: NextActionType;
}

export interface TraceRecord {
  actor: ActorSummary | null;
  company: CompanySummary | null;
  detail: string;
  entity: EntityReferenceSummary | null;
  id: string;
  kind: string;
  metadata: Record<string, Json>;
  occurredAt: string;
  relatedEntity: EntityReferenceSummary | null;
  status: string | null;
  title: string;
}

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

export interface DashboardActivityFeedItem {
  company: CompanySummary | null;
  entity: EntityReferenceSummary | null;
  eventType: string;
  id: string;
  metadata: Record<string, Json>;
  occurredAt: string;
  relatedEntity: EntityReferenceSummary | null;
}

export interface AutomationImpactSummary {
  estimatedTimeSavedSeconds: number;
  failedJobsCount: number;
  successRate: number;
  tasksAutoCreated: number;
  totalWorkflowRuns: number;
}

export interface UserSummary {
  id: string;
  initials: string;
  name: string;
}

export interface ContactRowSummary {
  company: CompanySummary | null;
  email: string | null;
  id: string;
  name: string;
  phone: string | null;
  stage: Tables<"contacts">["stage"];
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
  priority: Tables<"tasks">["priority"] | null;
  revenueCents: number | null;
  scheduledFor: string;
  status: Tables<"bookings">["status"];
  taskCount: number;
  title: string;
}

export interface CalendarViewResponse {
  assignedUsers: Array<{
    bookingCount: number;
    totalDurationMinutes: number;
    user: UserSummary;
  }>;
  bookings: PaginatedResult<BookingCalendarRow>;
  range: {
    end: string;
    start: string;
  };
}

export interface BookingTaskSummary {
  assignee: UserSummary | null;
  dueAt: string | null;
  id: string;
  priority: Tables<"tasks">["priority"];
  status: Tables<"tasks">["status"];
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
    status: Tables<"bookings">["status"];
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
    status: Tables<"workflow_runs">["status"];
    workflow: EntityReferenceSummary | null;
  }>;
  tasks: BookingTaskSummary[];
}

export interface CapacityConflictSummaryResponse {
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

export interface CRMContactRow {
  bookingsCount: number;
  company: CompanySummary | null;
  email: string | null;
  id: string;
  lastActivity: {
    eventType: string;
    occurredAt: string;
    title: string;
  } | null;
  name: string;
  nextAction: NextActionSummary;
  owner: UserSummary | null;
  phone: string | null;
  pipelineValueCents: number | null;
  realizedRevenueCents: number;
  stage: Tables<"contacts">["stage"];
  upcomingBookingsCount: number;
}

export interface CRMContactsResponse {
  pipelineSummary: Array<{
    count: number;
    stage: Tables<"contacts">["stage"];
    valueCents: number;
  }>;
  rows: PaginatedResult<CRMContactRow>;
}

export interface ContactDetailResponse {
  contact: {
    company: CompanySummary | null;
    createdAt: string;
    /** The business account this contact bills to (contacts.customer_account_id). */
    customerAccountId: string | null;
    email: string | null;
    id: string;
    metadata: Record<string, Json>;
    name: string;
    notes: string | null;
    owner: UserSummary | null;
    phone: string | null;
    stage: Tables<"contacts">["stage"];
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
    status: Tables<"workflow_runs">["status"];
    workflow: EntityReferenceSummary | null;
  }>;
}

export interface TaskListRow {
  assignee: UserSummary | null;
  booking: EntityReferenceSummary | null;
  commentsCount: number;
  company: CompanySummary | null;
  contact: ContactRowSummary | null;
  dueAt: string | null;
  id: string;
  isOverdue: boolean;
  priority: Tables<"tasks">["priority"];
  status: Tables<"tasks">["status"];
  title: string;
  workflow: EntityReferenceSummary | null;
}

export interface TasksListResponse {
  rows: PaginatedResult<TaskListRow>;
  summary: {
    blockedCount: number;
    completedCount: number;
    inProgressCount: number;
    overdueCount: number;
    todoCount: number;
  };
}

export interface TaskDetailResponse {
  comments: Array<{
    author: ActorSummary | null;
    body: string;
    createdAt: string;
    id: string;
  }>;
  linkedEntities: {
    booking: EntityReferenceSummary | null;
    company: CompanySummary | null;
    contact: ContactRowSummary | null;
    workflow: EntityReferenceSummary | null;
  };
  task: {
    assignee: UserSummary | null;
    createdAt: string;
    description: string | null;
    dueAt: string | null;
    id: string;
    isOverdue: boolean;
    priority: Tables<"tasks">["priority"];
    status: Tables<"tasks">["status"];
    title: string;
  };
  trace: TraceRecord[];
  workflowOrigin: {
    latestRun: {
      completedAt: string | null;
      createdAt: string;
      failureReason: string | null;
      id: string;
      status: Tables<"workflow_runs">["status"];
    } | null;
    workflow: EntityReferenceSummary | null;
  };
}

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
    lastRunStatus: Tables<"workflow_runs">["status"] | null;
    recentRunsCount: number;
  };
  status: Tables<"workflows">["status"];
  triggerType: string;
}

export interface WorkflowsListResponse {
  rows: PaginatedResult<WorkflowListRow>;
}

export interface WorkflowDetailResponse {
  relatedFailedJobs: Array<{
    activityEvent: EntityReferenceSummary | null;
    failedAt: string | null;
    id: string;
    lastError: string | null;
    retryEligible: boolean;
    status: Tables<"workflow_event_jobs">["status"];
  }>;
  workflow: {
    company: CompanySummary | null;
    createdAt: string;
    definition: Json;
    description: string | null;
    id: string;
    name: string;
    status: Tables<"workflows">["status"];
    triggerType: string;
  };
  workflowRuns: PaginatedResult<{
    actionsExecutedCount: number;
    completedAt: string | null;
    conditionResults: Array<{ actualValue: Json; field: string; matched: boolean; operator: string; value: Json }>;
    createdAt: string;
    createdTasksCount: number;
    failureReason: string | null;
    id: string;
    resumeAt: string | null;
    status: Tables<"workflow_runs">["status"];
    timeSavedSeconds: number;
    triggerEvent: EntityReferenceSummary | null;
  }>;
}

export interface WorkflowJobsListResponse {
  summary: {
    completedRecentCount: number;
    failedCount: number;
    pendingCount: number;
    runningCount: number;
    suspiciousRunningCount: number;
  };
  rows: PaginatedResult<{
    activityEvent: EntityReferenceSummary | null;
    activityEventId: string;
    attemptCount: number;
    availableAt: string;
    company: CompanySummary | null;
    companyId: string | null;
    completedAt: string | null;
    claimedAt: string | null;
    failureReason: string | null;
    id: string;
    lastAttemptedAt: string | null;
    lastError: string | null;
    organizationId: string;
    remainingAttempts: number;
    retryEligible: boolean;
    status: Tables<"workflow_event_jobs">["status"];
    updatedAt: string;
    workerId: string | null;
  }>;
}

export interface UnifiedTraceResponse {
  entity: EntityReferenceSummary;
  trace: TraceRecord[];
}

interface ContactNextActionInput {
  bookings: Tables<"bookings">[];
  contact: Tables<"contacts">;
  tasks: Tables<"tasks">[];
}

function toJsonRecord(value: Json | null | undefined): Record<string, Json> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
}

function extractValueCents(value: Json | null | undefined): number | null {
  const record = toJsonRecord(value);
  const candidate = record.value_cents ?? record.valueCents ?? record.revenue_cents ?? record.revenueCents;

  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return candidate;
  }

  if (typeof candidate === "string" && candidate.trim().length > 0) {
    const parsed = Number(candidate);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function buildPaginationMeta(total: number, page: number, pageSize: number): PaginationMeta {
  return {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function paginateItems<T>(items: T[], pagination: PaginationInput): PaginatedResult<T> {
  const start = (pagination.page - 1) * pagination.pageSize;
  const end = start + pagination.pageSize;

  return {
    items: items.slice(start, end),
    pagination: buildPaginationMeta(items.length, pagination.page, pagination.pageSize),
  };
}

function uniq(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function getContactName(contact: Tables<"contacts">): string {
  return [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim();
}

function getProfileName(profile: Tables<"profiles">): string {
  return profile.full_name?.trim() || profile.email;
}

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "NA";
}

function titleize(value: string): string {
  return value.replace(/[._]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function matchesCompanyScope(companyId: string | null | undefined, activeCompanyId: string | null | undefined): boolean {
  if (!activeCompanyId) {
    return true;
  }

  return companyId === activeCompanyId;
}

function assertCompanyScope(
  entityLabel: string,
  companyId: string | null | undefined,
  activeCompanyId: string | null | undefined,
): void {
  if (matchesCompanyScope(companyId, activeCompanyId)) {
    return;
  }

  throw new ValidationError(`${entityLabel} is not available in the active company scope.`);
}

function toUserSummary(profile: Tables<"profiles"> | null | undefined): UserSummary | null {
  if (!profile) {
    return null;
  }

  const name = getProfileName(profile);

  return {
    id: profile.id,
    initials: getInitials(name),
    name,
  };
}

function toActorSummary(profile: Tables<"profiles"> | null | undefined): ActorSummary | null {
  if (!profile) {
    return null;
  }

  return {
    email: profile.email,
    id: profile.id,
    name: getProfileName(profile),
  };
}

function toCompanySummary(company: Tables<"companies"> | null | undefined): CompanySummary | null {
  if (!company) {
    return null;
  }

  return {
    id: company.id,
    name: company.name,
    stage: company.stage,
  };
}

// Build the same CompanySummary / UserSummary shapes from the flat columns the read
// -model views/RPCs return (id + joined name/stage/email), instead of a full row.
function companySummaryFromFields(
  id: string | null | undefined,
  name: string | null | undefined,
  stage: string | null | undefined,
): CompanySummary | null {
  if (!id || name === null || name === undefined) {
    return null;
  }
  return { id, name, stage: stage as Tables<"companies">["stage"] };
}

function userSummaryFromFields(
  id: string | null | undefined,
  fullName: string | null | undefined,
  email: string | null | undefined,
): UserSummary | null {
  if (!id || email === null || email === undefined) {
    return null;
  }
  const name = fullName?.trim() || email;
  return { id, initials: getInitials(name), name };
}

function isTaskOpen(task: Tables<"tasks">): boolean {
  return task.status !== "completed";
}

function isTaskOverdue(task: Tables<"tasks">, referenceDate = new Date()): boolean {
  return Boolean(task.due_at && task.status !== "completed" && new Date(task.due_at) < referenceDate);
}

function matchesSearch(haystacks: Array<string | null | undefined>, query: string | null | undefined): boolean {
  if (!query) {
    return true;
  }

  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return true;
  }

  return haystacks.some((value) => value?.toLowerCase().includes(normalized));
}

function isWithinRange(value: string, startIso: string, endIso: string): boolean {
  const target = new Date(value).getTime();
  return target >= new Date(startIso).getTime() && target <= new Date(endIso).getTime();
}

function startOfUtcDay(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function endOfUtcDay(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));
}

function startOfUtcWeek(date = new Date()): Date {
  const current = startOfUtcDay(date);
  const day = current.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  current.setUTCDate(current.getUTCDate() - diff);
  return current;
}

function getHighestPriority(tasks: Tables<"tasks">[]): Tables<"tasks">["priority"] | null {
  const priorityRank: Record<Tables<"tasks">["priority"], number> = {
    urgent: 4,
    high: 3,
    medium: 2,
    low: 1,
  };

  const sorted = [...tasks].sort((left, right) => priorityRank[right.priority] - priorityRank[left.priority]);
  return sorted[0]?.priority ?? null;
}

function getNextActionForContact(input: ContactNextActionInput): NextActionSummary {
  const overdueTask = input.tasks.find((task) => isTaskOverdue(task));

  if (overdueTask) {
    return {
      detail: overdueTask.title,
      dueAt: overdueTask.due_at,
      label: "Resolve overdue task",
      type: "urgent",
    };
  }

  const pendingBooking = input.bookings
    .filter((booking) => booking.status !== "completed" && new Date(booking.scheduled_for) > new Date())
    .sort((left, right) => left.scheduled_for.localeCompare(right.scheduled_for))[0];

  if (pendingBooking) {
    return {
      detail: pendingBooking.title,
      dueAt: pendingBooking.scheduled_for,
      label: pendingBooking.status === "pending" ? "Confirm booking" : "Prepare upcoming booking",
      type: pendingBooking.status === "pending" ? "urgent" : "wait",
    };
  }

  const openTask = input.tasks.find((task) => isTaskOpen(task));

  if (openTask) {
    return {
      detail: openTask.title,
      dueAt: openTask.due_at,
      label: "Advance open task",
      type: "action",
    };
  }

  if (input.contact.stage === "closed") {
    return {
      detail: "Contact is closed.",
      dueAt: null,
      label: "Closed",
      type: "done",
    };
  }

  return {
    detail: "No linked work yet.",
    dueAt: null,
    label: input.contact.stage === "lead" ? "Qualify lead" : "Schedule follow-up",
    type: "action",
  };
}

type OrganizationScopedTable = keyof TablesMap;

/** PostgREST caps a single response at 1,000 rows, so listAllRows MUST page. */
const LIST_ALL_ROWS_PAGE_SIZE = 1000;

// Exported for the pagination unit test; the detail views (contact/booking/task/
// workflow) still use it while their SQL read models (ui_*_detail) are wired in a
// follow-up. The list/summary endpoints now read the views/RPCs directly.
export async function listAllRows<T extends OrganizationScopedTable>(
  context: TenantServiceContext,
  table: T,
): Promise<TablesMap[T][]> {
  // Generic dynamic-table read: supabase-js cannot resolve `.from(<generic>)` (the
  // column and row types depend on a table chosen at runtime), so this helper casts
  // the client to a minimal typed query surface — the one sanctioned generic-table
  // escape hatch in the server tree, alongside insertRow and the json.ts boundary.
  //
  // TOURNIQUET (Task 3, step 1): page through in 1,000-row chunks with an explicit
  // deterministic order until a short page returns. Before this, the implicit 1,000-row
  // PostgREST cap silently truncated every table read — dashboard counts and joins were
  // wrong for any org past 1,000 rows in a table. Still O(all-rows); the SQL read
  // models (later steps) replace the in-memory joins entirely.
  const builder = context.supabase.from(table as never) as unknown as {
    select: (columns: string) => {
      eq: (
        column: string,
        value: string,
      ) => {
        order: (
          column: string,
          opts: { ascending: boolean },
        ) => {
          range: (
            from: number,
            to: number,
          ) => PromiseLike<{ data: TablesMap[T][] | null; error: unknown }>;
        };
      };
    };
  };

  const rows: TablesMap[T][] = [];
  for (let offset = 0; ; offset += LIST_ALL_ROWS_PAGE_SIZE) {
    const { data, error } = await builder
      .select("*")
      .eq("organization_id", context.organizationId)
      .order("created_at", { ascending: false })
      .range(offset, offset + LIST_ALL_ROWS_PAGE_SIZE - 1);

    if (error) {
      throw error;
    }

    const page = data ?? [];
    rows.push(...page);
    if (page.length < LIST_ALL_ROWS_PAGE_SIZE) {
      break;
    }
  }

  return rows;
}

type TablesMap = {
  activity_events: Tables<"activity_events">;
  bookings: Tables<"bookings">;
  comments: Tables<"comments">;
  companies: Tables<"companies">;
  contacts: Tables<"contacts">;
  tasks: Tables<"tasks">;
  workflow_event_jobs: Tables<"workflow_event_jobs">;
  workflow_runs: Tables<"workflow_runs">;
  workflows: Tables<"workflows">;
};

async function loadCompaniesMap(context: TenantServiceContext, companyIds?: string[]): Promise<Map<string, Tables<"companies">>> {
  const ids = companyIds ? uniq(companyIds) : [];
  const query = context.supabase.from("companies").select("*").eq("organization_id", context.organizationId);
  const { data, error } = ids.length ? await query.in("id", ids) : await query;

  if (error) {
    throw error;
  }

  return new Map((data ?? []).map((company) => [company.id, company]));
}

async function loadProfilesMap(context: TenantServiceContext, profileIds?: string[]): Promise<Map<string, Tables<"profiles">>> {
  const ids = profileIds ? uniq(profileIds) : [];
  const query = context.supabase.from("profiles").select("*");
  const { data, error } = ids.length ? await query.in("id", ids) : await query;

  if (error) {
    throw error;
  }

  return new Map((data ?? []).map((profile) => [profile.id, profile]));
}

async function loadContactsMap(context: TenantServiceContext, contactIds: string[]): Promise<Map<string, Tables<"contacts">>> {
  const ids = uniq(contactIds);

  if (ids.length === 0) {
    return new Map();
  }

  const { data, error } = await context.supabase
    .from("contacts")
    .select("*")
    .eq("organization_id", context.organizationId)
    .in("id", ids);

  if (error) {
    throw error;
  }

  return new Map((data ?? []).map((contact) => [contact.id, contact]));
}

async function loadBookingsMap(context: TenantServiceContext, bookingIds: string[]): Promise<Map<string, Tables<"bookings">>> {
  const ids = uniq(bookingIds);

  if (ids.length === 0) {
    return new Map();
  }

  const { data, error } = await context.supabase
    .from("bookings")
    .select("*")
    .eq("organization_id", context.organizationId)
    .in("id", ids);

  if (error) {
    throw error;
  }

  return new Map((data ?? []).map((booking) => [booking.id, booking]));
}

async function loadTasksMap(context: TenantServiceContext, taskIds: string[]): Promise<Map<string, Tables<"tasks">>> {
  const ids = uniq(taskIds);

  if (ids.length === 0) {
    return new Map();
  }

  const { data, error } = await context.supabase
    .from("tasks")
    .select("*")
    .eq("organization_id", context.organizationId)
    .in("id", ids);

  if (error) {
    throw error;
  }

  return new Map((data ?? []).map((task) => [task.id, task]));
}

async function loadWorkflowsMap(context: TenantServiceContext, workflowIds: string[]): Promise<Map<string, Tables<"workflows">>> {
  const ids = uniq(workflowIds);

  if (ids.length === 0) {
    return new Map();
  }

  const { data, error } = await context.supabase
    .from("workflows")
    .select("*")
    .eq("organization_id", context.organizationId)
    .in("id", ids);

  if (error) {
    throw error;
  }

  return new Map((data ?? []).map((workflow) => [workflow.id, workflow]));
}

async function loadActivityEventsMap(context: TenantServiceContext, activityEventIds: string[]): Promise<Map<string, Tables<"activity_events">>> {
  const ids = uniq(activityEventIds);

  if (ids.length === 0) {
    return new Map();
  }

  const { data, error } = await context.supabase
    .from("activity_events")
    .select("*")
    .eq("organization_id", context.organizationId)
    .in("id", ids);

  if (error) {
    throw error;
  }

  return new Map((data ?? []).map((activityEvent) => [activityEvent.id, activityEvent]));
}

async function buildEntityReferenceMap(
  context: TenantServiceContext,
  references: Array<{ id: string | null; type: string | null }>,
): Promise<Map<string, EntityReferenceSummary>> {
  const grouped = new Map<string, string[]>();

  for (const reference of references) {
    if (!reference.id || !reference.type) {
      continue;
    }

    const bucket = grouped.get(reference.type) ?? [];
    bucket.push(reference.id);
    grouped.set(reference.type, bucket);
  }

  const result = new Map<string, EntityReferenceSummary>();

  const companyMap = grouped.has("company")
    ? await loadCompaniesMap(context, grouped.get("company"))
    : new Map<string, Tables<"companies">>();
  const contactMap = grouped.has("contact")
    ? await loadContactsMap(context, grouped.get("contact") ?? [])
    : new Map<string, Tables<"contacts">>();
  const bookingMap = grouped.has("booking")
    ? await loadBookingsMap(context, grouped.get("booking") ?? [])
    : new Map<string, Tables<"bookings">>();
  const taskMap = grouped.has("task")
    ? await loadTasksMap(context, grouped.get("task") ?? [])
    : new Map<string, Tables<"tasks">>();
  const workflowMap = grouped.has("workflow")
    ? await loadWorkflowsMap(context, grouped.get("workflow") ?? [])
    : new Map<string, Tables<"workflows">>();
  const activityEventMap = grouped.has("activity_event")
    ? await loadActivityEventsMap(context, grouped.get("activity_event") ?? [])
    : new Map<string, Tables<"activity_events">>();

  for (const [id, company] of companyMap) {
    result.set(`company:${id}`, { id, label: company.name, type: "company" });
  }

  for (const [id, contact] of contactMap) {
    result.set(`contact:${id}`, { id, label: getContactName(contact), type: "contact" });
  }

  for (const [id, booking] of bookingMap) {
    result.set(`booking:${id}`, { id, label: booking.title, type: "booking" });
  }

  for (const [id, task] of taskMap) {
    result.set(`task:${id}`, { id, label: task.title, type: "task" });
  }

  for (const [id, workflow] of workflowMap) {
    result.set(`workflow:${id}`, { id, label: workflow.name, type: "workflow" });
  }

  for (const [id, activityEvent] of activityEventMap) {
    result.set(`activity_event:${id}`, { id, label: activityEvent.event_type, type: "activity_event" });
  }

  for (const [type, ids] of grouped) {
    for (const id of uniq(ids)) {
      const key = `${type}:${id}`;

      if (!result.has(key)) {
        result.set(key, { id, label: `${type} ${id.slice(0, 8)}`, type });
      }
    }
  }

  return result;
}

async function buildBookingRevenueMap(
  context: TenantServiceContext,
  bookings: Tables<"bookings">[],
  contactsMap: Map<string, Tables<"contacts">>,
): Promise<Map<string, number | null>> {
  const bookingIds = uniq(bookings.map((booking) => booking.id));
  const result = new Map<string, number | null>();

  bookings.forEach((booking) => {
    result.set(booking.id, extractValueCents(contactsMap.get(booking.contact_id ?? "")?.metadata));
  });

  if (bookingIds.length === 0) {
    return result;
  }

  const { data, error } = await context.supabase
    .from("activity_events")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("entity_type", "booking")
    .in("entity_id", bookingIds)
    .order("occurred_at", { ascending: false });

  if (error) {
    throw error;
  }

  for (const event of data ?? []) {
    const valueCents = extractValueCents(event.metadata_json);

    if (valueCents !== null && event.entity_id && !result.get(event.entity_id)) {
      result.set(event.entity_id, valueCents);
    }
  }

  return result;
}

function summarizeRevenueFromEvents(events: Tables<"activity_events">[]): { todayCents: number; weekCents: number } {
  const todayStart = startOfUtcDay();
  const todayEnd = endOfUtcDay();
  const weekStart = startOfUtcWeek();
  let todayCents = 0;
  let weekCents = 0;

  for (const event of events) {
    const valueCents = extractValueCents(event.metadata_json) ?? 0;

    if (valueCents === 0) {
      continue;
    }

    const occurredAt = new Date(event.occurred_at);

    if (occurredAt >= weekStart) {
      weekCents += valueCents;
    }

    if (occurredAt >= todayStart && occurredAt <= todayEnd) {
      todayCents += valueCents;
    }
  }

  return { todayCents, weekCents };
}

/** Cartesia `end_reason` → an owner-facing outcome phrase. */
function describeCallOutcome(endReason: string | null): string {
  switch (endReason) {
    case "agent_hangup":
    case "client_hangup":
      return "Answered";
    case "max_duration":
      return "Answered (hit max duration)";
    case "inactivity":
      return "Answered (ended on silence)";
    case "dial_no_answer":
      return "No answer";
    case "dial_busy":
      return "Line busy";
    case "dial_failed":
      return "Couldn't connect";
    case "client_disconnected":
      return "Disconnected";
    case "api_cancelled":
      return "Cancelled";
    case "error":
      return "Failed";
    default:
      return endReason ? titleize(endReason) : "Ended";
  }
}

function callOutcomeTitle(endReason: string | null): string {
  switch (endReason) {
    case "dial_no_answer":
      return "Call not answered";
    case "dial_busy":
      return "Call — line busy";
    case "dial_failed":
    case "error":
      return "Call failed";
    case "api_cancelled":
      return "Call cancelled";
    default:
      return "Call completed";
  }
}

function formatCallDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function buildActivityEventTraceSummary(activityEvent: Tables<"activity_events">): {
  detail: string;
  metadata: Record<string, Json>;
  title: string;
} {
  const metadata = toJsonRecord(activityEvent.metadata_json);
  const stage = typeof (metadata.stage_changed_to ?? metadata.stage) === "string"
    ? String(metadata.stage_changed_to ?? metadata.stage)
    : null;
  const status = typeof metadata.status === "string" ? metadata.status : null;

  switch (activityEvent.event_type) {
    case "contact.created":
      return {
        detail: "A contact record was added to the CRM.",
        metadata,
        title: "Contact created",
      };
    case "contact.stage_changed":
      return {
        detail: stage ? `Moved to ${titleize(stage)}.` : "The contact stage changed.",
        metadata,
        title: "Contact stage changed",
      };
    case "contact.owner_assigned":
      return {
        detail: "A contact owner was assigned.",
        metadata,
        title: "Contact owner assigned",
      };
    case "contact.call_placed": {
      const toNumber = typeof metadata.toNumber === "string" ? metadata.toNumber : null;
      return {
        detail: toNumber ? `Marina placed a call to ${toNumber}.` : "Marina placed a call to this lead.",
        metadata,
        title: "Call placed",
      };
    }
    case "contact.call_completed": {
      const endReason = typeof metadata.endReason === "string" ? metadata.endReason : null;
      const summary = typeof metadata.summary === "string" && metadata.summary.trim().length > 0
        ? metadata.summary.trim()
        : null;
      const durationSeconds =
        typeof metadata.durationSeconds === "number" ? metadata.durationSeconds : null;
      const outcome = describeCallOutcome(endReason);
      const parts = [outcome];
      if (durationSeconds != null && durationSeconds > 0) {
        parts.push(formatCallDuration(durationSeconds));
      }

      return {
        detail: summary ?? `${parts.join(" · ")}.`,
        metadata,
        title: callOutcomeTitle(endReason),
      };
    }
    case "booking.created":
      return {
        detail: "A booking was created.",
        metadata,
        title: "Booking created",
      };
    case "booking.status_changed":
      return {
        detail: status ? `Booking is now ${titleize(status)}.` : "The booking status changed.",
        metadata,
        title: "Booking status changed",
      };
    case "booking.en_route":
      return {
        detail: "The crew is on the way to the job.",
        metadata,
        title: "Crew on the way",
      };
    case "booking.started":
      return {
        detail: "The crew started work on the job.",
        metadata,
        title: "Job started",
      };
    case "booking.crew_changed":
      return {
        detail: "The crew on this job changed.",
        metadata,
        title: "Crew updated",
      };
    case "booking.completed":
      return {
        detail: "The booking was completed and is eligible for workflow automation.",
        metadata,
        title: "Booking completed",
      };
    case "task.created":
      return {
        detail: "A task was created.",
        metadata,
        title: "Task created",
      };
    case "task.status_changed":
      return {
        detail: status ? `Task is now ${titleize(status)}.` : "The task status changed.",
        metadata,
        title: "Task status changed",
      };
    case "task.completed":
      return {
        detail: "The task was completed and is eligible for workflow automation.",
        metadata,
        title: "Task completed",
      };
    case "task.assignee_assigned":
      return {
        detail: "A task assignee was assigned.",
        metadata,
        title: "Task assignee assigned",
      };
    case "workflow.executed":
      return {
        detail: "A workflow run completed for this trace.",
        metadata: {
          ...metadata,
          origin: "workflow",
        },
        title: "Workflow executed",
      };
    default:
      return {
        detail: titleize(activityEvent.event_type),
        metadata,
        title: titleize(activityEvent.event_type),
      };
  }
}

function buildWorkflowRunTraceSummary(workflowRun: Tables<"workflow_runs">): {
  detail: string;
  metadata: Record<string, Json>;
  title: string;
} {
  const metadata = {
    actionsExecutedCount: workflowRun.actions_executed_count,
    createdTasksCount: workflowRun.created_tasks_count,
    origin: "workflow",
    timeSavedSeconds: workflowRun.time_saved_seconds,
  } satisfies Record<string, Json>;

  if (workflowRun.status === "failed") {
    return {
      detail: workflowRun.failure_reason ?? "The workflow run failed.",
      metadata,
      title: "Workflow run failed",
    };
  }

  const details: string[] = [];

  if (workflowRun.actions_executed_count > 0) {
    details.push(`${workflowRun.actions_executed_count} action${workflowRun.actions_executed_count === 1 ? "" : "s"} executed`);
  }

  if (workflowRun.created_tasks_count > 0) {
    details.push(`${workflowRun.created_tasks_count} task${workflowRun.created_tasks_count === 1 ? "" : "s"} created`);
  }

  if (workflowRun.time_saved_seconds > 0) {
    details.push(`${workflowRun.time_saved_seconds}s estimated time saved`);
  }

  return {
    detail: details.length > 0 ? details.join(" - ") : "Workflow run completed.",
    metadata,
    title: workflowRun.status === "running" ? "Workflow run in progress" : "Workflow run completed",
  };
}

async function getNormalizedTraceForEntity(
  context: TenantServiceContext,
  entityType: TraceEntityType,
  entityId: string,
): Promise<TraceRecord[]> {
  const traceItems = entityType === "contact"
    ? await getContactTrace(context, entityId)
    : entityType === "booking"
      ? await getBookingTrace(context, entityId)
      : await getTaskTrace(context, entityId);

  const actorIds = uniq(traceItems.map((item) => {
    if (item.kind === "activity_event") {
      return (item.data as Tables<"activity_events">).actor_user_id;
    }

    if (item.kind === "comment") {
      return (item.data as Tables<"comments">).author_profile_id;
    }

    if (item.kind === "booking") {
      return (item.data as Tables<"bookings">).created_by;
    }

    if (item.kind === "task") {
      return (item.data as Tables<"tasks">).created_by;
    }

    return null;
  }));
  const companyIds = uniq(traceItems.map((item) => item.companyId));
  const profilesMap = await loadProfilesMap(context, actorIds);
  const companiesMap = await loadCompaniesMap(context, companyIds);
  const workflowsMap = await loadWorkflowsMap(
    context,
    traceItems
      .filter((item): item is typeof item & { data: Tables<"workflow_runs"> } => item.kind === "workflow_run")
      .map((item) => item.data.workflow_id),
  );
  const entityReferenceMap = await buildEntityReferenceMap(
    context,
    traceItems.flatMap((item) => {
      if (item.kind === "activity_event") {
        const activityEvent = item.data as Tables<"activity_events">;

        return [
          { id: activityEvent.entity_id, type: activityEvent.entity_type },
          { id: activityEvent.related_entity_id, type: activityEvent.related_entity_type },
        ];
      }

      if (item.kind === "workflow_run") {
        return [{ id: (item.data as Tables<"workflow_runs">).workflow_id, type: "workflow" }];
      }

      if (item.kind === "booking") {
        return [{ id: (item.data as Tables<"bookings">).contact_id, type: "contact" }];
      }

      if (item.kind === "task") {
        const task = item.data as Tables<"tasks">;
        return [
          { id: task.contact_id, type: "contact" },
          { id: task.booking_id, type: "booking" },
          { id: task.workflow_id, type: "workflow" },
        ];
      }

      if (item.kind === "comment") {
        const comment = item.data as Tables<"comments">;
        return [{ id: comment.entity_id, type: comment.entity_type }];
      }

      return [];
    }),
  );

  return traceItems.map((item): TraceRecord => {
    if (item.kind === "activity_event") {
      const activityEvent = item.data as Tables<"activity_events">;
      const summary = buildActivityEventTraceSummary(activityEvent);

      return {
        actor: toActorSummary(profilesMap.get(activityEvent.actor_user_id ?? "")),
        company: toCompanySummary(companiesMap.get(activityEvent.company_id ?? "")),
        detail: summary.detail,
        entity: activityEvent.entity_id
          ? entityReferenceMap.get(`${activityEvent.entity_type}:${activityEvent.entity_id}`) ?? null
          : null,
        id: item.id,
        kind: item.kind,
        metadata: summary.metadata,
        occurredAt: item.occurredAt,
        relatedEntity: activityEvent.related_entity_id && activityEvent.related_entity_type
          ? entityReferenceMap.get(`${activityEvent.related_entity_type}:${activityEvent.related_entity_id}`) ?? null
          : null,
        status: null,
        title: summary.title,
      } satisfies TraceRecord;
    }

    if (item.kind === "workflow_run") {
      const workflowRun = item.data as Tables<"workflow_runs">;
      const workflow = workflowsMap.get(workflowRun.workflow_id);
      const summary = buildWorkflowRunTraceSummary(workflowRun);

      return {
        actor: null,
        company: toCompanySummary(companiesMap.get(workflowRun.company_id ?? "")),
        detail: summary.detail,
        entity: workflow ? { id: workflow.id, label: workflow.name, type: "workflow" } : null,
        id: item.id,
        kind: item.kind,
        metadata: summary.metadata,
        occurredAt: item.occurredAt,
        relatedEntity: workflowRun.trigger_event_id
          ? entityReferenceMap.get(`activity_event:${workflowRun.trigger_event_id}`) ?? null
          : null,
        status: workflowRun.status,
        title: workflow ? `${workflow.name} - ${summary.title}` : summary.title,
      } satisfies TraceRecord;
    }

    if (item.kind === "task") {
      const task = item.data as Tables<"tasks">;

      return {
        actor: toActorSummary(profilesMap.get(task.created_by ?? "")),
        company: toCompanySummary(companiesMap.get(task.company_id ?? "")),
        detail: task.description ?? `Task is ${titleize(task.status)}.`,
        entity: { id: task.id, label: task.title, type: "task" },
        id: item.id,
        kind: item.kind,
        metadata: {
          origin: task.workflow_id ? "workflow" : "system",
          priority: task.priority,
          status: task.status,
        },
        occurredAt: item.occurredAt,
        relatedEntity: task.contact_id
          ? entityReferenceMap.get(`contact:${task.contact_id}`) ?? null
          : task.booking_id
            ? entityReferenceMap.get(`booking:${task.booking_id}`) ?? null
            : null,
        status: task.status,
        title: task.title,
      } satisfies TraceRecord;
    }

    if (item.kind === "booking") {
      const booking = item.data as Tables<"bookings">;

      return {
        actor: toActorSummary(profilesMap.get(booking.created_by ?? "")),
        company: toCompanySummary(companiesMap.get(booking.company_id ?? "")),
        detail: booking.description ?? `Booking is ${titleize(booking.status)}.`,
        entity: { id: booking.id, label: booking.title, type: "booking" },
        id: item.id,
        kind: item.kind,
        metadata: { status: booking.status, durationMinutes: booking.duration_minutes },
        occurredAt: item.occurredAt,
        relatedEntity: booking.contact_id ? entityReferenceMap.get(`contact:${booking.contact_id}`) ?? null : null,
        status: booking.status,
        title: booking.title,
      } satisfies TraceRecord;
    }

    const comment = item.data as Tables<"comments">;

    return {
      actor: toActorSummary(profilesMap.get(comment.author_profile_id ?? "")),
      company: toCompanySummary(companiesMap.get(comment.company_id ?? "")),
      detail: comment.body,
      entity: comment.entity_id ? entityReferenceMap.get(`${comment.entity_type}:${comment.entity_id}`) ?? null : null,
      id: item.id,
      kind: item.kind,
      metadata: {},
      occurredAt: item.occurredAt,
      relatedEntity: null,
      status: null,
      title: "Comment added",
    } satisfies TraceRecord;
  });
}

async function buildContactSummaryMap(
  context: TenantServiceContext,
  contacts: Tables<"contacts">[],
  companiesMap: Map<string, Tables<"companies">>,
): Promise<Map<string, ContactRowSummary>> {
  return new Map(
    contacts.map((contact) => [
      contact.id,
      {
        company: toCompanySummary(companiesMap.get(contact.company_id)),
        email: contact.email,
        id: contact.id,
        name: getContactName(contact),
        phone: contact.phone,
        stage: contact.stage,
      } satisfies ContactRowSummary,
    ]),
  );
}

export async function getDashboardSummary(
  context: TenantServiceContext,
  input: { companyId?: string | null } = {},
): Promise<DashboardSummary> {
  await assertCompanyInOrganization(context, input.companyId);
  // One SQL round trip: ui_dashboard_summary computes every count/aggregate with
  // filter(where …) aggregates, replacing six whole-table listAllRows loads.
  const { data, error } = await context.supabase.rpc("ui_dashboard_summary", {
    p_org_id: context.organizationId,
    p_company_id: input.companyId ?? undefined,
  });
  if (error) {
    throw error;
  }
  const row = data?.[0];

  return {
    activeWorkflowCount: row?.active_workflow_count ?? 0,
    failedWorkflowJobCount: row?.failed_workflow_job_count ?? 0,
    newLeadCount: row?.new_lead_count ?? 0,
    overdueTaskCount: row?.overdue_task_count ?? 0,
    revenueSnapshot: {
      todayCents: Number(row?.revenue_today_cents ?? 0),
      weekCents: Number(row?.revenue_week_cents ?? 0),
    },
    todayBookingCount: row?.today_booking_count ?? 0,
    upcomingBookingCount: row?.upcoming_booking_count ?? 0,
    urgentTaskCount: row?.urgent_task_count ?? 0,
  };
}

export async function getDashboardActivityFeed(
  context: TenantServiceContext,
  input: PaginationInput & { companyId?: string | null },
): Promise<PaginatedResult<DashboardActivityFeedItem>> {
  // SQL pagination + count instead of loading every event and slicing in JS. Only
  // the current page's events are then enriched (company + entity references).
  const offset = (input.page - 1) * input.pageSize;
  let query = context.supabase
    .from("activity_events")
    .select("*", { count: "exact" })
    .eq("organization_id", context.organizationId);
  if (input.companyId) {
    query = query.eq("company_id", input.companyId);
  }
  const { data, count, error } = await query
    .order("occurred_at", { ascending: false })
    .range(offset, offset + input.pageSize - 1);
  if (error) {
    throw error;
  }
  const events = data ?? [];
  const companiesMap = await loadCompaniesMap(context, uniq(events.map((event) => event.company_id)));
  const entityReferenceMap = await buildEntityReferenceMap(
    context,
    events.flatMap((event) => [
      { id: event.entity_id, type: event.entity_type },
      { id: event.related_entity_id, type: event.related_entity_type },
    ]),
  );

  return {
    items: events.map((event) => ({
      company: toCompanySummary(companiesMap.get(event.company_id ?? "")),
      entity: event.entity_id ? entityReferenceMap.get(`${event.entity_type}:${event.entity_id}`) ?? null : null,
      eventType: event.event_type,
      id: event.id,
      metadata: toJsonRecord(event.metadata_json),
      occurredAt: event.occurred_at,
      relatedEntity: event.related_entity_id && event.related_entity_type
        ? entityReferenceMap.get(`${event.related_entity_type}:${event.related_entity_id}`) ?? null
        : null,
    })),
    pagination: buildPaginationMeta(count ?? 0, input.page, input.pageSize),
  };
}

export async function getAutomationImpact(
  context: TenantServiceContext,
  input: { companyId?: string | null } = {},
): Promise<AutomationImpactSummary> {
  await assertCompanyInOrganization(context, input.companyId);
  const { data, error } = await context.supabase.rpc("ui_automation_impact", {
    p_org_id: context.organizationId,
    p_company_id: input.companyId ?? undefined,
  });
  if (error) {
    throw error;
  }
  const row = data?.[0];
  const totalWorkflowRuns = row?.total_workflow_runs ?? 0;
  const successfulRuns = row?.successful_runs ?? 0;

  return {
    estimatedTimeSavedSeconds: Number(row?.estimated_time_saved_seconds ?? 0),
    failedJobsCount: row?.failed_jobs_count ?? 0,
    successRate: totalWorkflowRuns === 0 ? 0 : Number(((successfulRuns / totalWorkflowRuns) * 100).toFixed(1)),
    tasksAutoCreated: Number(row?.tasks_auto_created ?? 0),
    totalWorkflowRuns,
  };
}

export async function getCalendarView(
  context: TenantServiceContext,
  input: PaginationInput & {
    assignedUserId?: string | null;
    companyId?: string | null;
    end: string;
    start: string;
  },
): Promise<CalendarViewResponse> {
  // ui_calendar_bookings filters the window + company, rolls up each booking's tasks
  // (count, highest priority, assigned profile ids) and revenue in SQL. Only profile
  // names are resolved here; the assigned-user filter and aggregation stay in TS.
  const { data, error } = await context.supabase.rpc("ui_calendar_bookings", {
    p_org_id: context.organizationId,
    p_company_id: input.companyId ?? undefined,
    p_from_ts: input.start,
    p_to_ts: input.end,
  });
  if (error) {
    throw error;
  }
  const rpcRows = data ?? [];
  const profilesMap = await loadProfilesMap(
    context,
    uniq(rpcRows.flatMap((row) => row.assigned_profile_ids ?? [])),
  );
  const filteredBookings = input.assignedUserId
    ? rpcRows.filter((row) => (row.assigned_profile_ids ?? []).includes(input.assignedUserId as string))
    : rpcRows;
  const rows = filteredBookings.map((row) => {
    const users = uniq(row.assigned_profile_ids ?? [])
      .map((profileId) => toUserSummary(profilesMap.get(profileId)))
      .filter((user): user is UserSummary => Boolean(user));

    return {
      assignedUserSummary: {
        count: users.length,
        primary: users[0] ?? null,
        users,
      },
      company: companySummaryFromFields(row.company_id, row.company_name, row.company_stage),
      contact: row.contact_id
        ? {
            company: companySummaryFromFields(row.contact_company_id, row.contact_company_name, row.contact_company_stage),
            email: row.contact_email,
            id: row.contact_id,
            name: row.contact_name ?? "",
            phone: row.contact_phone,
            stage: (row.contact_stage ?? "lead") as Tables<"contacts">["stage"],
          }
        : null,
      durationMinutes: row.duration_minutes,
      id: row.id,
      priority: (row.highest_priority ?? null) as Tables<"tasks">["priority"] | null,
      revenueCents: row.revenue_cents !== null ? Number(row.revenue_cents) : null,
      scheduledFor: row.scheduled_for,
      status: row.status as Tables<"bookings">["status"],
      taskCount: row.task_count,
      title: row.title,
    } satisfies BookingCalendarRow;
  });
  const assignedUsers = [...new Map(
    rows
      .flatMap((row) => row.assignedUserSummary.users.map((user) => user.id))
      .map((profileId) => {
        const user = toUserSummary(profilesMap.get(profileId));
        const relatedRows = rows.filter((row) => row.assignedUserSummary.users.some((item) => item.id === profileId));

        return [
          profileId,
          {
            bookingCount: relatedRows.length,
            totalDurationMinutes: relatedRows.reduce((sum, row) => sum + row.durationMinutes, 0),
            user,
          },
        ] as const;
      }),
  ).values()].filter((entry) => entry.user) as Array<{ bookingCount: number; totalDurationMinutes: number; user: UserSummary }>;

  return {
    assignedUsers,
    bookings: paginateItems(rows, input),
    range: {
      end: input.end,
      start: input.start,
    },
  };
}

export async function getBookingDetailView(
  context: TenantServiceContext,
  bookingId: string,
  input: { companyId?: string | null } = {},
): Promise<BookingDetailResponse> {
  await assertCompanyInOrganization(context, input.companyId);
  const [bookings, tasks, contacts, companies, workflowRuns] = await Promise.all([
    listAllRows(context, "bookings"),
    listAllRows(context, "tasks"),
    listAllRows(context, "contacts"),
    listAllRows(context, "companies"),
    listAllRows(context, "workflow_runs"),
  ]);
  const booking = bookings.find((item) => item.id === bookingId);

  if (!booking) {
    throw new ValidationError("Booking not found.");
  }

  assertCompanyScope("Booking", booking.company_id, input.companyId);

  const companiesMap = new Map(companies.map((company) => [company.id, company]));
  const contactsMap = new Map(contacts.map((contact) => [contact.id, contact]));
  const linkedTasks = tasks.filter((task) => task.booking_id === booking.id);
  const profilesMap = await loadProfilesMap(context, uniq(linkedTasks.map((task) => task.assigned_to_profile_id)));
  const revenueMap = await buildBookingRevenueMap(context, [booking], contactsMap);
  const trace = await getNormalizedTraceForEntity(context, "booking", booking.id);
  const triggeredWorkflowRuns = workflowRuns
    .filter((run) => trace.some((item) => item.kind === "activity_event" && item.id === run.trigger_event_id))
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  const workflowsMap = await loadWorkflowsMap(context, triggeredWorkflowRuns.map((run) => run.workflow_id));
  const contact = booking.contact_id ? contactsMap.get(booking.contact_id) ?? null : null;
  const comments = await listComments(context, { entityId: booking.id, entityType: "booking" });
  const commentProfilesMap = await loadProfilesMap(context, uniq(comments.map((comment) => comment.author_profile_id)));

  return {
    comments: comments.map((comment) => ({
      author: toActorSummary(commentProfilesMap.get(comment.author_profile_id ?? "")),
      body: comment.body,
      createdAt: comment.created_at,
      id: comment.id,
    })),
    booking: {
      company: toCompanySummary(companiesMap.get(booking.company_id)),
      contact: contact
        ? {
            company: toCompanySummary(companiesMap.get(contact.company_id)),
            email: contact.email,
            id: contact.id,
            name: getContactName(contact),
            phone: contact.phone,
            stage: contact.stage,
          }
        : null,
      description: booking.description,
      durationMinutes: booking.duration_minutes,
      id: booking.id,
      revenueCents: revenueMap.get(booking.id) ?? null,
      scheduledFor: booking.scheduled_for,
      status: booking.status,
      title: booking.title,
    },
    tasks: linkedTasks.map((task) => ({
      assignee: toUserSummary(profilesMap.get(task.assigned_to_profile_id ?? "")),
      dueAt: task.due_at,
      id: task.id,
      priority: task.priority,
      status: task.status,
      title: task.title,
      workflowId: task.workflow_id,
    })),
    trace,
    triggeredWorkflowRuns: triggeredWorkflowRuns.map((run) => ({
      completedAt: run.completed_at,
      createdAt: run.created_at,
      failureReason: run.failure_reason,
      id: run.id,
      status: run.status,
      workflow: workflowsMap.get(run.workflow_id)
        ? { id: run.workflow_id, label: workflowsMap.get(run.workflow_id)?.name ?? run.workflow_id, type: "workflow" }
        : null,
    })),
  };
}

export async function getCapacityConflictSummary(
  context: TenantServiceContext,
  input: {
    assignedUserId?: string | null;
    companyId?: string | null;
    end: string;
    start: string;
  },
): Promise<CapacityConflictSummaryResponse> {
  const calendarView = await getCalendarView(context, {
    assignedUserId: input.assignedUserId,
    companyId: input.companyId,
    end: input.end,
    page: 1,
    pageSize: 500,
    start: input.start,
  });
  const grouped = new Map<string, Array<{ booking: BookingCalendarRow; end: number; start: number }>>();

  for (const booking of calendarView.bookings.items) {
    for (const user of booking.assignedUserSummary.users) {
      const start = new Date(booking.scheduledFor).getTime();
      const end = start + booking.durationMinutes * 60 * 1000;
      const bucket = grouped.get(user.id) ?? [];
      bucket.push({ booking, end, start });
      grouped.set(user.id, bucket);
    }
  }

  const users = [...grouped.entries()].map(([userId, entries]) => {
    const sorted = [...entries].sort((left, right) => left.start - right.start);
    const conflictIds = new Set<string>();

    for (let index = 0; index < sorted.length; index += 1) {
      const current = sorted[index];

      for (let compareIndex = index + 1; compareIndex < sorted.length; compareIndex += 1) {
        const candidate = sorted[compareIndex];

        if (candidate.start >= current.end) {
          break;
        }

        conflictIds.add(current.booking.id);
        conflictIds.add(candidate.booking.id);
      }
    }

    const totalDurationMinutes = sorted.reduce((sum, entry) => sum + entry.booking.durationMinutes, 0);
    const user = sorted[0]?.booking.assignedUserSummary.users.find((entry) => entry.id === userId) ?? null;

    return {
      bookingCount: sorted.length,
      conflictCount: conflictIds.size,
      conflictIndicators: [...conflictIds],
      isOverloaded: totalDurationMinutes > 480,
      overloadIndicator: totalDurationMinutes > 480 ? "Scheduled for more than 8 hours in range." : null,
      totalDurationMinutes,
      user: user as UserSummary,
    };
  });

  return { users };
}

export async function getCRMContactsView(
  context: TenantServiceContext,
  input: PaginationInput & {
    companyId?: string | null;
    nextAction?: NextActionType | null;
    ownerProfileId?: string | null;
    search?: string | null;
    stage?: Tables<"contacts">["stage"] | null;
  },
): Promise<CRMContactsResponse> {
  // Two queries against ui_contact_list_v (SQL does the joins/aggregates/next-action):
  // the whole filtered set's stage + pipeline value (for the pipeline summary + total),
  // and the current page's fully-computed rows.
  let summaryQuery = context.supabase
    .from("ui_contact_list_v")
    .select("stage, pipeline_value_cents")
    .eq("organization_id", context.organizationId);
  let pageQuery = context.supabase
    .from("ui_contact_list_v")
    .select("*")
    .eq("organization_id", context.organizationId);
  if (input.companyId) {
    summaryQuery = summaryQuery.eq("company_id", input.companyId);
    pageQuery = pageQuery.eq("company_id", input.companyId);
  }
  if (input.stage) {
    summaryQuery = summaryQuery.eq("stage", input.stage);
    pageQuery = pageQuery.eq("stage", input.stage);
  }
  if (input.ownerProfileId) {
    summaryQuery = summaryQuery.eq("owner_profile_id", input.ownerProfileId);
    pageQuery = pageQuery.eq("owner_profile_id", input.ownerProfileId);
  }
  if (input.nextAction) {
    summaryQuery = summaryQuery.eq("next_action_type", input.nextAction);
    pageQuery = pageQuery.eq("next_action_type", input.nextAction);
  }
  const search = input.search?.trim().toLowerCase();
  if (search) {
    summaryQuery = summaryQuery.ilike("search_text", `%${search}%`);
    pageQuery = pageQuery.ilike("search_text", `%${search}%`);
  }
  const [{ data: summaryRows, error: summaryError }, { data: pageRows, error: pageError }] =
    await Promise.all([
      summaryQuery,
      pageQuery
        .order("name", { ascending: true })
        .range((input.page - 1) * input.pageSize, input.page * input.pageSize - 1),
    ]);
  if (summaryError) {
    throw summaryError;
  }
  if (pageError) {
    throw pageError;
  }

  const allFiltered = summaryRows ?? [];
  const pipelineSummary = (["lead", "qualified", "active", "closed"] as Array<Tables<"contacts">["stage"]>)
    .map((stage) => {
      const stageRows = allFiltered.filter((row) => row.stage === stage);
      return {
        count: stageRows.length,
        stage,
        valueCents: stageRows.reduce((sum, row) => sum + (row.pipeline_value_cents ?? 0), 0),
      };
    });

  const rows: CRMContactRow[] = (pageRows ?? []).map((row) => ({
    bookingsCount: row.bookings_count ?? 0,
    company: companySummaryFromFields(row.company_id, row.company_name, row.company_stage),
    email: row.email,
    id: row.id ?? "",
    lastActivity: row.last_activity_at
      ? {
          eventType: row.last_activity_event_type ?? "",
          occurredAt: row.last_activity_at,
          title: row.last_activity_event_type ?? "",
        }
      : null,
    name: row.name ?? "",
    nextAction: {
      detail: row.next_action_detail ?? "",
      dueAt: row.next_action_due_at,
      label: row.next_action_label ?? "",
      type: (row.next_action_type ?? "action") as NextActionType,
    },
    owner: userSummaryFromFields(row.owner_id, row.owner_full_name, row.owner_email),
    phone: row.phone,
    pipelineValueCents: row.pipeline_value_cents,
    realizedRevenueCents: row.realized_revenue_cents ?? 0,
    stage: (row.stage ?? "lead") as Tables<"contacts">["stage"],
    upcomingBookingsCount: row.upcoming_bookings_count ?? 0,
  }));

  return {
    pipelineSummary,
    rows: {
      items: rows,
      pagination: buildPaginationMeta(allFiltered.length, input.page, input.pageSize),
    },
  };
}

export async function getCRMContactDetailView(
  context: TenantServiceContext,
  contactId: string,
  input: { companyId?: string | null } = {},
): Promise<ContactDetailResponse> {
  await assertCompanyInOrganization(context, input.companyId);
  const [contacts, bookings, tasks, companies] = await Promise.all([
    listAllRows(context, "contacts"),
    listAllRows(context, "bookings"),
    listAllRows(context, "tasks"),
    listAllRows(context, "companies"),
  ]);
  const contact = contacts.find((item) => item.id === contactId);

  if (!contact) {
    throw new ValidationError("Contact not found.");
  }

  assertCompanyScope("Contact", contact.company_id, input.companyId);

  const companiesMap = new Map(companies.map((company) => [company.id, company]));
  const contactBookings = bookings.filter((booking) => booking.contact_id === contact.id);
  const contactTasks = tasks.filter((task) => task.contact_id === contact.id);
  const profilesMap = await loadProfilesMap(context, uniq([contact.owner_profile_id, ...contactTasks.map((task) => task.assigned_to_profile_id)]));
  const contactRevenueMap = await buildBookingRevenueMap(context, contactBookings, new Map(contacts.map((item) => [item.id, item])));
  const timeline = await getNormalizedTraceForEntity(context, "contact", contact.id);
  const workflowTraces = timeline
    .filter((item) => item.kind === "workflow_run")
    .map((item) => ({
      completedAt: item.metadata.completedAt as string | null ?? null,
      createdAt: item.occurredAt,
      failureReason: typeof item.metadata.failureReason === "string" ? item.metadata.failureReason : item.detail,
      id: item.id,
      status: item.status as Tables<"workflow_runs">["status"],
      workflow: item.entity,
    }));

  const comments = await listComments(context, { entityId: contact.id, entityType: "contact" });
  const commentProfilesMap = await loadProfilesMap(context, uniq(comments.map((comment) => comment.author_profile_id)));

  const linkedQuotes = getQuotesConfig().enabled
    ? (await listQuotes(context, { limit: 100 }))
        .filter((quote) => quote.contact_id === contact.id)
        .map((quote) => ({
          id: quote.id,
          quoteNumber: quote.quote_number,
          status: quote.status,
          title: quote.title,
          totalCents: quote.total_cents,
          depositCents: quote.deposit_cents,
          currency: quote.currency,
          publicToken: quote.public_token,
          createdAt: quote.created_at,
        }))
    : [];

  return {
    comments: comments.map((comment) => ({
      author: toActorSummary(commentProfilesMap.get(comment.author_profile_id ?? "")),
      body: comment.body,
      createdAt: comment.created_at,
      id: comment.id,
    })),
    contact: {
      company: toCompanySummary(companiesMap.get(contact.company_id)),
      createdAt: contact.created_at,
      customerAccountId: contact.customer_account_id ?? null,
      email: contact.email,
      id: contact.id,
      metadata: toJsonRecord(contact.metadata),
      name: getContactName(contact),
      notes: contact.notes,
      owner: toUserSummary(profilesMap.get(contact.owner_profile_id ?? "")),
      phone: contact.phone,
      stage: contact.stage,
    },
    financialSummary: {
      pipelineValueCents: extractValueCents(contact.metadata),
      realizedRevenueCents: contactBookings.reduce((sum, booking) => sum + (contactRevenueMap.get(booking.id) ?? 0), 0),
      upcomingRevenueCents: contactBookings
        .filter((booking) => new Date(booking.scheduled_for) > new Date() && booking.status !== "completed")
        .reduce((sum, booking) => sum + (contactRevenueMap.get(booking.id) ?? 0), 0),
    },
    linkedBookings: (await getCalendarView(context, {
      companyId: contact.company_id,
      end: "9999-12-31T23:59:59.999Z",
      page: 1,
      pageSize: 500,
      start: "1970-01-01T00:00:00.000Z",
    })).bookings.items.filter((booking) => booking.contact?.id === contact.id),
    linkedTasks: (await getTasksListView(context, {
      page: 1,
      pageSize: 500,
    })).rows.items.filter((task) => task.contact?.id === contact.id),
    linkedQuotes,
    nextAction: getNextActionForContact({ bookings: contactBookings, contact, tasks: contactTasks }),
    timeline,
    workflowTraces,
  };
}

export async function getTasksListView(
  context: TenantServiceContext,
  input: PaginationInput & {
    assigneeId?: string | null;
    companyId?: string | null;
    overdue?: boolean;
    priority?: Tables<"tasks">["priority"] | Array<Tables<"tasks">["priority"]> | null;
    search?: string | null;
    status?: Tables<"tasks">["status"] | Array<Tables<"tasks">["status"]> | null;
  },
): Promise<TasksListResponse> {
  // ui_task_list_v does the joins, comment count, and overdue flag in SQL. Summary +
  // total over the whole filtered set (status + is_overdue only); rows for the page.
  let summaryQuery = context.supabase
    .from("ui_task_list_v")
    .select("status, is_overdue")
    .eq("organization_id", context.organizationId);
  let pageQuery = context.supabase
    .from("ui_task_list_v")
    .select("*")
    .eq("organization_id", context.organizationId);
  if (input.companyId) {
    summaryQuery = summaryQuery.eq("company_id", input.companyId);
    pageQuery = pageQuery.eq("company_id", input.companyId);
  }
  // A tab that spans several statuses (Open, Urgent) filters in SQL rather than trimming
  // a page client-side, which silently hid rows past the page size.
  const statuses = input.status ? (Array.isArray(input.status) ? input.status : [input.status]) : [];
  if (statuses.length > 0) {
    summaryQuery = summaryQuery.in("status", statuses);
    pageQuery = pageQuery.in("status", statuses);
  }
  const priorities = input.priority ? (Array.isArray(input.priority) ? input.priority : [input.priority]) : [];
  if (priorities.length > 0) {
    summaryQuery = summaryQuery.in("priority", priorities);
    pageQuery = pageQuery.in("priority", priorities);
  }
  if (input.assigneeId) {
    summaryQuery = summaryQuery.eq("assigned_to_profile_id", input.assigneeId);
    pageQuery = pageQuery.eq("assigned_to_profile_id", input.assigneeId);
  }
  if (input.overdue) {
    summaryQuery = summaryQuery.eq("is_overdue", true);
    pageQuery = pageQuery.eq("is_overdue", true);
  }
  const search = input.search?.trim().toLowerCase();
  if (search) {
    summaryQuery = summaryQuery.ilike("search_text", `%${search}%`);
    pageQuery = pageQuery.ilike("search_text", `%${search}%`);
  }
  const [{ data: summaryRows, error: summaryError }, { data: pageRows, error: pageError }] =
    await Promise.all([
      summaryQuery,
      pageQuery
        .order("created_at", { ascending: false })
        .range((input.page - 1) * input.pageSize, input.page * input.pageSize - 1),
    ]);
  if (summaryError) {
    throw summaryError;
  }
  if (pageError) {
    throw pageError;
  }

  const allFiltered = summaryRows ?? [];
  const rows: TaskListRow[] = (pageRows ?? []).map((row) => ({
    assignee: userSummaryFromFields(row.assignee_id, row.assignee_full_name, row.assignee_email),
    booking: row.booking_id
      ? { id: row.booking_id, label: row.booking_title ?? row.booking_id, type: "booking" }
      : null,
    commentsCount: row.comments_count ?? 0,
    company: companySummaryFromFields(row.company_id, row.company_name, row.company_stage),
    contact: row.contact_id
      ? {
          company: companySummaryFromFields(row.contact_company_id, row.contact_company_name, row.contact_company_stage),
          email: row.contact_email,
          id: row.contact_id,
          name: [row.contact_first_name, row.contact_last_name].filter(Boolean).join(" ").trim(),
          phone: row.contact_phone,
          stage: (row.contact_stage ?? "lead") as Tables<"contacts">["stage"],
        }
      : null,
    dueAt: row.due_at,
    id: row.id ?? "",
    isOverdue: row.is_overdue ?? false,
    priority: (row.priority ?? "medium") as Tables<"tasks">["priority"],
    status: (row.status ?? "todo") as Tables<"tasks">["status"],
    title: row.title ?? "",
    workflow: row.workflow_id
      ? { id: row.workflow_id, label: row.workflow_name ?? row.workflow_id, type: "workflow" }
      : null,
  }));

  return {
    rows: {
      items: rows,
      pagination: buildPaginationMeta(allFiltered.length, input.page, input.pageSize),
    },
    summary: {
      blockedCount: allFiltered.filter((row) => row.status === "blocked").length,
      completedCount: allFiltered.filter((row) => row.status === "completed").length,
      inProgressCount: allFiltered.filter((row) => row.status === "in_progress").length,
      overdueCount: allFiltered.filter((row) => row.is_overdue).length,
      todoCount: allFiltered.filter((row) => row.status === "todo").length,
    },
  };
}

export async function getTaskDetailView(
  context: TenantServiceContext,
  taskId: string,
  input: { companyId?: string | null } = {},
): Promise<TaskDetailResponse> {
  await assertCompanyInOrganization(context, input.companyId);
  const [tasks, contacts, bookings, companies] = await Promise.all([
    listAllRows(context, "tasks"),
    listAllRows(context, "contacts"),
    listAllRows(context, "bookings"),
    listAllRows(context, "companies"),
  ]);
  const task = tasks.find((item) => item.id === taskId);

  if (!task) {
    throw new ValidationError("Task not found.");
  }

  assertCompanyScope("Task", task.company_id, input.companyId);

  const companiesMap = new Map(companies.map((company) => [company.id, company]));
  const contactsMap = new Map(contacts.map((contact) => [contact.id, contact]));
  const bookingsMap = new Map(bookings.map((booking) => [booking.id, booking]));
  const profilesMap = await loadProfilesMap(context, uniq([task.assigned_to_profile_id]));
  const workflowsMap = await loadWorkflowsMap(context, uniq([task.workflow_id]));
  const comments = await listComments(context, { entityId: task.id, entityType: "task" });
  const commentProfilesMap = await loadProfilesMap(context, uniq(comments.map((comment) => comment.author_profile_id)));
  const trace = await getNormalizedTraceForEntity(context, "task", task.id);
  const latestWorkflowRun = trace.find((item) => item.kind === "workflow_run") ?? null;

  return {
    comments: comments.map((comment) => ({
      author: toActorSummary(commentProfilesMap.get(comment.author_profile_id ?? "")),
      body: comment.body,
      createdAt: comment.created_at,
      id: comment.id,
    })),
    linkedEntities: {
      booking: task.booking_id && bookingsMap.get(task.booking_id)
        ? { id: task.booking_id, label: bookingsMap.get(task.booking_id)?.title ?? task.booking_id, type: "booking" }
        : null,
      company: toCompanySummary(companiesMap.get(task.company_id ?? "")),
      contact: task.contact_id && contactsMap.get(task.contact_id)
        ? {
            company: toCompanySummary(companiesMap.get(contactsMap.get(task.contact_id)?.company_id ?? "")),
            email: contactsMap.get(task.contact_id)?.email ?? null,
            id: task.contact_id,
            name: getContactName(contactsMap.get(task.contact_id) as Tables<"contacts">),
            phone: contactsMap.get(task.contact_id)?.phone ?? null,
            stage: contactsMap.get(task.contact_id)?.stage ?? "lead",
          }
        : null,
      workflow: task.workflow_id && workflowsMap.get(task.workflow_id)
        ? { id: task.workflow_id, label: workflowsMap.get(task.workflow_id)?.name ?? task.workflow_id, type: "workflow" }
        : null,
    },
    task: {
      assignee: toUserSummary(profilesMap.get(task.assigned_to_profile_id ?? "")),
      createdAt: task.created_at,
      description: task.description,
      dueAt: task.due_at,
      id: task.id,
      isOverdue: isTaskOverdue(task),
      priority: task.priority,
      status: task.status,
      title: task.title,
    },
    trace,
    workflowOrigin: {
      latestRun: latestWorkflowRun
        ? {
            completedAt: null,
            createdAt: latestWorkflowRun.occurredAt,
            failureReason: latestWorkflowRun.status === "failed" ? latestWorkflowRun.detail : null,
            id: latestWorkflowRun.id,
            status: latestWorkflowRun.status as Tables<"workflow_runs">["status"],
          }
        : null,
      workflow: task.workflow_id && workflowsMap.get(task.workflow_id)
        ? { id: task.workflow_id, label: workflowsMap.get(task.workflow_id)?.name ?? task.workflow_id, type: "workflow" }
        : null,
    },
  };
}

export async function getWorkflowsListView(
  context: TenantServiceContext,
  input: PaginationInput & {
    companyId?: string | null;
    search?: string | null;
    status?: Tables<"workflows">["status"] | null;
    triggerType?: string | null;
  },
): Promise<WorkflowsListResponse> {
  // ui_workflow_list_v rolls up each workflow's run metrics in SQL. One query with a
  // count gives the page + total; the run rollups are computed only for the page.
  let query = context.supabase
    .from("ui_workflow_list_v")
    .select("*", { count: "exact" })
    .eq("organization_id", context.organizationId);
  if (input.companyId) {
    query = query.eq("company_id", input.companyId);
  }
  if (input.status) {
    query = query.eq("status", input.status);
  }
  if (input.triggerType) {
    query = query.eq("trigger_type", input.triggerType);
  }
  // Sanitise the term to plain words before interpolating into a PostgREST or() filter
  // (guards against filter injection); ilike is case-insensitive over name/description/trigger.
  const search = input.search?.replace(/[^a-z0-9 ]/gi, " ").trim().toLowerCase();
  if (search) {
    query = query.or(
      `name.ilike.%${search}%,description.ilike.%${search}%,trigger_type.ilike.%${search}%`,
    );
  }
  const { data, count, error } = await query
    .order("created_at", { ascending: false })
    .range((input.page - 1) * input.pageSize, input.page * input.pageSize - 1);
  if (error) {
    throw error;
  }

  const rows: WorkflowListRow[] = (data ?? []).map((row) => {
    const totalRuns = row.total_runs ?? 0;
    const successfulRuns = row.successful_runs ?? 0;
    return {
      company: companySummaryFromFields(row.company_id, row.company_name, row.company_stage),
      createdAt: row.created_at ?? "",
      description: row.description,
      id: row.id ?? "",
      metrics: {
        failedRuns: row.failed_runs ?? 0,
        successRate: totalRuns === 0 ? 0 : Number(((successfulRuns / totalRuns) * 100).toFixed(1)),
        successfulRuns,
        totalRuns,
      },
      name: row.name ?? "",
      recentRunSummary: {
        lastRunAt: row.last_run_at,
        lastRunStatus: (row.last_run_status ?? null) as Tables<"workflow_runs">["status"] | null,
        recentRunsCount: row.recent_runs_count ?? 0,
      },
      status: (row.status ?? "draft") as Tables<"workflows">["status"],
      triggerType: row.trigger_type ?? "",
    };
  });

  return {
    rows: {
      items: rows,
      pagination: buildPaginationMeta(count ?? 0, input.page, input.pageSize),
    },
  };
}

function extractRunConditionResults(
  contextJson: Json,
): Array<{ actualValue: Json; field: string; matched: boolean; operator: string; value: Json }> {
  const record =
    contextJson && typeof contextJson === "object" && !Array.isArray(contextJson)
      ? (contextJson as Record<string, Json>)
      : {};
  const raw = record.condition_results;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const entry = (item && typeof item === "object" && !Array.isArray(item) ? item : {}) as Record<string, Json>;
    const condition = (entry.condition && typeof entry.condition === "object" && !Array.isArray(entry.condition)
      ? entry.condition
      : {}) as Record<string, Json>;
    return {
      actualValue: entry.actualValue ?? null,
      field: typeof condition.field === "string" ? condition.field : "",
      matched: entry.matched === true,
      operator: typeof condition.operator === "string" ? condition.operator : "",
      value: condition.value ?? null,
    };
  });
}

export async function getWorkflowDetailView(
  context: TenantServiceContext,
  workflowId: string,
  pagination: PaginationInput,
  input: { companyId?: string | null } = {},
): Promise<WorkflowDetailResponse> {
  await assertCompanyInOrganization(context, input.companyId);
  const [workflows, companies, workflowRuns, workflowEventJobs, activityEvents] = await Promise.all([
    listAllRows(context, "workflows"),
    listAllRows(context, "companies"),
    listAllRows(context, "workflow_runs"),
    listAllRows(context, "workflow_event_jobs"),
    listAllRows(context, "activity_events"),
  ]);
  const workflow = workflows.find((item) => item.id === workflowId);

  if (!workflow) {
    throw new ValidationError("Workflow not found.");
  }

  assertCompanyScope("Workflow", workflow.company_id, input.companyId);

  const companiesMap = new Map(companies.map((company) => [company.id, company]));
  const relatedRuns = workflowRuns
    .filter((run) => run.workflow_id === workflow.id)
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  const activityEventMap = new Map(activityEvents.map((activityEvent) => [activityEvent.id, activityEvent]));
  const failedJobs = workflowEventJobs
    .filter((job) => job.status === "failed" && relatedRuns.some((run) => run.trigger_event_id === job.activity_event_id))
    .sort((left, right) => (right.completed_at ?? right.updated_at).localeCompare(left.completed_at ?? left.updated_at));
  const paginatedRuns = paginateItems(
    relatedRuns.map((run) => ({
      actionsExecutedCount: run.actions_executed_count,
      completedAt: run.completed_at,
      conditionResults: extractRunConditionResults(run.context_json),
      createdAt: run.created_at,
      createdTasksCount: run.created_tasks_count,
      failureReason: run.failure_reason,
      id: run.id,
      resumeAt: run.resume_at,
      status: run.status,
      timeSavedSeconds: run.time_saved_seconds,
      triggerEvent: run.trigger_event_id && activityEventMap.get(run.trigger_event_id)
        ? {
            id: run.trigger_event_id,
            label: activityEventMap.get(run.trigger_event_id)?.event_type ?? run.trigger_event_id,
            type: "activity_event",
          }
        : null,
    })),
    pagination,
  );

  return {
    relatedFailedJobs: failedJobs.map((job) => ({
      activityEvent: activityEventMap.get(job.activity_event_id)
        ? {
            id: job.activity_event_id,
            label: activityEventMap.get(job.activity_event_id)?.event_type ?? job.activity_event_id,
            type: "activity_event",
          }
        : null,
      failedAt: job.completed_at,
      id: job.id,
      lastError: job.last_error,
      retryEligible: job.status === "failed",
      status: job.status,
    })),
    workflow: {
      company: toCompanySummary(companiesMap.get(workflow.company_id ?? "")),
      createdAt: workflow.created_at,
      definition: workflow.definition,
      description: workflow.description,
      id: workflow.id,
      name: workflow.name,
      status: workflow.status,
      triggerType: workflow.trigger_event,
    },
    workflowRuns: paginatedRuns,
  };
}

export async function getWorkflowJobsListView(
  context: TenantServiceContext,
  input: PaginationInput & {
    companyId?: string | null;
    recentFailuresOnly?: boolean;
    status?: Tables<"workflow_event_jobs">["status"] | null;
  },
): Promise<WorkflowJobsListResponse> {
  const [workflowEventJobs, summary] = await Promise.all([
    listWorkflowEventJobs(context, {
      companyId: input.companyId,
      recentFailuresOnly: input.recentFailuresOnly,
      status: input.status,
    }),
    getWorkflowEventJobsHealthSummary(context, { companyId: input.companyId }),
  ]);
  // Enrich only the companies/events these jobs reference — not the whole tables.
  const companiesMap = await loadCompaniesMap(
    context,
    uniq(workflowEventJobs.map((job) => job.company_id)),
  );
  const eventIds = uniq(workflowEventJobs.map((job) => job.activity_event_id));
  const { data: eventRows } = eventIds.length
    ? await context.supabase
        .from("activity_events")
        .select("id, event_type")
        .eq("organization_id", context.organizationId)
        .in("id", eventIds)
    : { data: [] as { id: string; event_type: string }[] };
  const activityEventMap = new Map((eventRows ?? []).map((event) => [event.id, event.event_type]));
  const rows = workflowEventJobs
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .map((job) => ({
      activityEvent: activityEventMap.has(job.activity_event_id)
        ? {
            id: job.activity_event_id,
            label: activityEventMap.get(job.activity_event_id) ?? job.activity_event_id,
            type: "activity_event",
          }
        : null,
      activityEventId: job.activity_event_id,
      attemptCount: job.attempt_count,
      availableAt: job.available_at,
      company: toCompanySummary(companiesMap.get(job.company_id ?? "")),
      companyId: job.company_id,
      claimedAt: job.locked_at,
      completedAt: job.completed_at,
      failureReason: job.last_error,
      id: job.id,
      lastAttemptedAt: job.last_attempted_at,
      lastError: job.last_error,
      organizationId: job.organization_id,
      remainingAttempts: Math.max(job.max_attempts - job.attempt_count, 0),
      retryEligible: isWorkflowEventJobRetryEligible(job),
      status: job.status,
      updatedAt: job.updated_at,
      workerId: job.locked_by,
    }));

  return {
    summary,
    rows: paginateItems(rows, input),
  };
}

export async function getUnifiedTraceView(
  context: TenantServiceContext,
  entityType: TraceEntityType,
  entityId: string,
): Promise<UnifiedTraceResponse> {
  const trace = await getNormalizedTraceForEntity(context, entityType, entityId);
  const entityReferenceMap = await buildEntityReferenceMap(context, [{ id: entityId, type: entityType }]);
  const entity = entityReferenceMap.get(`${entityType}:${entityId}`);

  if (!entity) {
    throw new ValidationError("Trace entity not found.");
  }

  return {
    entity,
    trace,
  };
}
