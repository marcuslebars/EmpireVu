import type { User } from "@supabase/supabase-js";

import type { Tables } from "@/server/db/database.types";
import type { createSupabaseServerClient } from "@/server/supabase/server";

type AppSupabaseClient = ReturnType<typeof createSupabaseServerClient>;

export class AuthenticationError extends Error {}
export class AuthorizationError extends Error {}
export class ValidationError extends Error {}

export interface OrganizationContext {
  membership: Tables<"organization_memberships">;
  organizationId: string;
  profile: Tables<"profiles"> | null;
  user: User;
}

export async function getAuthenticatedUser(
  supabase: AppSupabaseClient,
): Promise<User> {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    throw new AuthenticationError("Authentication is required.");
  }

  return user;
}

export async function requireOrganizationContext(
  supabase: AppSupabaseClient,
  organizationId: string,
): Promise<OrganizationContext> {
  const user = await getAuthenticatedUser(supabase);

  const { data: membership, error: membershipError } = await supabase
    .from("organization_memberships")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("profile_id", user.id)
    .maybeSingle();

  if (membershipError) {
    throw membershipError;
  }

  if (!membership) {
    throw new AuthorizationError("You do not have access to this organization.");
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    throw profileError;
  }

  return {
    membership,
    organizationId,
    profile,
    user,
  };
}