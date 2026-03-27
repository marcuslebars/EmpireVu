import type { Tables } from "@/server/db/database.types";
import type { TenantServiceContext } from "@/server/services/shared";

export interface OrganizationUserSummary {
  email: string;
  id: string;
  name: string;
  role: Tables<"organization_memberships">["role"];
}

export async function listOrganizationUsers(
  context: TenantServiceContext,
): Promise<OrganizationUserSummary[]> {
  const { data: memberships, error: membershipsError } = await context.supabase
    .from("organization_memberships")
    .select("*")
    .eq("organization_id", context.organizationId)
    .order("joined_at", { ascending: true });

  if (membershipsError) {
    throw membershipsError;
  }

  const profileIds = [...new Set((memberships ?? []).map((membership) => membership.profile_id))];
  const { data: profiles, error: profilesError } = profileIds.length
    ? await context.supabase
        .from("profiles")
        .select("*")
        .in("id", profileIds)
    : { data: [], error: null };

  if (profilesError) {
    throw profilesError;
  }

  const profilesMap = new Map((profiles ?? []).map((profile) => [profile.id, profile]));

  return (memberships ?? [])
    .map((membership) => {
      const profile = profilesMap.get(membership.profile_id);

      if (!profile) {
        return null;
      }

      return {
        email: profile.email,
        id: profile.id,
        name: profile.full_name?.trim() || profile.email,
        role: membership.role,
      } satisfies OrganizationUserSummary;
    })
    .filter((user): user is OrganizationUserSummary => Boolean(user))
    .sort((left, right) => left.name.localeCompare(right.name));
}
