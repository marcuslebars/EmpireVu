import type { Json, Tables } from "@/server/db/database.types";
import { fromJson, toJson } from "@/server/db/json";
import { ValidationError } from "@/server/organizations/context";
import { createActivityEvent, getActivityEventById } from "@/server/services/activity-events";
import { notifyWorkflowFailed } from "@/server/services/push/notify";
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
import { PaidActionGuardError } from "@/server/services/workflow-engine/guards";
import { matchActiveWorkflows } from "@/server/services/workflow-engine/matcher";
import type {
  WorkflowCondition,
  WorkflowConditionResult,
  WorkflowExecutionSummary,
} from "@/server/services/workflow-engine/types";

function nowIso(): string {
  return new Date().toISOString();
}

function toLogJson(entry: WorkflowRunLogEntry): Json {
  return toJson(entry);
}

function buildRunContextJson(
  workflow: Tables<"workflows">,
  eventContext: Awaited<ReturnType<typeof buildWorkflowEventContext>>,
  conditionResults: WorkflowConditionResult[],
): Json {
  return {
    activity_event_id: eventContext.activityEvent.id,
    company_id: eventContext.companyId,
    condition_results: toJson(conditionResults),
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
      results: toJson(results),
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
          workflowRunId: run?.id ?? null,
        })
      : {
          actionsExecutedCount: 0,
          createdTasksCount: 0,
          projectedActions: [],
          timeSavedSeconds: 0,
          pause: null,
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

    // A durable wait paused the run — persist where to resume and return (Task 9).
    if (!dryRun && run && actionResult.pause) {
      const pause = actionResult.pause;
      logs.push({
        at: nowIso(),
        details: { resume_at: pause.resumeAt, next_step_index: pause.nextIndex },
        level: "info",
        message: "Workflow paused for a wait.",
      });
      run = await updateWorkflowRun(context, run.id, {
        actions_executed_count: actionResult.actionsExecutedCount,
        context_json: withResumeConditions(runContextJson, pause.resumeConditions),
        created_tasks_count: actionResult.createdTasksCount,
        current_step_index: pause.nextIndex,
        logs_json: logs.map(toLogJson),
        resume_at: pause.resumeAt,
        status: "waiting",
        time_saved_seconds: timeSavedSeconds,
      });
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
        skippedReason: "waiting",
        timeSavedSeconds,
        workflow,
      };
    }

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

    // A paid-action guard refusal is a deliberate policy outcome, not a failure of the
    // engine: record it as the run's failure_reason (guard:cooldown / guard:daily_cap)
    // and log it at warn level so it reads as "blocked", not "crashed", in Automations.
    const isGuardRefusal = error instanceof PaidActionGuardError;

    logs.push({
      at: nowIso(),
      details: { failureReason },
      level: isGuardRefusal ? "warn" : "error",
      message: isGuardRefusal
        ? "Workflow action blocked by abuse guard."
        : "Workflow execution failed.",
    });

    if (!dryRun && run) {
      run = await updateWorkflowRun(context, run.id, {
        completed_at: nowIso(),
        failure_reason: failureReason,
        logs_json: logs.map(toLogJson),
        status: "failed",
      });

      // Guard refusals are policy, not breakage — only real failures page owners.
      if (!isGuardRefusal) {
        void notifyWorkflowFailed({
          organizationId: context.organizationId,
          companyId: activityEvent.company_id,
          workflowName: workflow.name,
          failureReason,
          runId: run.id,
        });
      }
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

async function getLatestEventByType(
  context: TenantServiceContext,
  eventType: string,
): Promise<Tables<"activity_events"> | null> {
  const { data, error } = await context.supabase
    .from("activity_events")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("event_type", eventType)
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data as Tables<"activity_events"> | null) ?? null;
}

export async function runWorkflowNow(
  context: TenantServiceContext,
  workflowId: string,
  input: { event?: ManualWorkflowEventInput; eventId?: string; dryRun?: boolean },
): Promise<WorkflowExecutionSummary> {
  const workflow = await getWorkflowById(context, workflowId);
  const dryRun = input.dryRun === true;

  let activityEvent: Tables<"activity_events"> | null = input.eventId
    ? await getActivityEventById(context, input.eventId)
    : input.event
      // A real (non-dry) run persists the event so its side effects have a ledger anchor;
      // a dry run must never write, so it works off a synthetic in-memory event instead.
      ? dryRun
        ? buildSyntheticActivityEvent(context, manualWorkflowEventInputSchema.parse(input.event))
        : await ensurePersistedEvent(context, manualWorkflowEventInputSchema.parse(input.event))
      : null;

  // Dry-run preview with no explicit event: run against the most recent real event
  // matching this workflow's trigger, so conditions see realistic data. Fall back to a
  // bare synthetic event of the right type when the org has no matching history yet.
  if (!activityEvent && dryRun) {
    activityEvent =
      (await getLatestEventByType(context, workflow.trigger_event)) ??
      buildSyntheticActivityEvent(context, {
        entityType: workflow.trigger_event.split(".")[0] || "manual",
        eventType: assertSupportedWorkflowTrigger(workflow.trigger_event),
      });
  }

  if (!activityEvent) {
    throw new ValidationError("run-now requires either eventId or event.");
  }

  if (workflow.trigger_event !== activityEvent.event_type) {
    throw new ValidationError("Provided event does not match the workflow trigger_event.");
  }

  return executeWorkflowForEvent(context, workflow, activityEvent, dryRun);
}

