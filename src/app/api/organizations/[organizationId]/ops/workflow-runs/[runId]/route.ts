import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { type TenantServiceContext } from "@/server/services/shared";
import { createSupabaseServerClient } from "@/server/supabase/server";
import type { Tables } from "@/server/db/database.types";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
    runId: string;
  };
}

interface WorkflowRunLogEntry {
  actionType?: string;
  at: string;
  details?: Record<string, unknown>;
  level: "debug" | "error" | "info" | "warn";
  message: string;
}

interface EnrichedWorkflowRunDetail {
  id: string;
  workflowId: string;
  workflowName: string | null;
  companyId: string | null;
  companyName: string | null;
  status: Tables<"workflow_runs">["status"];
  startedAt: string | null;
  completedAt: string | null;
  actionsExecutedCount: number;
  createdTasksCount: number;
  timeSavedSeconds: number;
  failureReason: string | null;
  createdAt: string;
  triggerEventId: string | null;
  logs: WorkflowRunLogEntry[];
}

async function getWorkflowRunDetail(
  context: TenantServiceContext,
  runId: string,
): Promise<EnrichedWorkflowRunDetail> {
  const { data: run, error: runError } = await context.supabase
    .from("workflow_runs")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("id", runId)
    .single();

  if (runError) {
    throw runError;
  }

  if (!run) {
    throw new Error("Workflow run not found");
  }

  const typedRun = run as Tables<"workflow_runs">;

  const [{ data: workflow }, { data: company }] = await Promise.all([
    typedRun.workflow_id
      ? context.supabase.from("workflows").select("id, name").eq("id", typedRun.workflow_id).single()
      : { data: null },
    typedRun.company_id
      ? context.supabase.from("companies").select("id, name").eq("id", typedRun.company_id).single()
      : { data: null },
  ]);

  const rawLogs = typedRun.logs_json;
  let logs: WorkflowRunLogEntry[] = [];
  if (Array.isArray(rawLogs)) {
    logs = rawLogs.map((entry): WorkflowRunLogEntry => {
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
        return {
          actionType: (entry as Record<string, unknown>).actionType as string | undefined,
          at: (entry as Record<string, unknown>).at as string,
          details: (entry as Record<string, unknown>).details as Record<string, unknown> | undefined,
          level: (entry as Record<string, unknown>).level as "debug" | "error" | "info" | "warn",
          message: (entry as Record<string, unknown>).message as string,
        };
      }
      return {
        at: new Date().toISOString(),
        level: "info",
        message: String(entry),
      };
    });
  }

  return {
    id: typedRun.id,
    workflowId: typedRun.workflow_id,
    workflowName: workflow?.name ?? null,
    companyId: typedRun.company_id,
    companyName: company?.name ?? null,
    status: typedRun.status,
    startedAt: typedRun.started_at,
    completedAt: typedRun.completed_at,
    actionsExecutedCount: typedRun.actions_executed_count,
    createdTasksCount: typedRun.created_tasks_count,
    timeSavedSeconds: typedRun.time_saved_seconds,
    failureReason: typedRun.failure_reason,
    createdAt: typedRun.created_at,
    triggerEventId: typedRun.trigger_event_id,
    logs,
  };
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);

    const run = await getWorkflowRunDetail(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      context.params.runId,
    );

    return NextResponse.json({ data: run });
  });
}
