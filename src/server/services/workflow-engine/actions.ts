import type { Json, Tables } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";
import { toIsoDate } from "@/server/db/helpers";
import { createActivityEvent } from "@/server/services/activity-events";
import { updateBookingStatus } from "@/server/services/bookings";
import { assignContactOwner, updateContactStage } from "@/server/services/contacts";
import type { TenantServiceContext } from "@/server/services/shared";
import { assignTaskUser, createTask, updateTaskStatus } from "@/server/services/tasks";
import { createDraftForContact } from "@/server/services/ai-drafts";
import type {
  WorkflowAction,
  WorkflowEventContext,
  WorkflowProjectionAction,
} from "@/server/services/workflow-engine/types";

export interface ExecuteWorkflowActionsOptions {
  dryRun: boolean;
  workflow: Tables<"workflows">;
}

export interface ExecuteWorkflowActionsResult {
  actionsExecutedCount: number;
  createdTasksCount: number;
  projectedActions: WorkflowProjectionAction[];
  timeSavedSeconds: number;
}

function interpolateString(template: string, context: WorkflowEventContext): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, fieldName) => {
    const value = context.fields[fieldName];

    if (value === null || value === undefined) {
      return "";
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }

    return JSON.stringify(value);
  });
}

function resolveJsonValue(value: Json, context: WorkflowEventContext): Json {
  if (typeof value === "string") {
    return interpolateString(value, context);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveJsonValue(entry, context));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveJsonValue(entry, context)]),
    ) as Json;
  }

  return value;
}

function resolveString(value: string | undefined, context: WorkflowEventContext): string | undefined {
  return value ? interpolateString(value, context) : undefined;
}

function resolveContextString(value: Json): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function resolveTargetEntityId(
  explicitId: string | undefined,
  fallbackId: string | null,
  context: WorkflowEventContext,
): string {
  return resolveString(explicitId, context) ?? fallbackId ?? "";
}

