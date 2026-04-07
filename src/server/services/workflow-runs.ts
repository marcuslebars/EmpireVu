import type { Inserts, Json, Tables, Updates } from "@/server/db/database.types";
import {
  assertActivityEventInOrganization,
  assertCompanyInOrganization,
  assertWorkflowInOrganization,
  insertRow,
  type TenantServiceContext,
} from "@/server/services/shared";

export interface WorkflowRunLogEntry {
  actionType?: string;
  at: string;
  details?: Json;
  level: "debug" | "error" | "info" | "warn";
  message: string;
}

export interface ListWorkflowRunsOptions {
  companyId?: string | null;
  limit?: number;
  status?: Tables<"workflow_runs">["status"] | null;
  triggerEventId?: string | null;
  workflowId?: string | null;
}

export async function listWorkflowRuns(
  context: TenantServiceContext,
  options: ListWorkflowRunsOptions = {},
): Promise<Tables<"workflow_runs">[]> {
  await Promise.all([
    assertCompanyInOrganization(context, options.companyId),
    assertActivityEventInOrganization(context, options.triggerEventId),
    assertWorkflowInOrganization(context, options.workflowId),
  ]);

  let query = context.supabase
    .from("workflow_runs")
    .select("*")
    .eq("organization_id", context.organizationId)
    .order("created_at", { ascending: false });

  if (options.companyId) {
    query = query.eq("company_id", options.companyId);
  }

  if (options.workflowId) {
    query = query.eq("workflow_id", options.workflowId);
  }

  if (options.triggerEventId) {
    query = query.eq("trigger_event_id", options.triggerEventId);
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

export interface CreateWorkflowRunInput {
  actionsExecutedCount?: number;
  companyId?: string | null;
  completedAt?: string | null;
  contextJson?: Json;
  createdTasksCount?: number;
  failureReason?: string | null;
  logsJson?: Json;
  startedAt?: string | null;
  status?: Tables<"workflow_runs">["status"];
  timeSavedSeconds?: number;
  triggerEventId?: string | null;
  workflowId: string;
}

export async function createWorkflowRun(
  context: TenantServiceContext,
  input: CreateWorkflowRunInput,
): Promise<Tables<"workflow_runs">> {
  await Promise.all([
    assertCompanyInOrganization(context, input.companyId),
    assertActivityEventInOrganization(context, input.triggerEventId),
    assertWorkflowInOrganization(context, input.workflowId),
  ]);

  const payload = {
    actions_executed_count: input.actionsExecutedCount ?? 0,
    company_id: input.companyId ?? null,
    completed_at: input.completedAt ?? null,
    context_json: input.contextJson ?? {},
    created_tasks_count: input.createdTasksCount ?? 0,
    failure_reason: input.failureReason ?? null,
    logs_json: input.logsJson ?? [],
    organization_id: context.organizationId,
    started_at: input.startedAt ?? null,
    status: input.status ?? "pending",
    time_saved_seconds: input.timeSavedSeconds ?? 0,
    trigger_event_id: input.triggerEventId ?? null,
    workflow_id: input.workflowId,
  } satisfies Inserts<"workflow_runs">;

  try {
    return await insertRow(context, "workflow_runs", payload);
  } catch (error) {
    if (
      input.triggerEventId &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "23505"
    ) {
      const existing = await findWorkflowRunByTriggerEvent(context, input.workflowId, input.triggerEventId);

      if (existing) {
        return existing;
      }
    }

    throw error;
  }
}

export async function updateWorkflowRun(
  context: TenantServiceContext,
  workflowRunId: string,
  input: Updates<"workflow_runs">,
): Promise<Tables<"workflow_runs">> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const query = (context.supabase.from("workflow_runs") as any)
    .update(input)
    .eq("organization_id", context.organizationId)
    .eq("id", workflowRunId)
    .select("*")
    .single();
  const { data, error } = await query;

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error("workflow_runs update returned no data.");
  }

  return data as Tables<"workflow_runs">;
}

export async function findWorkflowRunByTriggerEvent(
  context: TenantServiceContext,
  workflowId: string,
  triggerEventId: string,
): Promise<Tables<"workflow_runs"> | null> {
  const { data, error } = await context.supabase
    .from("workflow_runs")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("workflow_id", workflowId)
    .eq("trigger_event_id", triggerEventId)
    .order("created_at", { ascending: false })
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ?? null;
}