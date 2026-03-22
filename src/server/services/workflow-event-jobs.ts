import { z } from "zod";

import type { Inserts, Tables } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";
import { getActivityEventById } from "@/server/services/activity-events";
import { processActivityEvent } from "@/server/services/workflow-engine/processor";
import {
  assertActivityEventInOrganization,
  assertCompanyInOrganization,
  insertRow,
  type TenantServiceContext,
} from "@/server/services/shared";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";

type AdminSupabaseClient = ReturnType<typeof createSupabaseAdminClient>;

function nowIso(): string {
  return new Date().toISOString();
}

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "23505",
  );
}

export const enqueueWorkflowEventJobInputSchema = z.object({
  activityEventId: z.string().uuid(),
  availableAt: z.string().datetime().optional(),
  maxAttempts: z.number().int().positive().max(20).optional(),
});

export type EnqueueWorkflowEventJobInput = z.infer<typeof enqueueWorkflowEventJobInputSchema>;

export interface ListWorkflowEventJobsOptions {
  companyId?: string | null;
  limit?: number;
  status?: Tables<"workflow_event_jobs">["status"] | null;
}

export async function listWorkflowEventJobs(
  context: TenantServiceContext,
  options: ListWorkflowEventJobsOptions = {},
): Promise<Tables<"workflow_event_jobs">[]> {
  await assertCompanyInOrganization(context, options.companyId);

  let query = context.supabase
    .from("workflow_event_jobs")
    .select("*")
    .eq("organization_id", context.organizationId)
    .order("created_at", { ascending: false });

  if (options.companyId) {
    query = query.eq("company_id", options.companyId);
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

export async function getWorkflowEventJobById(
  context: TenantServiceContext,
  workflowEventJobId: string,
): Promise<Tables<"workflow_event_jobs">> {
  const { data, error } = await context.supabase
    .from("workflow_event_jobs")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("id", workflowEventJobId)
    .single();

  if (error) {
    throw error;
  }

  return data;
}

export async function findWorkflowEventJobByActivityEvent(
  context: TenantServiceContext,
  activityEventId: string,
): Promise<Tables<"workflow_event_jobs"> | null> {
  const { data, error } = await context.supabase
    .from("workflow_event_jobs")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("activity_event_id", activityEventId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ?? null;
}

export async function enqueueWorkflowEventJob(
  context: TenantServiceContext,
  input: EnqueueWorkflowEventJobInput,
): Promise<Tables<"workflow_event_jobs">> {
  await assertActivityEventInOrganization(context, input.activityEventId);

  const existing = await findWorkflowEventJobByActivityEvent(context, input.activityEventId);

  if (existing) {
    return existing;
  }

  const activityEvent = await getActivityEventById(context, input.activityEventId);
  const payload = {
    activity_event_id: activityEvent.id,
    available_at: input.availableAt ?? nowIso(),
    company_id: activityEvent.company_id,
    max_attempts: input.maxAttempts ?? 5,
    organization_id: context.organizationId,
    status: "pending",
  } satisfies Inserts<"workflow_event_jobs">;

  try {
    return await insertRow(context, "workflow_event_jobs", payload);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const duplicate = await findWorkflowEventJobByActivityEvent(context, input.activityEventId);

      if (duplicate) {
        return duplicate;
      }
    }

    throw error;
  }
}

export async function retryWorkflowEventJob(
  context: TenantServiceContext,
  workflowEventJobId: string,
): Promise<Tables<"workflow_event_jobs">> {
  const existing = await getWorkflowEventJobById(context, workflowEventJobId);

  if (existing.status !== "failed") {
    throw new ValidationError("Only failed workflow event jobs can be retried.");
  }

  const { data, error } = await (context.supabase.from("workflow_event_jobs") as any)
    .update({
      available_at: nowIso(),
      completed_at: null,
      last_error: null,
      locked_at: null,
      locked_by: null,
      status: "pending",
    })
    .eq("organization_id", context.organizationId)
    .eq("id", workflowEventJobId)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data as Tables<"workflow_event_jobs">;
}

export interface ClaimWorkflowEventJobsOptions {
  limit?: number;
  staleAfterSeconds?: number;
  workerId: string;
}

export async function claimWorkflowEventJobs(
  supabase: AdminSupabaseClient,
  options: ClaimWorkflowEventJobsOptions,
): Promise<Tables<"workflow_event_jobs">[]> {
  const { data, error } = await ((supabase as any).rpc("claim_workflow_event_jobs", {
    p_limit: options.limit ?? 10,
    p_stale_after_seconds: options.staleAfterSeconds ?? 900,
    p_worker_id: options.workerId,
  }) as Promise<{ data: Tables<"workflow_event_jobs">[] | null; error: { message: string } | null }>);

  if (error) {
    throw error;
  }

  return (data ?? []) as Tables<"workflow_event_jobs">[];
}

export async function completeWorkflowEventJob(
  supabase: AdminSupabaseClient,
  workflowEventJobId: string,
): Promise<Tables<"workflow_event_jobs">> {
  const { data, error } = await (supabase.from("workflow_event_jobs") as any)
    .update({
      completed_at: nowIso(),
      last_error: null,
      locked_at: null,
      locked_by: null,
      status: "completed",
    })
    .eq("id", workflowEventJobId)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data as Tables<"workflow_event_jobs">;
}

export async function failWorkflowEventJob(
  supabase: AdminSupabaseClient,
  workflowEventJobId: string,
  failureReason: string,
): Promise<Tables<"workflow_event_jobs">> {
  const { data, error } = await (supabase.from("workflow_event_jobs") as any)
    .update({
      completed_at: nowIso(),
      last_error: failureReason,
      locked_at: null,
      locked_by: null,
      status: "failed",
    })
    .eq("id", workflowEventJobId)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data as Tables<"workflow_event_jobs">;
}

export async function processWorkflowEventJob(
  supabase: AdminSupabaseClient,
  workflowEventJob: Tables<"workflow_event_jobs">,
): Promise<void> {
  const { data: activityEvent, error } = await supabase
    .from("activity_events")
    .select("*")
    .eq("organization_id", workflowEventJob.organization_id)
    .eq("id", workflowEventJob.activity_event_id)
    .single();

  if (error) {
    await failWorkflowEventJob(supabase, workflowEventJob.id, error.message);
    throw error;
  }

  try {
    const typedActivityEvent = activityEvent as Tables<"activity_events">;

    await processActivityEvent(
      {
        actorProfileId: typedActivityEvent.actor_user_id,
        organizationId: workflowEventJob.organization_id,
        supabase: supabase as unknown as TenantServiceContext["supabase"],
      },
      workflowEventJob.activity_event_id,
    );

    await completeWorkflowEventJob(supabase, workflowEventJob.id);
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : "Workflow event job failed.";

    await failWorkflowEventJob(supabase, workflowEventJob.id, failureReason);
    throw error;
  }
}