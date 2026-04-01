import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { getWorkflowEventJobById, isWorkflowEventJobRetryEligible } from "@/server/services/workflow-event-jobs";
import { type TenantServiceContext } from "@/server/services/shared";
import { createSupabaseServerClient } from "@/server/supabase/server";
import type { Tables } from "@/server/db/database.types";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
    jobId: string;
  };
}

interface EnrichedJobDetail {
  id: string;
  activityEventId: string;
  attemptCount: number;
  availableAt: string;
  companyId: string | null;
  companyName: string | null;
  completedAt: string | null;
  createdAt: string;
  lastAttemptedAt: string | null;
  lastError: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
  maxAttempts: number;
  organizationId: string;
  startedAt: string | null;
  status: Tables<"workflow_event_jobs">["status"];
  updatedAt: string;
  activityEventType: string | null;
  retryEligible: boolean;
  remainingAttempts: number;
}

async function getJobDetail(
  context: TenantServiceContext,
  jobId: string,
): Promise<EnrichedJobDetail> {
  const job = await getWorkflowEventJobById(context, jobId);

  const [{ data: activityEvent }, { data: company }] = await Promise.all([
    job.activity_event_id
      ? context.supabase.from("activity_events").select("id, event_type").eq("id", job.activity_event_id).single()
      : { data: null },
    job.company_id
      ? context.supabase.from("companies").select("id, name").eq("id", job.company_id).single()
      : { data: null },
  ]);

  return {
    id: job.id,
    activityEventId: job.activity_event_id,
    attemptCount: job.attempt_count,
    availableAt: job.available_at,
    companyId: job.company_id,
    companyName: company?.name ?? null,
    completedAt: job.completed_at,
    createdAt: job.created_at,
    lastAttemptedAt: job.last_attempted_at,
    lastError: job.last_error,
    lockedAt: job.locked_at,
    lockedBy: job.locked_by,
    maxAttempts: job.max_attempts,
    organizationId: job.organization_id,
    startedAt: job.started_at,
    status: job.status,
    updatedAt: job.updated_at,
    activityEventType: activityEvent?.event_type ?? null,
    retryEligible: isWorkflowEventJobRetryEligible(job),
    remainingAttempts: Math.max(job.max_attempts - job.attempt_count, 0),
  };
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);

    const job = await getJobDetail(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      context.params.jobId,
    );

    return NextResponse.json({ data: job });
  });
}
