import type { Tables } from "@/server/db/database.types";
import {
  assertBookingInOrganization,
  assertContactInOrganization,
  assertTaskInOrganization,
  type TenantServiceContext,
} from "@/server/services/shared";

export type TraceItemKind = "activity_event" | "booking" | "comment" | "task" | "workflow_run";

export interface TraceItem {
  companyId: string | null;
  data:
    | Tables<"activity_events">
    | Tables<"bookings">
    | Tables<"comments">
    | Tables<"tasks">
    | Tables<"workflow_runs">;
  id: string;
  kind: TraceItemKind;
  occurredAt: string;
}

function sortAndLimitTrace(items: TraceItem[], limit?: number): TraceItem[] {
  const sorted = [...items].sort((left, right) =>
    right.occurredAt.localeCompare(left.occurredAt),
  );

  return limit ? sorted.slice(0, limit) : sorted;
}

async function listEntityActivityEvents(
  context: TenantServiceContext,
  entityType: string,
  entityId: string,
): Promise<Tables<"activity_events">[]> {
  const { data, error } = await context.supabase
    .from("activity_events")
    .select("*")
    .eq("organization_id", context.organizationId)
    .or(
      `and(entity_type.eq.${entityType},entity_id.eq.${entityId}),and(related_entity_type.eq.${entityType},related_entity_id.eq.${entityId})`,
    )
    .order("occurred_at", { ascending: false });

  if (error) {
    throw error;
  }

  return data ?? [];
}

export async function getContactTrace(
  context: TenantServiceContext,
  contactId: string,
  limit?: number,
): Promise<TraceItem[]> {
  await assertContactInOrganization(context, contactId);

  const [eventsResult, commentsResult, bookingsResult, tasksResult] = await Promise.all([
    listEntityActivityEvents(context, "contact", contactId),
    context.supabase
      .from("comments")
      .select("*")
      .eq("organization_id", context.organizationId)
      .eq("entity_type", "contact")
      .eq("entity_id", contactId)
      .order("created_at", { ascending: false }),
    context.supabase
      .from("bookings")
      .select("*")
      .eq("organization_id", context.organizationId)
      .eq("contact_id", contactId)
      .order("scheduled_for", { ascending: false }),
    context.supabase
      .from("tasks")
      .select("*")
      .eq("organization_id", context.organizationId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false }),
  ]);

  if (commentsResult.error) {
    throw commentsResult.error;
  }

  if (bookingsResult.error) {
    throw bookingsResult.error;
  }

  if (tasksResult.error) {
    throw tasksResult.error;
  }

  const eventIds = eventsResult.map((event) => event.id);
  const workflowRunsResult = eventIds.length
    ? await context.supabase
        .from("workflow_runs")
        .select("*")
        .eq("organization_id", context.organizationId)
        .in("trigger_event_id", eventIds)
        .order("created_at", { ascending: false })
    : { data: [], error: null };

  if (workflowRunsResult.error) {
    throw workflowRunsResult.error;
  }

  return sortAndLimitTrace(
    [
      ...eventsResult.map((item) => ({
        companyId: item.company_id,
        data: item,
        id: item.id,
        kind: "activity_event" as const,
        occurredAt: item.occurred_at,
      })),
      ...(commentsResult.data ?? []).map((item) => ({
        companyId: item.company_id,
        data: item,
        id: item.id,
        kind: "comment" as const,
        occurredAt: item.created_at,
      })),
      ...(bookingsResult.data ?? []).map((item) => ({
        companyId: item.company_id,
        data: item,
        id: item.id,
        kind: "booking" as const,
        occurredAt: item.scheduled_for,
      })),
      ...(tasksResult.data ?? []).map((item) => ({
        companyId: item.company_id,
        data: item,
        id: item.id,
        kind: "task" as const,
        occurredAt: item.created_at,
      })),
      ...(workflowRunsResult.data ?? []).map((item) => ({
        companyId: item.company_id,
        data: item,
        id: item.id,
        kind: "workflow_run" as const,
        occurredAt: item.created_at,
      })),
    ],
    limit,
  );
}

