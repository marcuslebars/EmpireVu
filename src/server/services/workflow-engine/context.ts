import type { Json, Tables } from "@/server/db/database.types";
import type { TenantServiceContext } from "@/server/services/shared";
import type { WorkflowEventContext } from "@/server/services/workflow-engine/types";

type TraceEntityRow =
  | Tables<"activity_events">
  | Tables<"bookings">
  | Tables<"comments">
  | Tables<"companies">
  | Tables<"contacts">
  | Tables<"tasks">
  | Tables<"workflow_runs">
  | Tables<"workflows">;

function asJsonRecord(value: Json | null | undefined): Record<string, Json> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
}

async function getTraceEntityRow(
  context: TenantServiceContext,
  entityType: string | null,
  entityId: string | null,
): Promise<TraceEntityRow | null> {
  if (!entityType || !entityId) {
    return null;
  }

  switch (entityType) {
    case "company": {
      const { data, error } = await context.supabase.from("companies").select("*")
        .eq("organization_id", context.organizationId).eq("id", entityId).maybeSingle();
      if (error) throw error;
      return data;
    }
    case "contact": {
      const { data, error } = await context.supabase.from("contacts").select("*")
        .eq("organization_id", context.organizationId).eq("id", entityId).maybeSingle();
      if (error) throw error;
      return data;
    }
    case "booking": {
      const { data, error } = await context.supabase.from("bookings").select("*")
        .eq("organization_id", context.organizationId).eq("id", entityId).maybeSingle();
      if (error) throw error;
      return data;
    }
    case "task": {
      const { data, error } = await context.supabase.from("tasks").select("*")
        .eq("organization_id", context.organizationId).eq("id", entityId).maybeSingle();
      if (error) throw error;
      return data;
    }
    case "workflow": {
      const { data, error } = await context.supabase.from("workflows").select("*")
        .eq("organization_id", context.organizationId).eq("id", entityId).maybeSingle();
      if (error) throw error;
      return data;
    }
    case "workflow_run": {
      const { data, error } = await context.supabase.from("workflow_runs").select("*")
        .eq("organization_id", context.organizationId).eq("id", entityId).maybeSingle();
      if (error) throw error;
      return data;
    }
    case "activity_event": {
      const { data, error } = await context.supabase.from("activity_events").select("*")
        .eq("organization_id", context.organizationId).eq("id", entityId).maybeSingle();
      if (error) throw error;
      return data;
    }
    default:
      return null;
  }
}

function readAssignedUserId(entityRow: TraceEntityRow | null, metadata: Record<string, Json>): Json {
  if (entityRow && "assigned_to_profile_id" in entityRow) {
    return entityRow.assigned_to_profile_id;
  }

  if (entityRow && "owner_profile_id" in entityRow) {
    return entityRow.owner_profile_id;
  }

  return metadata.assigned_user_id ?? metadata.assignedToProfileId ?? metadata.owner_profile_id ?? null;
}

function readPriority(entityRow: TraceEntityRow | null, metadata: Record<string, Json>): Json {
  if (entityRow && "priority" in entityRow) {
    return entityRow.priority;
  }

  return metadata.priority ?? null;
}

function readStage(entityRow: TraceEntityRow | null, metadata: Record<string, Json>): Json {
  if (entityRow && "stage" in entityRow) {
    return entityRow.stage;
  }

  return metadata.stage ?? metadata.stage_changed_to ?? metadata.to_stage ?? metadata.toStage ?? null;
}

function readValueCents(entityRow: TraceEntityRow | null, metadata: Record<string, Json>): Json {
  if (entityRow && "metadata" in entityRow) {
    const entityMetadata = asJsonRecord(entityRow.metadata);
    return entityMetadata.value_cents ?? entityMetadata.valueCents ?? metadata.value_cents ?? metadata.valueCents ?? null;
  }

  return metadata.value_cents ?? metadata.valueCents ?? null;
}

function readCommonFields(
  activityEvent: Tables<"activity_events">,
  entityRow: TraceEntityRow | null,
  relatedEntityRow: TraceEntityRow | null,
): Record<string, Json> {
  const metadata = asJsonRecord(activityEvent.metadata_json);

  return {
    actor_user_id: activityEvent.actor_user_id,
    assigned_user_id: readAssignedUserId(entityRow, metadata),
    booking_id:
      (entityRow && "scheduled_for" in entityRow ? entityRow.id : null) ??
      metadata.booking_id ??
      metadata.bookingId ??
      (relatedEntityRow && "scheduled_for" in relatedEntityRow ? relatedEntityRow.id : null),
    company_id: activityEvent.company_id,
    contact_id:
      (entityRow && "first_name" in entityRow ? entityRow.id : null) ??
      (entityRow && "contact_id" in entityRow ? entityRow.contact_id : null) ??
      metadata.contact_id ??
      metadata.contactId ??
      (relatedEntityRow && "first_name" in relatedEntityRow ? relatedEntityRow.id : null),
    entity_id: activityEvent.entity_id,
    entity_type: activityEvent.entity_type,
    event_type: activityEvent.event_type,
    previous_stage: metadata.previous_stage ?? metadata.previousStage ?? metadata.from_stage ?? metadata.fromStage ?? null,
    priority: readPriority(entityRow, metadata),
    related_entity_id: activityEvent.related_entity_id,
    related_entity_type: activityEvent.related_entity_type,
    stage: readStage(entityRow, metadata),
    stage_changed_to: metadata.stage_changed_to ?? metadata.to_stage ?? metadata.toStage ?? metadata.stage ?? null,
    status:
      (entityRow && "status" in entityRow ? entityRow.status : null) ?? metadata.status ?? null,
    task_id:
      (entityRow && "priority" in entityRow ? entityRow.id : null) ??
      metadata.task_id ??
      metadata.taskId ??
      (relatedEntityRow && "priority" in relatedEntityRow ? relatedEntityRow.id : null),
    title: (entityRow && "title" in entityRow ? entityRow.title : null) ?? metadata.title ?? null,
    trigger_event_type: activityEvent.event_type,
    value_cents: readValueCents(entityRow, metadata),
  };
}

export async function buildWorkflowEventContext(
  context: TenantServiceContext,
  activityEvent: Tables<"activity_events">,
): Promise<WorkflowEventContext> {
  const [entityRow, relatedEntityRow] = await Promise.all([
    getTraceEntityRow(context, activityEvent.entity_type, activityEvent.entity_id),
    getTraceEntityRow(context, activityEvent.related_entity_type, activityEvent.related_entity_id),
  ]);

  return {
    activityEvent,
    companyId: activityEvent.company_id,
    entity: (entityRow as Json) ?? null,
    entityId: activityEvent.entity_id,
    entityType: activityEvent.entity_type,
    fields: readCommonFields(activityEvent, entityRow, relatedEntityRow),
    metadata: activityEvent.metadata_json,
    relatedEntity: (relatedEntityRow as Json) ?? null,
    relatedEntityId: activityEvent.related_entity_id,
    relatedEntityType: activityEvent.related_entity_type,
  };
}