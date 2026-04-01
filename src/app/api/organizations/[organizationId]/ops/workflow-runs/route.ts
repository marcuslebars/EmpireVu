import { NextResponse } from "next/server";

import { handleRoute, parseLimit } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { type TenantServiceContext } from "@/server/services/shared";
import { createSupabaseServerClient } from "@/server/supabase/server";
import type { Tables } from "@/server/db/database.types";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

interface EnrichedWorkflowRun {
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
}

async function getEnrichedWorkflowRuns(
  context: TenantServiceContext,
  options: {
    companyId?: string | null;
    limit?: number;
    status?: Tables<"workflow_runs">["status"] | null;
    workflowId?: string | null;
  } = {},
): Promise<EnrichedWorkflowRun[]> {
  let query = context.supabase
    .from("workflow_runs")
    .select("*")
    .eq("organization_id", context.organizationId)
    .order("created_at", { ascending: false });

  if (options.companyId) {
    query = query.eq("company_id", options.companyId);
  }

  if (options.status) {
    query = query.eq("status", options.status);
  }

  if (options.workflowId) {
    query = query.eq("workflow_id", options.workflowId);
  }

  if (options.limit) {
    query = query.limit(options.limit);
  }

  const { data: workflowRuns, error: runsError } = await query as { data: Tables<"workflow_runs">[] | null; error: { message: string } | null };

  if (runsError) {
    throw runsError;
  }

  if (!workflowRuns || workflowRuns.length === 0) {
    return [];
  }

  const workflowIds = [...new Set(workflowRuns.map((r) => r.workflow_id))];
  const companyIds = [...new Set(workflowRuns.map((r) => r.company_id).filter(Boolean))];

  const [workflowsResult, companiesResult] = await Promise.all([
    workflowIds.length > 0
      ? context.supabase.from("workflows").select("id, name").in("id", workflowIds)
      : { data: [], error: null },
    companyIds.length > 0
      ? context.supabase.from("companies").select("id, name").in("id", companyIds)
      : { data: [], error: null },
  ]);

  if (workflowsResult.error) {
    throw workflowsResult.error;
  }

  if (companiesResult.error) {
    throw companiesResult.error;
  }

  const workflowMap = new Map((workflowsResult.data ?? []).map((w) => [w.id, w]));
  const companyMap = new Map((companiesResult.data ?? []).map((c) => [c.id, c]));

  return workflowRuns.map((run) => {
    const workflow = workflowMap.get(run.workflow_id);
    const company = companyMap.get(run.company_id ?? "") ?? null;

    return {
      id: run.id,
      workflowId: run.workflow_id,
      workflowName: workflow?.name ?? null,
      companyId: run.company_id,
      companyName: company?.name ?? null,
      status: run.status,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      actionsExecutedCount: run.actions_executed_count,
      createdTasksCount: run.created_tasks_count,
      timeSavedSeconds: run.time_saved_seconds,
      failureReason: run.failure_reason,
      createdAt: run.created_at,
      triggerEventId: run.trigger_event_id,
    };
  });
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const url = new URL(request.url);

    const runs = await getEnrichedWorkflowRuns(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      {
        companyId: url.searchParams.get("companyId"),
        limit: parseLimit(url.searchParams.get("limit")),
        status: url.searchParams.get("status") as Tables<"workflow_runs">["status"] | null,
        workflowId: url.searchParams.get("workflowId"),
      },
    );

    return NextResponse.json({ data: runs });
  });
}
