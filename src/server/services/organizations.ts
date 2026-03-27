import { z } from "zod";

import type { Tables } from "@/server/db/database.types";
import { slugify } from "@/server/db/helpers";
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

  const { data: organization, error: organizationError } = await (supabase.from("organizations") as any)
    .insert({
      created_by: userId,
      name: input.name,
      slug: organizationSlug,
    })
    .select("*")
    .single();

  if (organizationError) {
    throw organizationError;
  }

  if (!organization) {
    throw new Error("Organization creation failed.");
  }

  const { error: membershipError } = await (supabase.from("organization_memberships") as any)
    .insert({
      organization_id: organization.id,
      profile_id: profileId,
      role: "owner",
    });

  if (membershipError) {
    throw membershipError;
  }

  const orgId = (organization as any).id as string;

  const { error: profileError } = await (supabase.from("profiles") as any)
    .update({ default_organization_id: orgId })
    .eq("id", profileId);

  if (profileError) {
    console.error("Failed to set default organization:", profileError);
  }

  return organization as Tables<"organizations">;
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
