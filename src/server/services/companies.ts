import { z } from "zod";

import type { Inserts, Json, Tables, Updates } from "@/server/db/database.types";
import { slugify } from "@/server/db/helpers";
import { createActivityEvent } from "@/server/services/activity-events";
import {
  assertCompanyInOrganization,
  insertRow,
  type TenantServiceContext,
} from "@/server/services/shared";
import { installRecipes } from "@/server/services/workflow-engine/recipes/install";

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

  // Every new company gets the proven automations on day one (Task 10). Best-effort:
  // a recipe-install hiccup must never fail company creation. Recipes whose channel
  // isn't configured land as drafts, so this is safe on any deployment.
  try {
    await installRecipes(context, data.id);
  } catch (error) {
    console.error("[companies] recipe install failed for", data.id, error instanceof Error ? error.message : error);
  }

  return data;
}

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Must be a #RRGGBB hex color");
const httpsUrl = z.string().url().startsWith("https://", "Must be an https:// URL").max(500);

// The business-profile fields the onboarding wizard (and settings) can write. Colors +
// logo/website URLs are validated to match the companies check constraints so a bad value
// gets a clean 400 rather than a Postgres error.
export const updateCompanyInputSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  website: z.string().url().max(300).nullable().optional(),
  timezone: z.string().max(80).nullable().optional(),
  hours: z.record(z.string(), z.unknown()).nullable().optional(),
  serviceArea: z.string().max(500).nullable().optional(),
  ownerEmail: z.string().email().max(320).nullable().optional(),
  ownerPhone: z.string().max(40).nullable().optional(),
  brandLogoUrl: httpsUrl.nullable().optional(),
  brandWebsiteUrl: httpsUrl.nullable().optional(),
  brandPrimaryColor: hexColor.nullable().optional(),
  brandAccentColor: hexColor.nullable().optional(),
  brandFromName: z.string().max(200).nullable().optional(),
  brandReplyEmail: z.string().email().max(320).nullable().optional(),
  brandReplyPhone: z.string().max(40).nullable().optional(),
});

export type UpdateCompanyInput = z.infer<typeof updateCompanyInputSchema>;

export async function updateCompany(
  context: TenantServiceContext,
  companyId: string,
  input: UpdateCompanyInput,
): Promise<Tables<"companies">> {
  await assertCompanyInOrganization(context, companyId);

  const updates: Updates<"companies"> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.website !== undefined) updates.website = input.website;
  if (input.timezone !== undefined) updates.timezone = input.timezone;
  if (input.hours !== undefined) updates.hours = (input.hours ?? null) as Json;
  if (input.serviceArea !== undefined) updates.service_area = input.serviceArea;
  if (input.ownerEmail !== undefined) updates.owner_email = input.ownerEmail;
  if (input.ownerPhone !== undefined) updates.owner_phone_e164 = input.ownerPhone;
  if (input.brandLogoUrl !== undefined) updates.brand_logo_url = input.brandLogoUrl;
  if (input.brandWebsiteUrl !== undefined) updates.brand_website_url = input.brandWebsiteUrl;
  if (input.brandPrimaryColor !== undefined) updates.brand_primary_color = input.brandPrimaryColor;
  if (input.brandAccentColor !== undefined) updates.brand_accent_color = input.brandAccentColor;
  if (input.brandFromName !== undefined) updates.brand_from_name = input.brandFromName;
  if (input.brandReplyEmail !== undefined) updates.brand_reply_email = input.brandReplyEmail;
  if (input.brandReplyPhone !== undefined) updates.brand_reply_phone = input.brandReplyPhone;

  const { data, error } = await context.supabase
    .from("companies")
    .update(updates)
    .eq("organization_id", context.organizationId)
    .eq("id", companyId)
    .select("*")
    .single();
  if (error) throw error;
  return data as Tables<"companies">;
}