import { z } from "zod";

import type { Inserts, Tables } from "@/server/db/database.types";
import { toIsoDate } from "@/server/db/helpers";
import {
  assertCompanyInOrganization,
  insertRow,
  type TenantServiceContext,
} from "@/server/services/shared";

export const createActivityEventInputSchema = z.object({
  companyId: z.string().uuid().nullable().optional(),
  entityId: z.string().uuid().nullable().optional(),
  entityType: z.string().min(2).max(80),
  eventType: z.string().min(2).max(120),
  metadata: z.record(z.string(), z.unknown()).optional(),
  occurredAt: z.union([z.string().datetime(), z.date()]).optional(),
  relatedEntityId: z.string().uuid().nullable().optional(),
  relatedEntityType: z.string().min(2).max(80).nullable().optional(),
});

export type CreateActivityEventInput = z.infer<typeof createActivityEventInputSchema>;

export interface ListActivityEventOptions {
  companyId?: string | null;
  entityId?: string | null;
  entityType?: string | null;
  limit?: number;
  relatedEntityId?: string | null;
  relatedEntityType?: string | null;
}

export async function listActivityEvents(
  context: TenantServiceContext,
  options: ListActivityEventOptions = {},
): Promise<Tables<"activity_events">[]> {
  let query = context.supabase
    .from("activity_events")
    .select("*")
    .eq("organization_id", context.organizationId)
    .order("occurred_at", { ascending: false });

  if (options.companyId) {
    query = query.eq("company_id", options.companyId);
  }

  if (options.entityId) {
    query = query.eq("entity_id", options.entityId);
  }

  if (options.entityType) {
    query = query.eq("entity_type", options.entityType);
  }

  if (options.relatedEntityId) {
    query = query.eq("related_entity_id", options.relatedEntityId);
  }

  if (options.relatedEntityType) {
    query = query.eq("related_entity_type", options.relatedEntityType);
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

export async function createActivityEvent(
  context: TenantServiceContext,
  input: CreateActivityEventInput,
): Promise<Tables<"activity_events">> {
  await assertCompanyInOrganization(context, input.companyId);

  const payload = {
    actor_user_id: context.actorProfileId,
    company_id: input.companyId ?? null,
    entity_id: input.entityId ?? null,
    entity_type: input.entityType,
    event_type: input.eventType,
    metadata_json: (input.metadata ?? {}) as Inserts<"activity_events">["metadata_json"],
    organization_id: context.organizationId,
    related_entity_id: input.relatedEntityId ?? null,
    related_entity_type: input.relatedEntityType ?? null,
    ...(input.occurredAt ? { occurred_at: toIsoDate(input.occurredAt) } : {}),
  } satisfies Inserts<"activity_events">;

  return insertRow(context, "activity_events", payload);
}

export async function getActivityEventById(
  context: TenantServiceContext,
  activityEventId: string,
): Promise<Tables<"activity_events">> {
  const { data, error } = await context.supabase
    .from("activity_events")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("id", activityEventId)
    .single();

  if (error) {
    throw error;
  }

  return data;
}