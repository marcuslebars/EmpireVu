import { z } from "zod";

import type { Inserts, Tables } from "@/server/db/database.types";
import { slugify } from "@/server/db/helpers";
import { createActivityEvent } from "@/server/services/activity-events";
import { insertRow, type TenantServiceContext } from "@/server/services/shared";

export const createCompanyInputSchema = z.object({
  name: z.string().min(1).max(200),
  notes: z.string().max(5000).nullable().optional(),
  slug: z.string().min(1).max(80).optional(),
  stage: z.enum(["prospect", "active", "paused", "archived"]).optional(),
  website: z.string().url().max(300).nullable().optional(),
});

export type CreateCompanyInput = z.infer<typeof createCompanyInputSchema>;

export interface ListCompaniesOptions {
  limit?: number;
  stage?: Tables<"companies">["stage"] | null;
}

export async function listCompanies(
  context: TenantServiceContext,
  options: ListCompaniesOptions = {},
): Promise<Tables<"companies">[]> {
  let query = context.supabase
    .from("companies")
    .select("*")
    .eq("organization_id", context.organizationId)
    .order("created_at", { ascending: false });

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

export async function createCompany(
  context: TenantServiceContext,
  input: CreateCompanyInput,
): Promise<Tables<"companies">> {
  const payload = {
    created_by: context.actorProfileId,
    name: input.name,
    notes: input.notes ?? null,
    organization_id: context.organizationId,
    slug: input.slug ? slugify(input.slug) : slugify(input.name),
    website: input.website ?? null,
    ...(input.stage ? { stage: input.stage } : {}),
  } satisfies Inserts<"companies">;

  const data = await insertRow(context, "companies", payload);

  await createActivityEvent(context, {
    companyId: data.id,
    entityId: data.id,
    entityType: "company",
    eventType: "company.created",
    metadata: {
      companyId: data.id,
      stage: data.stage,
    },
  });

  return data;
}