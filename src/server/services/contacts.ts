import { z } from "zod";

import type { Inserts, Tables } from "@/server/db/database.types";
import { emitActivityEventAndDispatch } from "@/server/services/workflow-engine/dispatch";
import {
  assertCompanyInOrganization,
  assertContactInOrganization,
  assertProfileInOrganization,
  insertRow,
  type TenantServiceContext,
} from "@/server/services/shared";

export const createContactInputSchema = z.object({
  companyId: z.string().uuid(),
  email: z.string().email().nullable().optional(),
  firstName: z.string().min(1).max(100),
  lastName: z.string().max(100).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().max(3000).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  stage: z.enum(["lead", "qualified", "active", "closed"]).optional(),
});

export type CreateContactInput = z.infer<typeof createContactInputSchema>;

export const updateContactStageInputSchema = z.object({
  contactId: z.string().uuid(),
  stage: z.enum(["lead", "qualified", "active", "closed"]),
});

export type UpdateContactStageInput = z.infer<typeof updateContactStageInputSchema>;

export const assignContactOwnerInputSchema = z.object({
  contactId: z.string().uuid(),
  ownerProfileId: z.string().uuid(),
});

export type AssignContactOwnerInput = z.infer<typeof assignContactOwnerInputSchema>;

interface ContactMutationOptions {
  dispatchWorkflow?: boolean;
}

export interface ListContactsOptions {
  companyId?: string | null;
  limit?: number;
  stage?: Tables<"contacts">["stage"] | null;
}

export async function listContacts(
  context: TenantServiceContext,
  options: ListContactsOptions = {},
): Promise<Tables<"contacts">[]> {
  let query = context.supabase
    .from("contacts")
    .select("*")
    .eq("organization_id", context.organizationId)
    .order("created_at", { ascending: false });

  if (options.companyId) {
    query = query.eq("company_id", options.companyId);
  }

  if (options.stage) {
    query = query.eq("stage", options.stage);
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

export async function createContact(
  context: TenantServiceContext,
  input: CreateContactInput,
  options: ContactMutationOptions = {},
): Promise<Tables<"contacts">> {
  await assertCompanyInOrganization(context, input.companyId);

  const payload = {
    company_id: input.companyId,
    email: input.email ?? null,
    first_name: input.firstName,
    last_name: input.lastName ?? null,
    metadata: (input.metadata ?? {}) as Inserts<"contacts">["metadata"],
    notes: input.notes ?? null,
    organization_id: context.organizationId,
    owner_profile_id: context.actorProfileId,
    phone: input.phone ?? null,
    ...(input.stage ? { stage: input.stage } : {}),
  } satisfies Inserts<"contacts">;

  const data = await insertRow(context, "contacts", payload);

  await emitActivityEventAndDispatch(context, {
    companyId: data.company_id,
    entityId: data.id,
    entityType: "contact",
    eventType: "contact.created",
    metadata: {
      contactId: data.id,
      stage: data.stage,
    },
  }, {
    dispatchAsync: options.dispatchWorkflow !== false,
  });

  return data;
}

export async function getContactById(
  context: TenantServiceContext,
  contactId: string,
): Promise<Tables<"contacts">> {
  await assertContactInOrganization(context, contactId);

  const { data, error } = await context.supabase
    .from("contacts")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("id", contactId)
    .single();

  if (error) {
    throw error;
  }

  return data;
}

export async function updateContactStage(
  context: TenantServiceContext,
  input: UpdateContactStageInput,
  options: ContactMutationOptions = {},
): Promise<Tables<"contacts">> {
  const existing = await getContactById(context, input.contactId);

  if (existing.stage === input.stage) {
    return existing;
  }

  const { data, error } = await (context.supabase.from("contacts") as any)
    .update({ stage: input.stage })
    .eq("organization_id", context.organizationId)
    .eq("id", input.contactId)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  const updated = data as Tables<"contacts">;
  const metadataRecord =
    updated.metadata && typeof updated.metadata === "object" && !Array.isArray(updated.metadata)
      ? (updated.metadata as Record<string, unknown>)
      : {};

  await emitActivityEventAndDispatch(context, {
    companyId: updated.company_id,
    entityId: updated.id,
    entityType: "contact",
    eventType: "contact.stage_changed",
    metadata: {
      contactId: updated.id,
      previousStage: existing.stage,
      stage: updated.stage,
      stage_changed_to: updated.stage,
      value_cents: metadataRecord.value_cents ?? metadataRecord.valueCents ?? null,
    },
  }, {
    dispatchAsync: options.dispatchWorkflow !== false,
  });

  return updated;
}

export async function assignContactOwner(
  context: TenantServiceContext,
  input: AssignContactOwnerInput,
  _options: ContactMutationOptions = {},
): Promise<Tables<"contacts">> {
  await Promise.all([
    assertContactInOrganization(context, input.contactId),
    assertProfileInOrganization(context, input.ownerProfileId),
  ]);

  const { data, error } = await (context.supabase.from("contacts") as any)
    .update({ owner_profile_id: input.ownerProfileId })
    .eq("organization_id", context.organizationId)
    .eq("id", input.contactId)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data as Tables<"contacts">;
}