export async function getBookingTrace(
  context: TenantServiceContext,
  bookingId: string,
  limit?: number,
): Promise<TraceItem[]> {
  await assertBookingInOrganization(context, bookingId);

  const [eventsResult, commentsResult, tasksResult] = await Promise.all([
    listEntityActivityEvents(context, "booking", bookingId),
    context.supabase
      .from("comments")
      .select("*")
      .eq("organization_id", context.organizationId)
      .eq("entity_type", "booking")
      .eq("entity_id", bookingId)
      .order("created_at", { ascending: false }),
    context.supabase
      .from("tasks")
      .select("*")
      .eq("organization_id", context.organizationId)
      .eq("booking_id", bookingId)
      .order("created_at", { ascending: false }),
  ]);

  if (commentsResult.error) {
    throw commentsResult.error;
  }

  if (tasksResult.error) {
    throw tasksResult.error;
  }

  const eventIds = eventsResult.map((event) => event.id);
  const workflowRunsResult = eventIds.length
    ? await context.supabase
        .from("workflow_runs")
        .select("*")
        .eq("organization_id", context.organizationId)
        .in("trigger_event_id", eventIds)
        .order("created_at", { ascending: false })
    : { data: [], error: null };

  if (workflowRunsResult.error) {
    throw workflowRunsResult.error;
  }

  return sortAndLimitTrace(
    [
      ...eventsResult.map((item) => ({
        companyId: item.company_id,
        data: item,
        id: item.id,
        kind: "activity_event" as const,
        occurredAt: item.occurred_at,
      })),
      ...(commentsResult.data ?? []).map((item) => ({
        companyId: item.company_id,
        data: item,
        id: item.id,
        kind: "comment" as const,
        occurredAt: item.created_at,
      })),
      ...(tasksResult.data ?? []).map((item) => ({
        companyId: item.company_id,
        data: item,
        id: item.id,
        kind: "task" as const,
        occurredAt: item.created_at,
      })),
      ...(workflowRunsResult.data ?? []).map((item) => ({
        companyId: item.company_id,
        data: item,
        id: item.id,
        kind: "workflow_run" as const,
        occurredAt: item.created_at,
      })),
    ],
    limit,
  );
}

export async function getTaskTrace(
  context: TenantServiceContext,
  taskId: string,
  limit?: number,
): Promise<TraceItem[]> {
  await assertTaskInOrganization(context, taskId);

  const [eventsResult, commentsResult] = await Promise.all([
    listEntityActivityEvents(context, "task", taskId),
    context.supabase
      .from("comments")
      .select("*")
      .eq("organization_id", context.organizationId)
      .eq("entity_type", "task")
      .eq("entity_id", taskId)
      .order("created_at", { ascending: false }),
  ]);

  if (commentsResult.error) {
    throw commentsResult.error;
  }

  const eventIds = eventsResult.map((event) => event.id);
  const workflowRunsResult = eventIds.length
    ? await context.supabase
        .from("workflow_runs")
        .select("*")
        .eq("organization_id", context.organizationId)
        .in("trigger_event_id", eventIds)
        .order("created_at", { ascending: false })
    : { data: [], error: null };

  if (workflowRunsResult.error) {
    throw workflowRunsResult.error;
  }

  return sortAndLimitTrace(
    [
      ...eventsResult.map((item) => ({
        companyId: item.company_id,
        data: item,
        id: item.id,
        kind: "activity_event" as const,
        occurredAt: item.occurred_at,
      })),
      ...(commentsResult.data ?? []).map((item) => ({
        companyId: item.company_id,
        data: item,
        id: item.id,
        kind: "comment" as const,
        occurredAt: item.created_at,
      })),
      ...(workflowRunsResult.data ?? []).map((item) => ({
        companyId: item.company_id,
        data: item,
        id: item.id,
        kind: "workflow_run" as const,
        occurredAt: item.created_at,
      })),
    ],
    limit,
  );
}