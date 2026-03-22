import type { Json, Tables } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";
import { createActivityEvent, getActivityEventById } from "@/server/services/activity-events";
import type { TenantServiceContext } from "@/server/services/shared";
import {
  createWorkflowRun,
  findWorkflowRunByTriggerEvent,
  updateWorkflowRun,
  type WorkflowRunLogEntry,
} from "@/server/services/workflow-runs";
import { getWorkflowById } from "@/server/services/workflows";
import { executeWorkflowActions } from "@/server/services/workflow-engine/actions";
import { evaluateWorkflowConditions } from "@/server/services/workflow-engine/conditions";
import {
  assertSupportedWorkflowTrigger,
  manualWorkflowEventInputSchema,
  type ManualWorkflowEventInput,
  parseWorkflowDefinition,
} from "@/server/services/workflow-engine/definitions";
import { buildWorkflowEventContext } from "@/server/services/workflow-engine/context";
import { matchActiveWorkflows } from "@/server/services/workflow-engine/matcher";
import type { WorkflowConditionResult, WorkflowExecutionSummary } from "@/server/services/workflow-engine/types";

function nowIso(): string {
  return new Date().toISOString();
}

function toLogJson(entry: WorkflowRunLogEntry): Json {
  return entry as unknown as Json;
}

function buildRunContextJson(
  workflow: Tables<"workflows">,
  eventContext: Awaited<ReturnType<typeof buildWorkflowEventContext>>,
  conditionResults: WorkflowConditionResult[],
): Json {
  return {
    activity_event_id: eventContext.activityEvent.id,
    company_id: eventContext.companyId,
    condition_results: conditionResults as unknown as Json,
    entity_id: eventContext.entityId,
    entity_type: eventContext.entityType,
    event_type: eventContext.activityEvent.event_type,
    related_entity_id: eventContext.relatedEntityId,
    related_entity_type: eventContext.relatedEntityType,
    workflow_id: workflow.id,
  } satisfies Json;
}

async function executeWorkflowForEvent(
  context: TenantServiceContext,
  workflow: Tables<"workflows">,
  activityEvent: Tables<"activity_events">,
  dryRun: boolean,
): Promise<WorkflowExecutionSummary> {
  const definition = parseWorkflowDefinition(workflow.definition);
  const eventContext = await buildWorkflowEventContext(context, activityEvent);
  const logs: WorkflowRunLogEntry[] = [
    {
      at: nowIso(),
      details: { event_type: activityEvent.event_type, workflow_id: workflow.id },
      level: "info",
      message: "Workflow execution started.",
    },
  ];

  if (!dryRun) {
    const existingRun = await findWorkflowRunByTriggerEvent(context, workflow.id, activityEvent.id);

    if (existingRun) {
      return {
        actionsExecutedCount: existingRun.actions_executed_count,
        conditionResults: [],
        createdTasksCount: existingRun.created_tasks_count,
        dryRun: false,
        failureReason: null,
        logs: existingRun.logs_json as Json[],
        matchedConditions: true,
        projectedActions: [],
        run: existingRun,
        skippedReason: "duplicate_trigger_event",
        timeSavedSeconds: existingRun.time_saved_seconds,
        workflow,
      };
    }
  }

  const { matched, results } = evaluateWorkflowConditions(definition.conditions, eventContext);

  logs.push({
    at: nowIso(),
    details: {
      matched,
      results: results as unknown as Json,
    },
    level: matched ? "info" : "warn",
    message: matched ? "Workflow conditions matched." : "Workflow conditions did not match.",
  });

  const runContextJson = buildRunContextJson(workflow, eventContext, results);
  let run: Tables<"workflow_runs"> | null = null;

  if (!dryRun) {
    run = await createWorkflowRun(context, {
      companyId: activityEvent.company_id,
      contextJson: runContextJson,
      logsJson: logs.map(toLogJson),
      startedAt: nowIso(),
      status: "running",
      triggerEventId: activityEvent.id,
      workflowId: workflow.id,
    });
  }

  try {
    const actionResult = matched
      ? await executeWorkflowActions(context, eventContext, definition.actions, {
          dryRun,
          workflow,
        })
      : {
          actionsExecutedCount: 0,
          createdTasksCount: 0,
          projectedActions: [],
          timeSavedSeconds: 0,
        };

    if (matched) {
      logs.push({
        actionType: "workflow.actions",
        at: nowIso(),
        details: {
          actions_executed_count: actionResult.actionsExecutedCount,
          created_tasks_count: actionResult.createdTasksCount,
        },
        level: "info",
        message: "Workflow actions executed.",
      });
    }

    const timeSavedSeconds = actionResult.timeSavedSeconds + (definition.estimated_time_saved_seconds ?? 0);

    if (!dryRun && run) {
      run = await updateWorkflowRun(context, run.id, {
        actions_executed_count: actionResult.actionsExecutedCount,
        completed_at: nowIso(),
        context_json: runContextJson,
        created_tasks_count: actionResult.createdTasksCount,
        failure_reason: null,
        logs_json: logs.map(toLogJson),
        status: "completed",
        time_saved_seconds: timeSavedSeconds,
      });

      await createActivityEvent(context, {
        companyId: activityEvent.company_id,
        entityId: workflow.id,
        entityType: "workflow",
        eventType: "workflow.executed",
        metadata: {
          actionsExecutedCount: actionResult.actionsExecutedCount,
          createdTasksCount: actionResult.createdTasksCount,
          triggerEventId: activityEvent.id,
          workflowRunId: run.id,
        },
        relatedEntityId: activityEvent.id,
        relatedEntityType: "activity_event",
      });
    }

    return {
      actionsExecutedCount: actionResult.actionsExecutedCount,
      conditionResults: results,
      createdTasksCount: actionResult.createdTasksCount,
      dryRun,
      failureReason: null,
      logs: logs.map(toLogJson),
      matchedConditions: matched,
      projectedActions: actionResult.projectedActions,
      run,
      skippedReason: matched ? null : "conditions_not_matched",
      timeSavedSeconds,
      workflow,
    };
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : "Workflow execution failed.";

    logs.push({
      at: nowIso(),
      details: { failureReason },
      level: "error",
      message: "Workflow execution failed.",
    });

    if (!dryRun && run) {
      run = await updateWorkflowRun(context, run.id, {
        completed_at: nowIso(),
        failure_reason: failureReason,
        logs_json: logs.map(toLogJson),
        status: "failed",
      });
    }

    return {
      actionsExecutedCount: 0,
      conditionResults: results,
      createdTasksCount: 0,
      dryRun,
      failureReason,
      logs: logs.map(toLogJson),
      matchedConditions: matched,
      projectedActions: [],
      run,
      skippedReason: null,
      timeSavedSeconds: 0,
      workflow,
    };
  }
}

