import { z } from "zod";

import type { Inserts, Json, Tables } from "@/server/db/database.types";
import { slugify } from "@/server/db/helpers";
import { createActivityEvent } from "@/server/services/activity-events";
import {
  assertCompanyInOrganization,
  insertRow,
  type TenantServiceContext,
} from "@/server/services/shared";

export const createWorkflowInputSchema = z.object({
  companyId: z.string().uuid().nullable().optional(),
  definition: z.record(z.string(), z.unknown()).optional(),
  description: z.string().max(5000).nullable().optional(),
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(80).optional(),
  status: z.enum(["draft", "active", "paused", "archived"]).optional(),
  triggerEvent: z.string().min(2).max(120),
});

export type CreateWorkflowInput = z.infer<typeof createWorkflowInputSchema>;

export const updateWorkflowStatusInputSchema = z.object({
  workflowId: z.string().uuid(),
  status: z.enum(["draft", "active", "paused", "archived"]),
});

export type UpdateWorkflowStatusInput = z.infer<typeof updateWorkflowStatusInputSchema>;

export interface ListWorkflowsOptions {
  companyId?: string | null;
  limit?: number;
  status?: Tables<"workflows">["status"] | null;
}

const DEFAULT_WORKFLOW_DEFINITION: Json = {
  edges: [],
  nodes: [],
  version: 1,
};

export async function listWorkflows(
  context: TenantServiceContext,
  options: ListWorkflowsOptions = {},
): Promise<Tables<"workflows">[]> {
  let query = context.supabase
    .from("workflows")
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

export async function getWorkflowById(
  context: TenantServiceContext,
  workflowId: string,
): Promise<Tables<"workflows">> {
  const { data, error } = await context.supabase
    .from("workflows")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("id", workflowId)
    .single();

  if (error) {
    throw error;
  }

  return data;
}

export async function createWorkflow(
  context: TenantServiceContext,
  input: CreateWorkflowInput,
): Promise<Tables<"workflows">> {
  await assertCompanyInOrganization(context, input.companyId);

  const payload = {
    company_id: input.companyId ?? null,
    created_by: context.actorProfileId,
    definition: (input.definition as Json | undefined) ?? DEFAULT_WORKFLOW_DEFINITION,
    description: input.description ?? null,
    name: input.name,
    organization_id: context.organizationId,
    slug: input.slug ? slugify(input.slug) : slugify(input.name),
    trigger_event: input.triggerEvent,
    ...(input.status ? { status: input.status } : {}),
  } satisfies Inserts<"workflows">;

  const data = await insertRow(context, "workflows", payload);

  await createActivityEvent(context, {
    companyId: data.company_id,
    entityId: data.id,
    entityType: "workflow",
    eventType: "workflow.created",
    metadata: {
      triggerEvent: data.trigger_event,
      workflowId: data.id,
    },
  });

  return data;
}

export async function updateWorkflowStatus(
  context: TenantServiceContext,
  input: UpdateWorkflowStatusInput,
): Promise<Tables<"workflows">> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const query = (context.supabase.from("workflows") as any)
    .update({ status: input.status })
    .eq("organization_id", context.organizationId)
    .eq("id", input.workflowId)
    .select("*")
    .single();
  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return data as Tables<"workflows">;
}

export const updateWorkflowInputSchema = z.object({
  workflowId: z.string().uuid(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  triggerEvent: z.string().min(2).max(120).optional(),
  definition: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["draft", "active", "paused", "archived"]).optional(),
});

export type UpdateWorkflowInput = z.infer<typeof updateWorkflowInputSchema>;

export async function updateWorkflow(
  context: TenantServiceContext,
  input: UpdateWorkflowInput,
): Promise<Tables<"workflows">> {
  const updates: Record<string, unknown> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.triggerEvent !== undefined) updates.trigger_event = input.triggerEvent;
  if (input.definition !== undefined) updates.definition = input.definition;
  if (input.status !== undefined) updates.status = input.status;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const query = (context.supabase.from("workflows") as any)
    .update(updates)
    .eq("organization_id", context.organizationId)
    .eq("id", input.workflowId)
    .select("*")
    .single();
  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return data as Tables<"workflows">;
}