export async function executeWorkflowActions(
  context: TenantServiceContext,
  eventContext: WorkflowEventContext,
  actions: WorkflowAction[],
  options: ExecuteWorkflowActionsOptions,
): Promise<ExecuteWorkflowActionsResult> {
  let actionsExecutedCount = 0;
  let createdTasksCount = 0;
  let timeSavedSeconds = 0;
  const projectedActions: WorkflowProjectionAction[] = [];

  for (const action of actions) {
    switch (action.type) {
      case "create_task": {
        const resolvedPayload = {
          assigned_user_id:
            resolveString(action.assigned_user_id, eventContext) ??
            resolveContextString(eventContext.fields.assigned_user_id),
          booking_id:
            resolveString(action.booking_id, eventContext) ??
            resolveContextString(eventContext.fields.booking_id),
          company_id:
            resolveString(action.company_id, eventContext) ?? eventContext.companyId,
          contact_id:
            resolveString(action.contact_id, eventContext) ??
            resolveContextString(eventContext.fields.contact_id),
          description: resolveString(action.description, eventContext) ?? null,
          due_at:
            typeof action.due_in_hours === "number"
              ? toIsoDate(new Date(Date.now() + action.due_in_hours * 60 * 60 * 1000))
              : typeof action.due_in_days === "number"
                ? toIsoDate(new Date(Date.now() + action.due_in_days * 24 * 60 * 60 * 1000))
                : null,
          priority: action.priority ?? null,
          status: action.status ?? null,
          title: interpolateString(action.title, eventContext),
          workflow_id: options.workflow.id,
        } satisfies Json;

        projectedActions.push({ action, resolvedPayload });

        if (!options.dryRun) {
          await createTask(
            context,
            {
              assignedToProfileId: resolvedPayload.assigned_user_id as string | null,
              bookingId: resolvedPayload.booking_id as string | null,
              companyId: resolvedPayload.company_id as string | null,
              contactId: resolvedPayload.contact_id as string | null,
              description: resolvedPayload.description as string | null,
              dueAt: resolvedPayload.due_at as string | null,
              priority: (resolvedPayload.priority as Tables<"tasks">["priority"] | null) ?? undefined,
              status: (resolvedPayload.status as Tables<"tasks">["status"] | null) ?? undefined,
              title: resolvedPayload.title as string,
              workflowId: options.workflow.id,
            },
            { dispatchWorkflow: false },
          );
        }

        actionsExecutedCount += 1;
        createdTasksCount += 1;
        timeSavedSeconds += action.time_saved_seconds ?? 0;
        break;
      }
      case "ai_analyze": {
        const contactId =
          resolveString(action.contact_id, eventContext) ??
          resolveContextString(eventContext.fields.contact_id) ??
          (eventContext.entityType === "contact" ? eventContext.entityId : null);

        if (!contactId) {
          throw new ValidationError("ai_analyze requires a contact to analyze.");
        }

        projectedActions.push({ action, resolvedPayload: { contact_id: contactId } });

        if (!options.dryRun) {
          const { analysis } = await createDraftForContact(context, contactId, {
            workflowId: options.workflow.id,
          });

          if (action.create_review_task !== false) {
            // The drafted email/SMS deliberately aren't copied in here: the draft is
            // editable, so duplicated text would go stale the moment it's edited.
            // The task points at the draft; the draft stays the single source.
            const description = [
              analysis.summary,
              "",
              `Suggested stage: ${analysis.suggestedStage} · Fit ${Math.round(analysis.fitScore)}/100 · ${analysis.urgency} urgency`,
              "",
              analysis.proposedSlots.length > 0
                ? `A drafted email and SMS plus ${analysis.proposedSlots.length} proposed booking time(s) are ready on this contact's AI tab — review, edit, and send from there.`
                : "A drafted email and SMS are ready on this contact's AI tab — review, edit, and send from there.",
            ].join("\n");

            await createTask(
              context,
              {
                companyId: eventContext.companyId,
                contactId,
                description,
                priority:
                  analysis.urgency === "high"
                    ? "high"
                    : analysis.urgency === "medium"
                      ? "medium"
                      : "low",
                title: "Review AI-drafted reply",
                workflowId: options.workflow.id,
              },
              { dispatchWorkflow: false },
            );
            createdTasksCount += 1;
          }
        }

        actionsExecutedCount += 1;
        timeSavedSeconds += action.time_saved_seconds ?? 0;
        break;
      }
      case "assign_user": {
        const targetEntity =
          action.target_entity ??
          (eventContext.entityType === "task" || eventContext.entityType === "contact"
            ? eventContext.entityType
            : undefined);

        if (!targetEntity) {
          throw new ValidationError("assign_user requires a task or contact target.");
        }

        const resolvedPayload = {
          target_entity: targetEntity,
          target_entity_id: resolveTargetEntityId(action.target_entity_id, eventContext.entityId, eventContext),
          user_id:
            resolveString(action.user_id, eventContext) ??
            resolveContextString(eventContext.fields.assigned_user_id) ??
            "",
        } satisfies Json;

        if (!resolvedPayload.target_entity_id || !resolvedPayload.user_id) {
          throw new ValidationError("assign_user requires target_entity_id and user_id.");
        }

        projectedActions.push({ action, resolvedPayload });

        if (!options.dryRun) {
          if (targetEntity === "task") {
            await assignTaskUser(
              context,
              {
                assignedToProfileId: resolvedPayload.user_id as string,
                taskId: resolvedPayload.target_entity_id as string,
              },
              { dispatchWorkflow: false },
            );
          } else {
            await assignContactOwner(
              context,
              {
                contactId: resolvedPayload.target_entity_id as string,
                ownerProfileId: resolvedPayload.user_id as string,
              },
              { dispatchWorkflow: false },
            );
          }
        }

        actionsExecutedCount += 1;
        timeSavedSeconds += action.time_saved_seconds ?? 0;
        break;
      }
      case "update_status": {
        const targetEntity =
          action.target_entity ??
          (eventContext.entityType === "booking" || eventContext.entityType === "contact" || eventContext.entityType === "task"
            ? eventContext.entityType
            : undefined);

        if (!targetEntity) {
          throw new ValidationError("update_status requires a contact, booking, or task target.");
        }

        const resolvedPayload = {
          status: interpolateString(action.status, eventContext),
          target_entity: targetEntity,
          target_entity_id: resolveTargetEntityId(action.target_entity_id, eventContext.entityId, eventContext),
        } satisfies Json;

        if (!resolvedPayload.target_entity_id) {
          throw new ValidationError("update_status requires target_entity_id.");
        }

        projectedActions.push({ action, resolvedPayload });

        if (!options.dryRun) {
          if (targetEntity === "task") {
            await updateTaskStatus(
              context,
              {
                status: resolvedPayload.status as Tables<"tasks">["status"],
                taskId: resolvedPayload.target_entity_id as string,
              },
              { dispatchWorkflow: false },
            );
          } else if (targetEntity === "booking") {
            await updateBookingStatus(
              context,
              {
                bookingId: resolvedPayload.target_entity_id as string,
                status: resolvedPayload.status as Tables<"bookings">["status"],
              },
              { dispatchWorkflow: false },
            );
          } else {
            await updateContactStage(
              context,
              {
                contactId: resolvedPayload.target_entity_id as string,
                stage: resolvedPayload.status as Tables<"contacts">["stage"],
              },
              { dispatchWorkflow: false },
            );
          }
        }

        actionsExecutedCount += 1;
        timeSavedSeconds += action.time_saved_seconds ?? 0;
        break;
      }
      case "create_activity_event": {
        const resolvedPayload = {
          entity_id: resolveString(action.entity_id, eventContext) ?? eventContext.entityId,
          entity_type: resolveString(action.entity_type, eventContext) ?? eventContext.entityType,
          event_type: interpolateString(action.event_type, eventContext),
          metadata: resolveJsonValue((action.metadata ?? {}) as Json, eventContext),
          related_entity_id:
            resolveString(action.related_entity_id, eventContext) ?? eventContext.relatedEntityId,
          related_entity_type:
            resolveString(action.related_entity_type, eventContext) ?? eventContext.relatedEntityType,
        } satisfies Json;

        projectedActions.push({ action, resolvedPayload });

        if (!options.dryRun) {
          await createActivityEvent(context, {
            companyId: eventContext.companyId,
            entityId: resolvedPayload.entity_id as string | null,
            entityType: resolvedPayload.entity_type as string,
            eventType: resolvedPayload.event_type as string,
            metadata: (resolvedPayload.metadata as Record<string, Json>) ?? {},
            relatedEntityId: resolvedPayload.related_entity_id as string | null,
            relatedEntityType: resolvedPayload.related_entity_type as string | null,
          });
        }

        actionsExecutedCount += 1;
        timeSavedSeconds += action.time_saved_seconds ?? 0;
        break;
      }
    }
  }

  return {
    actionsExecutedCount,
    createdTasksCount,
    projectedActions,
    timeSavedSeconds,
  };
}