import type { Json, Tables } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";
import { toIsoDate } from "@/server/db/helpers";
import { createActivityEvent } from "@/server/services/activity-events";
import { updateBookingStatus } from "@/server/services/bookings";
import { assignContactOwner, updateContactStage } from "@/server/services/contacts";
import type { TenantServiceContext } from "@/server/services/shared";
import { assignTaskUser, createTask, updateTaskStatus } from "@/server/services/tasks";
import { createDraftForContact } from "@/server/services/ai-drafts";
import { callContactWithMarina } from "@/server/services/voice";
import { buildMessageTemplateData } from "@/server/services/workflow-engine/context";
import { assertPaidActionAllowed, unauthenticatedSource } from "@/server/services/workflow-engine/guards";
import { renderTemplate, type MessageTemplateData } from "@/server/services/workflow-engine/interpolate";
import {
  deliverMessage,
  resolveOwnerContacts,
  type ConsentContact,
  type OwnerContacts,
} from "@/server/services/workflow-engine/messaging";
import { computeResumeAt } from "@/server/services/workflow-engine/timing";
import type {
  WorkflowAction,
  WorkflowCondition,
  WorkflowEventContext,
  WorkflowProjectionAction,
} from "@/server/services/workflow-engine/types";

export interface ExecuteWorkflowActionsOptions {
  dryRun: boolean;
  workflow: Tables<"workflows">;
  /** The run these actions belong to — stamped on message_log rows (Task 8). */
  workflowRunId?: string | null;
  /** Resume from this action index (Task 9 durable waits); defaults to 0. */
  startIndex?: number;
}

/** A durable wait paused the sequence: where to resume and when. */
export interface WorkflowPause {
  nextIndex: number;
  resumeAt: string;
  resumeConditions: WorkflowCondition[] | null;
}

function asStr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Resolve a messaging action's recipient: the event's contact, the owner, or a literal. */
function resolveMessageRecipient(
  to: string | undefined,
  channel: "sms" | "email",
  data: MessageTemplateData,
  owner: OwnerContacts,
): { to: string | null; contactId: string | null; consentContact: ConsentContact | null } {
  const target = (to ?? "contact").trim();
  if (target === "contact") {
    const contact = data.contact;
    const address = contact ? (channel === "sms" ? asStr(contact.phone) : asStr(contact.email)) : null;
    return {
      to: address,
      contactId: contact ? asStr(contact.id) : null,
      consentContact: contact
        ? {
            sms_opt_out_at: asStr(contact.sms_opt_out_at),
            email_opt_out_at: asStr(contact.email_opt_out_at),
            sms_consent_at: asStr(contact.sms_consent_at),
            consent_source: asStr(contact.consent_source),
          }
        : null,
    };
  }
  if (target === "owner") {
    return { to: channel === "sms" ? owner.phone : owner.email, contactId: null, consentContact: null };
  }
  return { to: target, contactId: null, consentContact: null };
}

export interface ExecuteWorkflowActionsResult {
  actionsExecutedCount: number;
  createdTasksCount: number;
  projectedActions: WorkflowProjectionAction[];
  timeSavedSeconds: number;
  /** Set when a `wait` paused the sequence (real runs only). */
  pause: WorkflowPause | null;
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
      Object.entries(value).map(([key, entry]) => [key, resolveJsonValue(entry ?? null, context)]),
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

  // Loaded once and reused across messaging actions in this run.
  let templateData: MessageTemplateData | null = null;
  const getTemplateData = async (): Promise<MessageTemplateData> => {
    templateData ??= await buildMessageTemplateData(context, eventContext);
    return templateData;
  };
  let ownerContacts: OwnerContacts | null = null;
  const getOwnerContacts = async (): Promise<OwnerContacts> => {
    if (!ownerContacts) {
      const data = await getTemplateData();
      ownerContacts = await resolveOwnerContacts(
        context,
        data.company
          ? { owner_email: asStr(data.company.owner_email), owner_phone_e164: asStr(data.company.owner_phone_e164) }
          : null,
      );
    }
    return ownerContacts;
  };

