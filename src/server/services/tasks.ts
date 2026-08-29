import { z } from "zod";

import type { Inserts, Tables } from "@/server/db/database.types";
import { toIsoDate } from "@/server/db/helpers";
import { createActivityEvent } from "@/server/services/activity-events";
import { emitActivityEventAndDispatch } from "@/server/services/workflow-engine/dispatch";
import {
  assertBookingInOrganization,
  assertCompanyInOrganization,
  assertContactInOrganization,
  insertRow,
  assertProfileInOrganization,
  assertTaskInOrganization,
  assertWorkflowInOrganization,
  type TenantServiceContext,
} from "@/server/services/shared";

export const createTaskInputSchema = z.object({
  assignedToProfileId: z.string().uuid().nullable().optional(),
  bookingId: z.string().uuid().nullable().optional(),
  companyId: z.string().uuid().nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
  description: z.string().max(3000).nullable().optional(),
  dueAt: z.union([z.string().datetime(), z.date()]).nullable().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  status: z.enum(["todo", "in_progress", "blocked", "completed"]).optional(),
  title: z.string().min(1).max(200),
  workflowId: z.string().uuid().nullable().optional(),
});

export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export const updateTaskStatusInputSchema = z.object({
  status: z.enum(["todo", "in_progress", "blocked", "completed"]),
  taskId: z.string().uuid(),
});

export type UpdateTaskStatusInput = z.infer<typeof updateTaskStatusInputSchema>;

export const assignTaskUserInputSchema = z.object({
  assignedToProfileId: z.string().uuid(),
  taskId: z.string().uuid(),
});

export type AssignTaskUserInput = z.infer<typeof assignTaskUserInputSchema>;

export const updateTaskInputSchema = z.object({
  description: z.string().max(3000).nullable().optional(),
  dueAt: z.union([z.string().datetime(), z.date()]).nullable().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  taskId: z.string().uuid(),
  title: z.string().min(1).max(200).optional(),
});

export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;

export const deleteTaskInputSchema = z.object({
  taskId: z.string().uuid(),
});

export type DeleteTaskInput = z.infer<typeof deleteTaskInputSchema>;

interface TaskMutationOptions {
  dispatchWorkflow?: boolean;
}

export interface ListTasksOptions {
  assignedToProfileId?: string | null;
  companyId?: string | null;
  limit?: number;
  status?: Tables<"tasks">["status"] | null;
}

