import type { Json, Tables } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";
import { listComments } from "@/server/services/comments";
import { getContactTrace, getBookingTrace, getTaskTrace } from "@/server/services/traces";
import type { TenantServiceContext } from "@/server/services/shared";

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
    email: string | null;
    id: string;
    metadata: Record<string, Json>;
    name: string;
    notes: string | null;
    owner: UserSummary | null;
    phone: string | null;
    stage: Tables<"contacts">["stage"];
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
    completedAt: string | null;
    createdAt: string;
    failureReason: string | null;
    id: string;
    status: Tables<"workflow_runs">["status"];
    triggerEvent: EntityReferenceSummary | null;
  }>;
}

export interface WorkflowJobsListResponse {
  rows: PaginatedResult<{
    activityEvent: EntityReferenceSummary | null;
    attemptCount: number;
    availableAt: string;
    company: CompanySummary | null;
    completedAt: string | null;
    id: string;
    lastAttemptedAt: string | null;
    lastError: string | null;
    retryEligible: boolean;
    status: Tables<"workflow_event_jobs">["status"];
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

async function listAllRows<T extends OrganizationScopedTable>(
  context: TenantServiceContext,
  table: T,
): Promise<TablesMap[T][]> {
  const query = context.supabase.from(table as never) as unknown as {
    select: (columns: string) => {
      eq: (column: string, value: string) => PromiseLike<{ data: unknown[] | null; error: unknown }>;
    };
  };
  const { data, error } = await query.select("*").eq("organization_id", context.organizationId);

  if (error) {
    throw error;
  }

  return (data ?? []) as unknown as TablesMap[T][];
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

  return traceItems.map((item) => {
    if (item.kind === "activity_event") {
      const activityEvent = item.data as Tables<"activity_events">;

      return {
        actor: toActorSummary(profilesMap.get(activityEvent.actor_user_id ?? "")),
        company: toCompanySummary(companiesMap.get(activityEvent.company_id ?? "")),
        detail: activityEvent.event_type,
        entity: activityEvent.entity_id
          ? entityReferenceMap.get(`${activityEvent.entity_type}:${activityEvent.entity_id}`) ?? null
          : null,
        id: item.id,
        kind: item.kind,
        metadata: toJsonRecord(activityEvent.metadata_json),
        occurredAt: item.occurredAt,
        relatedEntity: activityEvent.related_entity_id && activityEvent.related_entity_type
          ? entityReferenceMap.get(`${activityEvent.related_entity_type}:${activityEvent.related_entity_id}`) ?? null
          : null,
        status: null,
        title: activityEvent.event_type,
      } satisfies TraceRecord;
    }

    if (item.kind === "workflow_run") {
      const workflowRun = item.data as Tables<"workflow_runs">;
      const workflow = workflowsMap.get(workflowRun.workflow_id);

      return {
        actor: null,
        company: toCompanySummary(companiesMap.get(workflowRun.company_id ?? "")),
        detail: workflowRun.failure_reason ?? `${workflowRun.actions_executed_count} actions executed`,
        entity: workflow ? { id: workflow.id, label: workflow.name, type: "workflow" } : null,
        id: item.id,
        kind: item.kind,
        metadata: {
          actionsExecutedCount: workflowRun.actions_executed_count,
          createdTasksCount: workflowRun.created_tasks_count,
          timeSavedSeconds: workflowRun.time_saved_seconds,
        },
        occurredAt: item.occurredAt,
        relatedEntity: workflowRun.trigger_event_id
          ? entityReferenceMap.get(`activity_event:${workflowRun.trigger_event_id}`) ?? null
          : null,
        status: workflowRun.status,
        title: workflow ? workflow.name : "Workflow run",
      } satisfies TraceRecord;
    }

    if (item.kind === "task") {
      const task = item.data as Tables<"tasks">;

      return {
        actor: toActorSummary(profilesMap.get(task.created_by ?? "")),
        company: toCompanySummary(companiesMap.get(task.company_id ?? "")),
        detail: task.description ?? task.status,
        entity: { id: task.id, label: task.title, type: "task" },
        id: item.id,
        kind: item.kind,
        metadata: { priority: task.priority, status: task.status },
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
        detail: booking.description ?? booking.status,
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

export async function getDashboardSummary(context: TenantServiceContext): Promise<DashboardSummary> {
  const [tasks, bookings, contacts, workflows, workflowJobs, activityEvents] = await Promise.all([
    listAllRows(context, "tasks"),
    listAllRows(context, "bookings"),
    listAllRows(context, "contacts"),
    listAllRows(context, "workflows"),
    listAllRows(context, "workflow_event_jobs"),
    listAllRows(context, "activity_events"),
  ]);
  const now = new Date();
  const todayStart = startOfUtcDay(now);
  const todayEnd = endOfUtcDay(now);

  return {
    activeWorkflowCount: workflows.filter((workflow) => workflow.status === "active").length,
    failedWorkflowJobCount: workflowJobs.filter((job) => job.status === "failed").length,
    newLeadCount: contacts.filter((contact) => contact.stage === "lead").length,
    overdueTaskCount: tasks.filter((task) => isTaskOverdue(task, now)).length,
    revenueSnapshot: summarizeRevenueFromEvents(activityEvents.filter((event) => event.entity_type === "booking")),
    todayBookingCount: bookings.filter((booking) => {
      const scheduled = new Date(booking.scheduled_for);
      return scheduled >= todayStart && scheduled <= todayEnd;
    }).length,
    upcomingBookingCount: bookings.filter((booking) => new Date(booking.scheduled_for) > now).length,
    urgentTaskCount: tasks.filter((task) => task.priority === "urgent" && task.status !== "completed").length,
  };
}

export async function getDashboardActivityFeed(
  context: TenantServiceContext,
  input: PaginationInput & { companyId?: string | null },
): Promise<PaginatedResult<DashboardActivityFeedItem>> {
  const activityEvents = (await listAllRows(context, "activity_events"))
    .filter((event) => !input.companyId || event.company_id === input.companyId)
    .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at));
  const companiesMap = await loadCompaniesMap(context, uniq(activityEvents.map((event) => event.company_id)));
  const entityReferenceMap = await buildEntityReferenceMap(
    context,
    activityEvents.flatMap((event) => [
      { id: event.entity_id, type: event.entity_type },
      { id: event.related_entity_id, type: event.related_entity_type },
    ]),
  );
  const paginated = paginateItems(activityEvents, input);

  return {
    items: paginated.items.map((event) => ({
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
    pagination: paginated.pagination,
  };
}

export async function getAutomationImpact(context: TenantServiceContext): Promise<AutomationImpactSummary> {
  const [workflowRuns, workflowJobs] = await Promise.all([
    listAllRows(context, "workflow_runs"),
    listAllRows(context, "workflow_event_jobs"),
  ]);
  const totalWorkflowRuns = workflowRuns.length;
  const successfulRuns = workflowRuns.filter((run) => run.status === "completed").length;

  return {
    estimatedTimeSavedSeconds: workflowRuns.reduce((sum, run) => sum + run.time_saved_seconds, 0),
    failedJobsCount: workflowJobs.filter((job) => job.status === "failed").length,
    successRate: totalWorkflowRuns === 0 ? 0 : Number(((successfulRuns / totalWorkflowRuns) * 100).toFixed(1)),
    tasksAutoCreated: workflowRuns.reduce((sum, run) => sum + run.created_tasks_count, 0),
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
  const [bookings, tasks, contacts, companies] = await Promise.all([
    listAllRows(context, "bookings"),
    listAllRows(context, "tasks"),
    listAllRows(context, "contacts"),
    listAllRows(context, "companies"),
  ]);
  const companiesMap = new Map(companies.map((company) => [company.id, company]));
  const contactsMap = new Map(contacts.map((contact) => [contact.id, contact]));
  const profilesMap = await loadProfilesMap(context, uniq(tasks.map((task) => task.assigned_to_profile_id)));
  const bookingsInRange = bookings.filter((booking) => {
    if (input.companyId && booking.company_id !== input.companyId) {
      return false;
    }

    return isWithinRange(booking.scheduled_for, input.start, input.end);
  });
  const tasksByBooking = new Map<string, Tables<"tasks">[]>();

  for (const task of tasks) {
    if (!task.booking_id) {
      continue;
    }

    const bucket = tasksByBooking.get(task.booking_id) ?? [];
    bucket.push(task);
    tasksByBooking.set(task.booking_id, bucket);
  }

  const filteredBookings = bookingsInRange.filter((booking) => {
    if (!input.assignedUserId) {
      return true;
    }

    return (tasksByBooking.get(booking.id) ?? []).some((task) => task.assigned_to_profile_id === input.assignedUserId);
  });
  const revenueMap = await buildBookingRevenueMap(context, filteredBookings, contactsMap);
  const rows = filteredBookings
    .sort((left, right) => left.scheduled_for.localeCompare(right.scheduled_for))
    .map((booking) => {
      const linkedTasks = tasksByBooking.get(booking.id) ?? [];
      const users = uniq(linkedTasks.map((task) => task.assigned_to_profile_id))
        .map((profileId) => toUserSummary(profilesMap.get(profileId)))
        .filter((user): user is UserSummary => Boolean(user));

      return {
        assignedUserSummary: {
          count: users.length,
          primary: users[0] ?? null,
          users,
        },
        company: toCompanySummary(companiesMap.get(booking.company_id)),
        contact: booking.contact_id
          ? {
              company: toCompanySummary(companiesMap.get(contactsMap.get(booking.contact_id)?.company_id ?? "")),
              email: contactsMap.get(booking.contact_id)?.email ?? null,
              id: booking.contact_id,
              name: getContactName(contactsMap.get(booking.contact_id) as Tables<"contacts">),
              phone: contactsMap.get(booking.contact_id)?.phone ?? null,
              stage: contactsMap.get(booking.contact_id)?.stage ?? "lead",
            }
          : null,
        durationMinutes: booking.duration_minutes,
        id: booking.id,
        priority: getHighestPriority(linkedTasks),
        revenueCents: revenueMap.get(booking.id) ?? null,
        scheduledFor: booking.scheduled_for,
        status: booking.status,
        taskCount: linkedTasks.length,
        title: booking.title,
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
): Promise<BookingDetailResponse> {
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

  return {
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
  const [contacts, bookings, tasks, activityEvents, companies] = await Promise.all([
    listAllRows(context, "contacts"),
    listAllRows(context, "bookings"),
    listAllRows(context, "tasks"),
    listAllRows(context, "activity_events"),
    listAllRows(context, "companies"),
  ]);
  const filteredContacts = contacts.filter((contact) => {
    if (input.companyId && contact.company_id !== input.companyId) {
      return false;
    }

    if (input.stage && contact.stage !== input.stage) {
      return false;
    }

    if (input.ownerProfileId && contact.owner_profile_id !== input.ownerProfileId) {
      return false;
    }

    return matchesSearch(
      [
        contact.first_name,
        contact.last_name,
        contact.email,
        contact.phone,
        getContactName(contact),
      ],
      input.search,
    );
  });
  const contactIds = filteredContacts.map((contact) => contact.id);
  const relatedBookings = bookings.filter((booking) => contactIds.includes(booking.contact_id ?? ""));
  const relatedTasks = tasks.filter((task) => contactIds.includes(task.contact_id ?? ""));
  const companiesMap = new Map(companies.map((company) => [company.id, company]));
  const profilesMap = await loadProfilesMap(context, uniq(filteredContacts.map((contact) => contact.owner_profile_id)));
  const contactRevenueMap = new Map(filteredContacts.map((contact) => [contact.id, extractValueCents(contact.metadata) ?? 0]));
  const bookingRevenueMap = await buildBookingRevenueMap(context, relatedBookings, new Map(contacts.map((contact) => [contact.id, contact])));
  const rows = filteredContacts.map((contact) => {
    const contactBookings = relatedBookings.filter((booking) => booking.contact_id === contact.id);
    const contactTasks = relatedTasks.filter((task) => task.contact_id === contact.id);
    const nextAction = getNextActionForContact({ bookings: contactBookings, contact, tasks: contactTasks });
    const lastActivityEvent = activityEvents
      .filter((event) => (event.entity_type === "contact" && event.entity_id === contact.id) || (event.related_entity_type === "contact" && event.related_entity_id === contact.id))
      .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at))[0];
    const realizedRevenueCents = contactBookings.reduce((sum, booking) => sum + (bookingRevenueMap.get(booking.id) ?? 0), 0);

    return {
      bookingsCount: contactBookings.length,
      company: toCompanySummary(companiesMap.get(contact.company_id)),
      email: contact.email,
      id: contact.id,
      lastActivity: lastActivityEvent
        ? {
            eventType: lastActivityEvent.event_type,
            occurredAt: lastActivityEvent.occurred_at,
            title: lastActivityEvent.event_type,
          }
        : null,
      name: getContactName(contact),
      nextAction,
      owner: toUserSummary(profilesMap.get(contact.owner_profile_id ?? "")),
      phone: contact.phone,
      pipelineValueCents: contactRevenueMap.get(contact.id) ?? null,
      realizedRevenueCents,
      stage: contact.stage,
      upcomingBookingsCount: contactBookings.filter((booking) => new Date(booking.scheduled_for) > new Date() && booking.status !== "completed").length,
    } satisfies CRMContactRow;
  }).filter((row) => !input.nextAction || row.nextAction.type === input.nextAction);
  const paginatedRows = paginateItems(rows.sort((left, right) => left.name.localeCompare(right.name)), input);
  const pipelineSummary = (["lead", "qualified", "active", "closed"] as Array<Tables<"contacts">["stage"]>)
    .map((stage) => {
      const stageRows = rows.filter((row) => row.stage === stage);
      return {
        count: stageRows.length,
        stage,
        valueCents: stageRows.reduce((sum, row) => sum + (row.pipelineValueCents ?? 0), 0),
      };
    });

  return {
    pipelineSummary,
    rows: paginatedRows,
  };
}

export async function getCRMContactDetailView(
  context: TenantServiceContext,
  contactId: string,
): Promise<ContactDetailResponse> {
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

  return {
    contact: {
      company: toCompanySummary(companiesMap.get(contact.company_id)),
      createdAt: contact.created_at,
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
    priority?: Tables<"tasks">["priority"] | null;
    search?: string | null;
    status?: Tables<"tasks">["status"] | null;
  },
): Promise<TasksListResponse> {
  const [tasks, contacts, bookings, companies] = await Promise.all([
    listAllRows(context, "tasks"),
    listAllRows(context, "contacts"),
    listAllRows(context, "bookings"),
    listAllRows(context, "companies"),
  ]);
  const filteredTasks = tasks.filter((task) => {
    if (input.companyId && task.company_id !== input.companyId) {
      return false;
    }

    if (input.status && task.status !== input.status) {
      return false;
    }

    if (input.priority && task.priority !== input.priority) {
      return false;
    }

    if (input.assigneeId && task.assigned_to_profile_id !== input.assigneeId) {
      return false;
    }

    if (input.overdue && !isTaskOverdue(task)) {
      return false;
    }

    return matchesSearch([task.id, task.title, task.description], input.search);
  });
  const contactsMap = new Map(contacts.map((contact) => [contact.id, contact]));
  const bookingsMap = new Map(bookings.map((booking) => [booking.id, booking]));
  const companiesMap = new Map(companies.map((company) => [company.id, company]));
  const profilesMap = await loadProfilesMap(context, uniq(filteredTasks.map((task) => task.assigned_to_profile_id)));
  const workflowsMap = await loadWorkflowsMap(context, uniq(filteredTasks.map((task) => task.workflow_id)));
  const comments = await listAllRows(context, "comments");
  const rows = filteredTasks
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .map((task) => ({
      assignee: toUserSummary(profilesMap.get(task.assigned_to_profile_id ?? "")),
      booking: task.booking_id && bookingsMap.get(task.booking_id)
        ? { id: task.booking_id, label: bookingsMap.get(task.booking_id)?.title ?? task.booking_id, type: "booking" }
        : null,
      commentsCount: comments.filter((comment) => comment.entity_type === "task" && comment.entity_id === task.id).length,
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
      dueAt: task.due_at,
      id: task.id,
      isOverdue: isTaskOverdue(task),
      priority: task.priority,
      status: task.status,
      title: task.title,
      workflow: task.workflow_id && workflowsMap.get(task.workflow_id)
        ? { id: task.workflow_id, label: workflowsMap.get(task.workflow_id)?.name ?? task.workflow_id, type: "workflow" }
        : null,
    } satisfies TaskListRow));

  return {
    rows: paginateItems(rows, input),
    summary: {
      blockedCount: rows.filter((row) => row.status === "blocked").length,
      completedCount: rows.filter((row) => row.status === "completed").length,
      inProgressCount: rows.filter((row) => row.status === "in_progress").length,
      overdueCount: rows.filter((row) => row.isOverdue).length,
      todoCount: rows.filter((row) => row.status === "todo").length,
    },
  };
}

export async function getTaskDetailView(
  context: TenantServiceContext,
  taskId: string,
): Promise<TaskDetailResponse> {
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
  const [workflows, companies, workflowRuns] = await Promise.all([
    listAllRows(context, "workflows"),
    listAllRows(context, "companies"),
    listAllRows(context, "workflow_runs"),
  ]);
  const companiesMap = new Map(companies.map((company) => [company.id, company]));
  const rows = workflows
    .filter((workflow) => {
      if (input.companyId && workflow.company_id !== input.companyId) {
        return false;
      }

      if (input.status && workflow.status !== input.status) {
        return false;
      }

      if (input.triggerType && workflow.trigger_event !== input.triggerType) {
        return false;
      }

      return matchesSearch([workflow.name, workflow.description, workflow.trigger_event], input.search);
    })
    .map((workflow) => {
      const relatedRuns = workflowRuns.filter((run) => run.workflow_id === workflow.id);
      const successfulRuns = relatedRuns.filter((run) => run.status === "completed").length;
      const failedRuns = relatedRuns.filter((run) => run.status === "failed").length;
      const lastRun = [...relatedRuns].sort((left, right) => right.created_at.localeCompare(left.created_at))[0];

      return {
        company: toCompanySummary(companiesMap.get(workflow.company_id ?? "")),
        createdAt: workflow.created_at,
        description: workflow.description,
        id: workflow.id,
        metrics: {
          failedRuns,
          successRate: relatedRuns.length === 0 ? 0 : Number(((successfulRuns / relatedRuns.length) * 100).toFixed(1)),
          successfulRuns,
          totalRuns: relatedRuns.length,
        },
        name: workflow.name,
        recentRunSummary: {
          lastRunAt: lastRun?.created_at ?? null,
          lastRunStatus: lastRun?.status ?? null,
          recentRunsCount: relatedRuns.filter((run) => new Date(run.created_at) >= new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)).length,
        },
        status: workflow.status,
        triggerType: workflow.trigger_event,
      } satisfies WorkflowListRow;
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  return {
    rows: paginateItems(rows, input),
  };
}

export async function getWorkflowDetailView(
  context: TenantServiceContext,
  workflowId: string,
  pagination: PaginationInput,
): Promise<WorkflowDetailResponse> {
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
      completedAt: run.completed_at,
      createdAt: run.created_at,
      failureReason: run.failure_reason,
      id: run.id,
      status: run.status,
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
    status?: Tables<"workflow_event_jobs">["status"] | null;
  },
): Promise<WorkflowJobsListResponse> {
  const [workflowEventJobs, companies, activityEvents] = await Promise.all([
    listAllRows(context, "workflow_event_jobs"),
    listAllRows(context, "companies"),
    listAllRows(context, "activity_events"),
  ]);
  const companiesMap = new Map(companies.map((company) => [company.id, company]));
  const activityEventMap = new Map(activityEvents.map((activityEvent) => [activityEvent.id, activityEvent]));
  const rows = workflowEventJobs
    .filter((job) => {
      if (input.companyId && job.company_id !== input.companyId) {
        return false;
      }

      if (input.status && job.status !== input.status) {
        return false;
      }

      return true;
    })
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .map((job) => ({
      activityEvent: activityEventMap.get(job.activity_event_id)
        ? {
            id: job.activity_event_id,
            label: activityEventMap.get(job.activity_event_id)?.event_type ?? job.activity_event_id,
            type: "activity_event",
          }
        : null,
      attemptCount: job.attempt_count,
      availableAt: job.available_at,
      company: toCompanySummary(companiesMap.get(job.company_id ?? "")),
      completedAt: job.completed_at,
      id: job.id,
      lastAttemptedAt: job.last_attempted_at,
      lastError: job.last_error,
      retryEligible: job.status === "failed",
      status: job.status,
    }));

  return {
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