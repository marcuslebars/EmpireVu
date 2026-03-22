import { z } from "zod";

import type { Inserts, Tables } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";
import { createActivityEvent } from "@/server/services/activity-events";
import {
  resolveCommentTargetCompany,
  type CommentEntityType,
  insertRow,
  type TenantServiceContext,
} from "@/server/services/shared";

export const createCommentInputSchema = z.object({
  body: z.string().min(1).max(5000),
  companyId: z.string().uuid().nullable().optional(),
  entityId: z.string().uuid(),
  entityType: z.enum(["company", "contact", "booking", "task", "workflow", "workflow_run", "activity_event"]),
});

export type CreateCommentInput = z.infer<typeof createCommentInputSchema>;

export interface ListCommentsOptions {
  companyId?: string | null;
  entityId?: string | null;
  entityType?: CommentEntityType | null;
  limit?: number;
}

export async function listComments(
  context: TenantServiceContext,
  options: ListCommentsOptions = {},
): Promise<Tables<"comments">[]> {
  let query = context.supabase
    .from("comments")
    .select("*")
    .eq("organization_id", context.organizationId)
    .order("created_at", { ascending: false });

  if (options.companyId) {
    query = query.eq("company_id", options.companyId);
  }

  if (options.entityType) {
    query = query.eq("entity_type", options.entityType);
  }

  if (options.entityId) {
    query = query.eq("entity_id", options.entityId);
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

export async function createComment(
  context: TenantServiceContext,
  input: CreateCommentInput,
): Promise<Tables<"comments">> {
  const targetCompanyId = await resolveCommentTargetCompany(
    context,
    input.entityType,
    input.entityId,
  );

  if (input.companyId && targetCompanyId && input.companyId !== targetCompanyId) {
    throw new ValidationError("Comment companyId must match the target entity company.");
  }

  const payload = {
    author_profile_id: context.actorProfileId,
    body: input.body,
    company_id: input.companyId ?? targetCompanyId ?? null,
    entity_id: input.entityId,
    entity_type: input.entityType,
    organization_id: context.organizationId,
  } satisfies Inserts<"comments">;

  const data = await insertRow(context, "comments", payload);

  await createActivityEvent(context, {
    companyId: data.company_id,
    entityId: data.id,
    entityType: "comment",
    eventType: "comment.created",
    metadata: {
      commentId: data.id,
      entityId: data.entity_id,
      entityType: data.entity_type,
    },
    relatedEntityId: data.entity_id,
    relatedEntityType: data.entity_type,
  });

  return data;
}