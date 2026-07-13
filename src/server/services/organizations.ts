import { z } from "zod";

import type { Tables } from "@/server/db/database.types";
import { slugify } from "@/server/db/helpers";
import { ValidationError } from "@/server/organizations/context";
import type { createSupabaseServerClient } from "@/server/supabase/server";

type AppSupabaseClient = ReturnType<typeof createSupabaseServerClient>;

export const createOrganizationInputSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(80).optional(),
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationInputSchema>;

export async function createOrganization(
  supabase: AppSupabaseClient,
  userId: string,
  profileId: string,
  input: CreateOrganizationInput,
): Promise<Tables<"organizations">> {
  const organizationSlug = input.slug ? slugify(input.slug) : slugify(input.name);

  const { data: existingOrg, error: existingError } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", organizationSlug)
    .maybeSingle();

  if (existingError) {
    throw existingError;
  }

  if (existingOrg) {
    throw new Error("An organization with this slug already exists.");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const query = (supabase as any).from("organizations")
    .insert({
      created_by: userId,
      name: input.name,
      slug: organizationSlug,
    })
    .select("*")
    .single();
  const { data: organization, error: organizationError } = await query as { data: Tables<"organizations"> | null; error: { code?: string } | null };

  if (organizationError) {
    // The pre-check above can't see orgs the caller isn't a member of (RLS), so a
    // slug that collides with someone else's org reaches the DB unique constraint.
    // Map that to a friendly 400 instead of a raw 500.
    if (organizationError.code === "23505") {
      throw new ValidationError("An organization with this slug already exists.");
    }
    throw organizationError;
  }

  if (!organization) {
    throw new Error("Organization creation failed.");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const insertQuery = (supabase as any).from("organization_memberships")
    .insert({
      organization_id: organization.id,
      profile_id: profileId,
      role: "owner",
    });
  const { error: membershipError } = await insertQuery as { error: null };

  if (membershipError) {
    throw membershipError;
  }

  const orgId = organization.id;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateQuery = (supabase as any).from("profiles")
    .update({ default_organization_id: orgId })
    .eq("id", profileId);
  const { error: profileError } = await updateQuery as { error: null };

  if (profileError) {
    console.error("Failed to set default organization:", profileError);
  }

  return organization as Tables<"organizations">;
}

export const updateOrganizationInputSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    slug: z.string().min(1).max(80).optional(),
  })
  .refine((value) => value.name !== undefined || value.slug !== undefined, {
    message: "Provide at least one field to update.",
  });

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationInputSchema>;

export async function updateOrganization(
  supabase: AppSupabaseClient,
  organizationId: string,
  input: UpdateOrganizationInput,
): Promise<Tables<"organizations">> {
  const updates: { name?: string; slug?: string } = {};

  if (input.name !== undefined) {
    updates.name = input.name;
  }

  if (input.slug !== undefined) {
    updates.slug = slugify(input.slug);
  }

  if (updates.slug) {
    const { data: existing, error: existingError } = await supabase
      .from("organizations")
      .select("id")
      .eq("slug", updates.slug)
      .neq("id", organizationId)
      .maybeSingle();

    if (existingError) {
      throw existingError;
    }

    if (existing) {
      throw new ValidationError("An organization with this slug already exists.");
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const query = (supabase as any)
    .from("organizations")
    .update(updates)
    .eq("id", organizationId)
    .select("*")
    .single();
  const { data, error } = (await query) as {
    data: Tables<"organizations"> | null;
    error: { code?: string } | null;
  };

  if (error) {
    // Map the DB unique-constraint collision (against orgs the caller can't see
    // under RLS) to a friendly 400 instead of a raw 500.
    if (error.code === "23505") {
      throw new ValidationError("An organization with this slug already exists.");
    }
    throw error;
  }

  if (!data) {
    throw new Error("Organization update failed.");
  }

  return data as Tables<"organizations">;
}

export async function listUserOrganizations(
  supabase: AppSupabaseClient,
  userId: string,
): Promise<Tables<"organizations">[]> {
  const { data: memberships, error: membershipsError } = await supabase
    .from("organization_memberships")
    .select("organization_id")
    .eq("profile_id", userId);

  if (membershipsError) {
    throw membershipsError;
  }

  if (!memberships || memberships.length === 0) {
    return [];
  }

  const organizationIds = (memberships as Array<{ organization_id: string }>).map((m) => m.organization_id);

  const { data: organizations, error: organizationsError } = await supabase
    .from("organizations")
    .select("*")
    .in("id", organizationIds)
    .order("created_at", { ascending: true });

  if (organizationsError) {
    throw organizationsError;
  }

  return (organizations ?? []) as Tables<"organizations">[];
}
