import { z } from "zod";

import type { Json } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";
import type {
  SupportedWorkflowTriggerEventType,
  WorkflowAction,
  WorkflowCondition,
  WorkflowDefinition,
} from "@/server/services/workflow-engine/types";
import { supportedWorkflowTriggerEventTypes } from "@/server/services/workflow-engine/types";

const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonSchema),
    z.record(z.string(), jsonSchema),
  ]),
);

const workflowConditionSchema = z.object({
  field: z.string().min(1).max(100),
  operator: z.enum(["changed_to", "equals", "exists", "greater_than", "in", "less_than"]),
  value: jsonSchema.optional(),
});

const workflowActionSchema = z.discriminatedUnion("type", [
  z.object({
    assigned_user_id: z.string().optional(),
    booking_id: z.string().optional(),
    company_id: z.string().optional(),
    contact_id: z.string().optional(),
    description: z.string().optional(),
    due_in_days: z.number().int().nonnegative().optional(),
    due_in_hours: z.number().int().nonnegative().optional(),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
    status: z.enum(["todo", "in_progress", "blocked", "completed"]).optional(),
    time_saved_seconds: z.number().int().nonnegative().optional(),
    title: z.string().min(1).max(200),
    type: z.literal("create_task"),
  }),
  z.object({
    target_entity: z.enum(["contact", "task"]).optional(),
    target_entity_id: z.string().optional(),
    time_saved_seconds: z.number().int().nonnegative().optional(),
    type: z.literal("assign_user"),
    user_id: z.string().min(1),
  }),
  z.object({
    status: z.string().min(1),
    target_entity: z.enum(["booking", "contact", "task"]).optional(),
    target_entity_id: z.string().optional(),
    time_saved_seconds: z.number().int().nonnegative().optional(),
    type: z.literal("update_status"),
  }),
  z.object({
    entity_id: z.string().optional(),
    entity_type: z.string().optional(),
    event_type: z.string().min(2).max(120),
    metadata: jsonSchema.optional(),
    related_entity_id: z.string().optional(),
    related_entity_type: z.string().optional(),
    time_saved_seconds: z.number().int().nonnegative().optional(),
    type: z.literal("create_activity_event"),
  }),
  z.object({
    contact_id: z.string().optional(),
    create_review_task: z.boolean().optional(),
    time_saved_seconds: z.number().int().nonnegative().optional(),
    type: z.literal("ai_analyze"),
  }),
  z.object({
    contact_id: z.string().optional(),
    time_saved_seconds: z.number().int().nonnegative().optional(),
    type: z.literal("call_lead"),
  }),
]);

const workflowDefinitionSchema = z.object({
  actions: z.array(workflowActionSchema).default([]),
  conditions: z.array(workflowConditionSchema).default([]),
  estimated_time_saved_seconds: z.number().int().nonnegative().optional(),
  version: z.number().int().positive().default(1),
});

export const manualWorkflowEventInputSchema = z.object({
  companyId: z.string().uuid().nullable().optional(),
  entityId: z.string().uuid().nullable().optional(),
  entityType: z.string().min(2).max(80),
  eventType: z.enum(supportedWorkflowTriggerEventTypes),
  metadata: z.record(z.string(), jsonSchema).optional(),
  relatedEntityId: z.string().uuid().nullable().optional(),
  relatedEntityType: z.string().min(2).max(80).nullable().optional(),
});

export type ManualWorkflowEventInput = z.infer<typeof manualWorkflowEventInputSchema>;

export function isSupportedWorkflowTrigger(
  value: string,
): value is SupportedWorkflowTriggerEventType {
  return supportedWorkflowTriggerEventTypes.includes(
    value as SupportedWorkflowTriggerEventType,
  );
}

export function assertSupportedWorkflowTrigger(value: string): SupportedWorkflowTriggerEventType {
  if (!isSupportedWorkflowTrigger(value)) {
    throw new ValidationError(`Unsupported workflow trigger: ${value}`);
  }

  return value;
}

export function parseWorkflowDefinition(definition: Json): WorkflowDefinition {
  const rawDefinition =
    definition && typeof definition === "object" && !Array.isArray(definition)
      ? (definition as Record<string, Json>)
      : {};

  const actionsJson = Array.isArray(rawDefinition.actions_json)
    ? (rawDefinition.actions_json as unknown as WorkflowAction[])
    : undefined;
  const actions = Array.isArray(rawDefinition.actions)
    ? (rawDefinition.actions as unknown as WorkflowAction[])
    : undefined;
  const conditionsJson = Array.isArray(rawDefinition.conditions_json)
    ? (rawDefinition.conditions_json as unknown as WorkflowCondition[])
    : undefined;
  const conditions = Array.isArray(rawDefinition.conditions)
    ? (rawDefinition.conditions as unknown as WorkflowCondition[])
    : undefined;

  const normalized = {
    actions: actionsJson ?? actions ?? [],
    conditions: conditionsJson ?? conditions ?? [],
    estimated_time_saved_seconds:
      typeof rawDefinition.estimated_time_saved_seconds === "number"
        ? rawDefinition.estimated_time_saved_seconds
        : undefined,
    version:
      typeof rawDefinition.version === "number" && Number.isFinite(rawDefinition.version)
        ? rawDefinition.version
        : 1,
  };

  return workflowDefinitionSchema.parse(normalized) as WorkflowDefinition;
}