  let pause: WorkflowPause | null = null;
  for (let index = options.startIndex ?? 0; index < actions.length; index++) {
    const action = actions[index];
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
      case "call_lead": {
        const contactId =
          resolveString(action.contact_id, eventContext) ??
          resolveContextString(eventContext.fields.contact_id) ??
          (eventContext.entityType === "contact" ? eventContext.entityId : null);

        if (!contactId) {
          throw new ValidationError("call_lead requires a contact to call.");
        }

        projectedActions.push({ action, resolvedPayload: { contact_id: contactId } });

        if (!options.dryRun) {
          // Abuse guard for this PAID action: refuse (cooldown / daily cap) when the
          // trigger came from an unauthenticated source; authenticated triggers pass.
          const triggerSource = unauthenticatedSource(eventContext);
          await assertPaidActionAllowed(context, eventContext, action, contactId);
          await callContactWithMarina(context, contactId, { triggerSource });
        }

        actionsExecutedCount += 1;
        timeSavedSeconds += action.time_saved_seconds ?? 0;
        break;
      }
      case "send_sms": {
        const data = await getTemplateData();
        const body = renderTemplate(action.body, data);
        const recipient = resolveMessageRecipient(action.to, "sms", data, await getOwnerContacts());
        projectedActions.push({ action, resolvedPayload: { to: recipient.to ?? action.to ?? "contact", body } });

        if (!options.dryRun) {
          // SMS is a billable outbound action → the Task 5 paid-action guard applies.
          await assertPaidActionAllowed(context, eventContext, action, recipient.contactId);
          await deliverMessage({
            context,
            channel: "sms",
            to: recipient.to,
            body,
            companyId: eventContext.companyId,
            contactId: recipient.contactId,
            consentContact: recipient.consentContact,
            workflowRunId: options.workflowRunId,
          });
        }

        actionsExecutedCount += 1;
        timeSavedSeconds += action.time_saved_seconds ?? 0;
        break;
      }
      case "send_email": {
        const data = await getTemplateData();
        const subject = renderTemplate(action.subject, data);
        const body = renderTemplate(action.body, data);
        const recipient = resolveMessageRecipient(action.to, "email", data, await getOwnerContacts());
        const company = data.company;
        const fromName = action.from_name
          ? renderTemplate(action.from_name, data)
          : asStr(company?.brand_from_name) ?? asStr(company?.name);
        const replyTo = action.reply_to ?? asStr(company?.brand_reply_email);
        projectedActions.push({
          action,
          resolvedPayload: { to: recipient.to ?? action.to ?? "contact", subject, body },
        });

        if (!options.dryRun) {
          await deliverMessage({
            context,
            channel: "email",
            to: recipient.to,
            body,
            subject,
            fromName,
            replyTo,
            companyId: eventContext.companyId,
            contactId: recipient.contactId,
            consentContact: recipient.consentContact,
            workflowRunId: options.workflowRunId,
          });
        }

        actionsExecutedCount += 1;
        timeSavedSeconds += action.time_saved_seconds ?? 0;
        break;
      }
      case "notify_owner": {
        const data = await getTemplateData();
        const owner = await getOwnerContacts();
        const subject = action.subject ? renderTemplate(action.subject, data) : "EmpireVu alert";
        const body = renderTemplate(action.body, data);
        const wantSms = action.channel === "sms" || action.channel === "both";
        const wantEmail = action.channel === "email" || action.channel === "both";
        projectedActions.push({
          action,
          resolvedPayload: { channel: action.channel, subject, body, ownerEmail: owner.email, ownerPhone: owner.phone },
        });

        if (!options.dryRun) {
          if (wantSms) {
            await deliverMessage({
              context,
              channel: "sms",
              to: owner.phone,
              body,
              companyId: eventContext.companyId,
              contactId: null,
              consentContact: null,
              workflowRunId: options.workflowRunId,
            });
          }
          if (wantEmail) {
            await deliverMessage({
              context,
              channel: "email",
              to: owner.email,
              body,
              subject,
              companyId: eventContext.companyId,
              contactId: null,
              consentContact: null,
              workflowRunId: options.workflowRunId,
            });
          }
        }

        actionsExecutedCount += 1;
        timeSavedSeconds += action.time_saved_seconds ?? 0;
        break;
      }
      case "wait": {
        const data = await getTemplateData();
        const resumeAt = computeResumeAt({ duration: action.duration, until: action.until }, data);
        projectedActions.push({
          action,
          resolvedPayload: { resume_at: resumeAt, duration: action.duration ?? null, until: action.until ?? null },
        });
        // A dry-run just previews the resume time; a real run pauses the sequence here.
        if (!options.dryRun) {
          pause = { nextIndex: index + 1, resumeAt, resumeConditions: action.resume_conditions ?? null };
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
    // A durable wait paused the sequence — stop here; the worker resumes later.
    if (pause) break;
  }

  return {
    actionsExecutedCount,
    createdTasksCount,
    projectedActions,
    timeSavedSeconds,
    pause,
  };
}