export async function processActivityEvent(
  context: TenantServiceContext,
  activityEventId: string,
): Promise<WorkflowExecutionSummary[]> {
  const activityEvent = await getActivityEventById(context, activityEventId);
  const triggerEventType = assertSupportedWorkflowTrigger(activityEvent.event_type);
  const workflows = await matchActiveWorkflows(context, {
    companyId: activityEvent.company_id,
    triggerEventType,
  });

  const results: WorkflowExecutionSummary[] = [];

  for (const workflow of workflows) {
    results.push(await executeWorkflowForEvent(context, workflow, activityEvent, false));
  }

  return results;
}

async function ensurePersistedEvent(
  context: TenantServiceContext,
  input: ManualWorkflowEventInput,
): Promise<Tables<"activity_events">> {
  return createActivityEvent(context, {
    companyId: input.companyId ?? null,
    entityId: input.entityId ?? null,
    entityType: input.entityType,
    eventType: input.eventType,
    metadata: input.metadata ?? {},
    relatedEntityId: input.relatedEntityId ?? null,
    relatedEntityType: input.relatedEntityType ?? null,
  });
}

function buildSyntheticActivityEvent(
  context: TenantServiceContext,
  input: ManualWorkflowEventInput,
): Tables<"activity_events"> {
  const currentTimestamp = nowIso();

  return {
    actor_user_id: context.actorProfileId,
    company_id: input.companyId ?? null,
    created_at: currentTimestamp,
    entity_id: input.entityId ?? null,
    entity_type: input.entityType,
    event_type: input.eventType,
    id: `dry-run-${Date.now()}`,
    metadata_json: input.metadata ?? {},
    occurred_at: currentTimestamp,
    organization_id: context.organizationId,
    related_entity_id: input.relatedEntityId ?? null,
    related_entity_type: input.relatedEntityType ?? null,
    updated_at: currentTimestamp,
  };
}

export async function runWorkflowTest(
  context: TenantServiceContext,
  workflowId: string,
  input: { dryRun?: boolean; sampleEvent: ManualWorkflowEventInput },
): Promise<WorkflowExecutionSummary> {
  const workflow = await getWorkflowById(context, workflowId);
  const parsedEvent = manualWorkflowEventInputSchema.parse(input.sampleEvent);
  const triggerEventType = assertSupportedWorkflowTrigger(parsedEvent.eventType);

  if (workflow.trigger_event !== triggerEventType) {
    throw new ValidationError("Sample event trigger does not match the workflow trigger_event.");
  }

  const activityEvent = input.dryRun === false
    ? await ensurePersistedEvent(context, parsedEvent)
    : buildSyntheticActivityEvent(context, parsedEvent);

  return executeWorkflowForEvent(context, workflow, activityEvent, input.dryRun !== false);
}

export async function runWorkflowNow(
  context: TenantServiceContext,
  workflowId: string,
  input: { event?: ManualWorkflowEventInput; eventId?: string },
): Promise<WorkflowExecutionSummary> {
  const workflow = await getWorkflowById(context, workflowId);

  const activityEvent = input.eventId
    ? await getActivityEventById(context, input.eventId)
    : input.event
      ? await ensurePersistedEvent(context, manualWorkflowEventInputSchema.parse(input.event))
      : null;

  if (!activityEvent) {
    throw new ValidationError("run-now requires either eventId or event.");
  }

  if (workflow.trigger_event !== activityEvent.event_type) {
    throw new ValidationError("Provided event does not match the workflow trigger_event.");
  }

  return executeWorkflowForEvent(context, workflow, activityEvent, false);
}