export async function listTasks(
  context: TenantServiceContext,
  options: ListTasksOptions = {},
): Promise<Tables<"tasks">[]> {
  let query = context.supabase
    .from("tasks")
    .select("*")
    .eq("organization_id", context.organizationId)
    .order("created_at", { ascending: false });

  if (options.companyId) {
    query = query.eq("company_id", options.companyId);
  }

  if (options.assignedToProfileId) {
    query = query.eq("assigned_to_profile_id", options.assignedToProfileId);
  }

  if (options.status) {
    query = query.eq("status", options.status);
  }

  if (options.limit) {
    query = query.limit(options.limit);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return data ?? [];
}

export async function createTask(
  context: TenantServiceContext,
  input: CreateTaskInput,
  options: TaskMutationOptions = {},
): Promise<Tables<"tasks">> {
  await Promise.all([
    assertCompanyInOrganization(context, input.companyId),
    assertContactInOrganization(context, input.contactId),
    assertBookingInOrganization(context, input.bookingId),
    assertWorkflowInOrganization(context, input.workflowId),
    assertProfileInOrganization(context, input.assignedToProfileId),
  ]);

  const payload = {
    assigned_to_profile_id: input.assignedToProfileId ?? null,
    booking_id: input.bookingId ?? null,
    company_id: input.companyId ?? null,
    contact_id: input.contactId ?? null,
    created_by: context.actorProfileId,
    description: input.description ?? null,
    due_at: input.dueAt ? toIsoDate(input.dueAt) : null,
    organization_id: context.organizationId,
    title: input.title,
    workflow_id: input.workflowId ?? null,
    ...(input.priority ? { priority: input.priority } : {}),
    ...(input.status ? { status: input.status } : {}),
  } satisfies Inserts<"tasks">;

  const data = await insertRow(context, "tasks", payload);

  await emitActivityEventAndDispatch(context, {
    companyId: data.company_id,
    entityId: data.id,
    entityType: "task",
    eventType: "task.created",
    metadata: {
      priority: data.priority,
      status: data.status,
      taskId: data.id,
    },
    relatedEntityId: data.contact_id ?? data.booking_id,
    relatedEntityType: data.contact_id ? "contact" : data.booking_id ? "booking" : null,
  }, {
    dispatchAsync: options.dispatchWorkflow !== false,
  });

  return data;
}

export async function getTaskById(
  context: TenantServiceContext,
  taskId: string,
): Promise<Tables<"tasks">> {
  await assertTaskInOrganization(context, taskId);

  const { data, error } = await context.supabase
    .from("tasks")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("id", taskId)
    .single();

  if (error) {
    throw error;
  }

  return data;
}

export async function updateTaskStatus(
  context: TenantServiceContext,
  input: UpdateTaskStatusInput,
  options: TaskMutationOptions = {},
): Promise<Tables<"tasks">> {
  const existing = await getTaskById(context, input.taskId);

  if (existing.status === input.status) {
    return existing;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const query = (context.supabase.from("tasks") as any)
    .update({ status: input.status })
    .eq("organization_id", context.organizationId)
    .eq("id", input.taskId)
    .select("*")
    .single();
  const { data, error } = await query;

  if (error) {
    throw error;
  }

  const updated = data as Tables<"tasks">;

  await createActivityEvent(context, {
    companyId: updated.company_id,
    entityId: updated.id,
    entityType: "task",
    eventType: "task.status_changed",
    metadata: {
      previousStatus: existing.status,
      priority: updated.priority,
      status: updated.status,
      taskId: updated.id,
    },
    relatedEntityId: updated.contact_id ?? updated.booking_id,
    relatedEntityType: updated.contact_id ? "contact" : updated.booking_id ? "booking" : null,
  });

  if (existing.status !== "completed" && updated.status === "completed") {
    await emitActivityEventAndDispatch(context, {
      companyId: updated.company_id,
      entityId: updated.id,
      entityType: "task",
      eventType: "task.completed",
      metadata: {
        previousStatus: existing.status,
        priority: updated.priority,
        status: updated.status,
        taskId: updated.id,
      },
      relatedEntityId: updated.contact_id ?? updated.booking_id,
      relatedEntityType: updated.contact_id ? "contact" : updated.booking_id ? "booking" : null,
    }, {
      dispatchAsync: options.dispatchWorkflow !== false,
    });
  }

  return updated;
}

export async function assignTaskUser(
  context: TenantServiceContext,
  input: AssignTaskUserInput,
  _options: TaskMutationOptions = {},
): Promise<Tables<"tasks">> {
  const existing = await getTaskById(context, input.taskId);

  if (existing.assigned_to_profile_id === input.assignedToProfileId) {
    return existing;
  }

  await Promise.all([
    assertProfileInOrganization(context, input.assignedToProfileId),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const query = (context.supabase.from("tasks") as any)
    .update({ assigned_to_profile_id: input.assignedToProfileId })
    .eq("organization_id", context.organizationId)
    .eq("id", input.taskId)
    .select("*")
    .single();
  const { data, error } = await query;

  if (error) {
    throw error;
  }

  const updated = data as Tables<"tasks">;

  await createActivityEvent(context, {
    companyId: updated.company_id,
    entityId: updated.id,
    entityType: "task",
    eventType: "task.assignee_assigned",
    metadata: {
      assignedToProfileId: updated.assigned_to_profile_id,
      previousAssignedToProfileId: existing.assigned_to_profile_id,
      taskId: updated.id,
    },
    relatedEntityId: updated.contact_id ?? updated.booking_id,
    relatedEntityType: updated.contact_id ? "contact" : updated.booking_id ? "booking" : null,
  });

  return updated;
}

export async function updateTask(
  context: TenantServiceContext,
  input: UpdateTaskInput,
): Promise<Tables<"tasks">> {
  await getTaskById(context, input.taskId);

  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.dueAt !== undefined) patch.due_at = input.dueAt ? toIsoDate(input.dueAt) : null;

  if (Object.keys(patch).length === 0) {
    return getTaskById(context, input.taskId);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const query = (context.supabase.from("tasks") as any)
    .update(patch)
    .eq("organization_id", context.organizationId)
    .eq("id", input.taskId)
    .select("*")
    .single();
  const { data, error } = await query;

  if (error) {
    throw error;
  }

  const updated = data as Tables<"tasks">;

  await createActivityEvent(context, {
    companyId: updated.company_id,
    entityId: updated.id,
    entityType: "task",
    eventType: "task.updated",
    metadata: {
      fields: Object.keys(patch),
      taskId: updated.id,
    },
    relatedEntityId: updated.contact_id ?? updated.booking_id,
    relatedEntityType: updated.contact_id ? "contact" : updated.booking_id ? "booking" : null,
  });

  return updated;
}

export async function deleteTask(
  context: TenantServiceContext,
  input: DeleteTaskInput,
): Promise<{ id: string }> {
  const existing = await getTaskById(context, input.taskId);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (context.supabase.from("tasks") as any)
    .delete()
    .eq("organization_id", context.organizationId)
    .eq("id", input.taskId);

  if (error) {
    throw error;
  }

  await createActivityEvent(context, {
    companyId: existing.company_id,
    entityId: existing.id,
    entityType: "task",
    eventType: "task.deleted",
    metadata: {
      taskId: existing.id,
      title: existing.title,
    },
    relatedEntityId: existing.contact_id ?? existing.booking_id,
    relatedEntityType: existing.contact_id ? "contact" : existing.booking_id ? "booking" : null,
  });

  return { id: existing.id };
}