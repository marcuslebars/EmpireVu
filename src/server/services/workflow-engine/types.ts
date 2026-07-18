import type { Json, Tables } from "@/server/db/database.types";

export const supportedWorkflowTriggerEventTypes = [
  "booking.created",
  "booking.completed",
  "contact.created",
  "contact.stage_changed",
  "task.completed",
] as const;

export type SupportedWorkflowTriggerEventType =
  (typeof supportedWorkflowTriggerEventTypes)[number];

export type WorkflowConditionOperator =
  | "changed_to"
  | "equals"
  | "exists"
  | "greater_than"
  | "in"
  | "less_than";

export interface WorkflowCondition {
  field: string;
  operator: WorkflowConditionOperator;
  value?: Json;
}

export interface WorkflowCreateTaskAction {
  assigned_user_id?: string;
  booking_id?: string;
  company_id?: string;
  contact_id?: string;
  description?: string;
  due_in_days?: number;
  due_in_hours?: number;
  priority?: Tables<"tasks">["priority"];
  status?: Tables<"tasks">["status"];
  time_saved_seconds?: number;
  title: string;
  type: "create_task";
}

export interface WorkflowAssignUserAction {
  target_entity?: "contact" | "task";
  target_entity_id?: string;
  time_saved_seconds?: number;
  type: "assign_user";
  user_id: string;
}

export interface WorkflowUpdateStatusAction {
  status: string;
  target_entity?: "booking" | "contact" | "task";
  target_entity_id?: string;
  time_saved_seconds?: number;
  type: "update_status";
}

export interface WorkflowCreateActivityEventAction {
  entity_id?: string;
  entity_type?: string;
  event_type: string;
  metadata?: Json;
  related_entity_id?: string;
  related_entity_type?: string;
  time_saved_seconds?: number;
  type: "create_activity_event";
}

export interface WorkflowAiAnalyzeAction {
  contact_id?: string;
  create_review_task?: boolean;
  time_saved_seconds?: number;
  type: "ai_analyze";
}

export interface WorkflowCallLeadAction {
  contact_id?: string;
  time_saved_seconds?: number;
  type: "call_lead";
}

export type WorkflowAction =
  | WorkflowAiAnalyzeAction
  | WorkflowCallLeadAction
  | WorkflowAssignUserAction
  | WorkflowCreateActivityEventAction
  | WorkflowCreateTaskAction
  | WorkflowUpdateStatusAction;

export interface WorkflowDefinition {
  actions: WorkflowAction[];
  conditions: WorkflowCondition[];
  estimated_time_saved_seconds?: number;
  version: number;
}

export interface WorkflowConditionResult {
  actualValue: Json;
  condition: WorkflowCondition;
  matched: boolean;
}

export interface WorkflowProjectionAction {
  action: WorkflowAction;
  resolvedPayload: Json;
}

export interface WorkflowEventContext {
  activityEvent: Tables<"activity_events">;
  companyId: string | null;
  entity: Json;
  entityId: string | null;
  entityType: string;
  fields: Record<string, Json>;
  metadata: Json;
  relatedEntity: Json;
  relatedEntityId: string | null;
  relatedEntityType: string | null;
}

export interface WorkflowExecutionSummary {
  actionsExecutedCount: number;
  conditionResults: WorkflowConditionResult[];
  createdTasksCount: number;
  dryRun: boolean;
  failureReason: string | null;
  logs: Json[];
  matchedConditions: boolean;
  projectedActions: WorkflowProjectionAction[];
  run: Tables<"workflow_runs"> | null;
  skippedReason: string | null;
  timeSavedSeconds: number;
  workflow: Tables<"workflows">;
}