// ── Durable-wait resume (Task 9) ─────────────────────────────────────────────

function withResumeConditions(runContextJson: Json, conditions: WorkflowCondition[] | null): Json {
  const base =
    runContextJson && typeof runContextJson === "object" && !Array.isArray(runContextJson)
      ? (runContextJson as Record<string, Json>)
      : {};
  return { ...base, _resume_conditions: toJson(conditions ?? []) };
}

function readResumeConditions(contextJson: Json): WorkflowCondition[] {
  const record =
    contextJson && typeof contextJson === "object" && !Array.isArray(contextJson)
      ? (contextJson as Record<string, Json>)
      : {};
  const raw = record._resume_conditions;
  return Array.isArray(raw) ? fromJson<WorkflowCondition[]>(raw) : [];
}

function readLogEntries(logsJson: Json): WorkflowRunLogEntry[] {
  return Array.isArray(logsJson) ? fromJson<WorkflowRunLogEntry[]>(logsJson) : [];
}

/**
 * Resume a run that a `wait` paused. Rebuilds the original event context from the stored
 * trigger event, re-checks resume_conditions (stop the sequence if they no longer hold),
 * then executes from current_step_index — pausing again on the next wait or finishing.
 */
export async function resumeWorkflowRun(
  context: TenantServiceContext,
  run: Tables<"workflow_runs">,
): Promise<void> {
  const logs = readLogEntries(run.logs_json);

  if (!run.trigger_event_id) {
    // No anchor event to rebuild context from — finish rather than loop forever.
    await updateWorkflowRun(context, run.id, { completed_at: nowIso(), resume_at: null, status: "completed" });
    return;
  }

  const workflow = await getWorkflowById(context, run.workflow_id);
  const definition = parseWorkflowDefinition(workflow.definition);
  const activityEvent = await getActivityEventById(context, run.trigger_event_id);
  const eventContext = await buildWorkflowEventContext(context, activityEvent);

  const resumeConditions = readResumeConditions(run.context_json);
  if (resumeConditions.length > 0) {
    const { matched } = evaluateWorkflowConditions(resumeConditions, eventContext);
    if (!matched) {
      logs.push({ at: nowIso(), level: "info", message: "Resume conditions no longer match — sequence stopped." });
      await updateWorkflowRun(context, run.id, {
        completed_at: nowIso(),
        logs_json: logs.map(toLogJson),
        resume_at: null,
        status: "completed",
      });
      return;
    }
  }

  logs.push({
    at: nowIso(),
    details: { from_step_index: run.current_step_index },
    level: "info",
    message: "Workflow resumed.",
  });

  try {
    const actionResult = await executeWorkflowActions(context, eventContext, definition.actions, {
      dryRun: false,
      workflow,
      workflowRunId: run.id,
      startIndex: run.current_step_index,
    });

    if (actionResult.pause) {
      logs.push({
        at: nowIso(),
        details: { next_step_index: actionResult.pause.nextIndex, resume_at: actionResult.pause.resumeAt },
        level: "info",
        message: "Workflow paused for a wait.",
      });
      await updateWorkflowRun(context, run.id, {
        actions_executed_count: run.actions_executed_count + actionResult.actionsExecutedCount,
        context_json: withResumeConditions(run.context_json, actionResult.pause.resumeConditions),
        current_step_index: actionResult.pause.nextIndex,
        logs_json: logs.map(toLogJson),
        resume_at: actionResult.pause.resumeAt,
        status: "waiting",
        time_saved_seconds: run.time_saved_seconds + actionResult.timeSavedSeconds,
      });
      return;
    }

    await updateWorkflowRun(context, run.id, {
      actions_executed_count: run.actions_executed_count + actionResult.actionsExecutedCount,
      completed_at: nowIso(),
      created_tasks_count: run.created_tasks_count + actionResult.createdTasksCount,
      logs_json: logs.map(toLogJson),
      resume_at: null,
      status: "completed",
      time_saved_seconds: run.time_saved_seconds + actionResult.timeSavedSeconds,
    });
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : "Workflow resume failed.";
    const isGuardRefusal = error instanceof PaidActionGuardError;
    logs.push({
      at: nowIso(),
      details: { failureReason },
      level: isGuardRefusal ? "warn" : "error",
      message: isGuardRefusal ? "Workflow action blocked by abuse guard." : "Workflow resume failed.",
    });
    await updateWorkflowRun(context, run.id, {
      completed_at: nowIso(),
      failure_reason: failureReason,
      logs_json: logs.map(toLogJson),
      resume_at: null,
      status: "failed",
    });

    if (!isGuardRefusal) {
      void notifyWorkflowFailed({
        organizationId: context.organizationId,
        companyId: activityEvent.company_id,
        workflowName: workflow.name,
        failureReason,
        runId: run.id,
      });
    }
  }
}