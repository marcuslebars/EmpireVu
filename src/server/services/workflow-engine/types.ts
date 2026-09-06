import type { Json, Tables } from "@/server/db/database.types";

export const supportedWorkflowTriggerEventTypes = [
  "booking.created",
  "booking.completed",
  "contact.created",
  "contact.stage_changed",
  "task.completed",
  // Task 9 — call / quote / booking / contact events + schedules.
  "call.missed",
  "call.completed",
  "call.urgent",
  "quote.sent",
  "quote.viewed",
  "quote.approved",
  "quote.expiring",
  "booking.upcoming",
  "booking.cancelled",
  "booking.no_show",
  "contact.stale",
  "schedule.daily",
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

/** Messaging actions (Task 8). `to` is "contact" (default), "owner", or a literal
 *  E.164 / email; body/subject are interpolated templates. */
export interface WorkflowSendSmsAction {
  to?: string;
  body: string;
  time_saved_seconds?: number;
  type: "send_sms";
}

export interface WorkflowSendEmailAction {
  to?: string;
  subject: string;
  body: string;
  html?: string;
  from_name?: string;
  reply_to?: string;
  time_saved_seconds?: number;
  type: "send_email";
}

export interface WorkflowNotifyOwnerAction {
  channel: "sms" | "email" | "both";
  subject?: string;
  body: string;
  time_saved_seconds?: number;
  type: "notify_owner";
}

/** A durable delay (Task 9). `resume_conditions` are re-checked on resume; if they no
 *  longer match, the remaining steps are skipped (e.g. "quote still not viewed"). */
export interface WorkflowWaitAction {
  type: "wait";
  duration?: string;
  until?: string;
  resume_conditions?: WorkflowCondition[];
  time_saved_seconds?: number;
}

export type WorkflowAction =
  | WorkflowAiAnalyzeAction
  | WorkflowCallLeadAction
  | WorkflowSendSmsAction
  | WorkflowSendEmailAction
  | WorkflowNotifyOwnerAction
  | WorkflowWaitAction
  | WorkflowAssignUserAction
  | WorkflowCreateActivityEventAction
  | WorkflowCreateTaskAction
  | WorkflowUpdateStatusAction;

/** Time-based config read by the scheduler (Task 9) from the stored definition JSON. */
export interface WorkflowScheduleConfig {
  /** schedule.daily local time, "HH:MM" (default 09:00). */
  daily_time?: string;
  /** booking.upcoming lead time in hours (default 24). */
  hours_before?: number;
  /** contact.stale threshold in days (default 7). */
  stale_days?: number;
}

export interface WorkflowDefinition {
  actions: WorkflowAction[];
  conditions: WorkflowCondition[];
  estimated_time_saved_seconds?: number;
  schedule?: WorkflowScheduleConfig;
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