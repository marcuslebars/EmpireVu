import { z } from "zod";

import type { Tables } from "@/server/db/database.types";
import { AuthorizationError, ValidationError } from "@/server/organizations/context";
import type { TenantServiceContext } from "@/server/services/shared";

export interface OrganizationUserSummary {
  email: string;
  id: string;
  name: string;
  role: Tables<"organization_memberships">["role"];
}

export const updateMemberRoleInputSchema = z.object({
  profileId: z.string().uuid(),
  role: z.enum(["owner", "admin", "member"]),
});

export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleInputSchema>;

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
    : { data: [] as Tables<"profiles">[], error: null };

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

async function countOwners(context: TenantServiceContext): Promise<number> {
  const { count, error } = await context.supabase
    .from("organization_memberships")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", context.organizationId)
    .eq("role", "owner");

  if (error) {
    throw error;
  }

  return count ?? 0;
}

async function loadMembership(
  context: TenantServiceContext,
  profileId: string,
): Promise<Tables<"organization_memberships">> {
  const { data, error } = await context.supabase
    .from("organization_memberships")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("profile_id", profileId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new ValidationError("Member not found.");
  }

  return data;
}

const ROLE_RANK: Record<Tables<"organization_memberships">["role"], number> = { owner: 3, admin: 2, member: 1 };

/**
 * Who may change whose role. Enforced again in the database (trigger
 * organization_memberships_guard, migration 20261006170000) so a direct PostgREST call
 * can't skip it:
 *   • only an owner may grant or remove owner access;
 *   • nobody may raise their own role (an admin can't make themselves owner).
 */
export function assertMayChangeRole(
  actor: { profileId: string | null; role: Tables<"organization_memberships">["role"] },
  target: { profileId: string; from: Tables<"organization_memberships">["role"]; to: Tables<"organization_memberships">["role"] },
): void {
  if ((target.from === "owner" || target.to === "owner") && actor.role !== "owner") {
    throw new AuthorizationError("Only an owner can grant or remove owner access.");
  }
  if (actor.profileId === target.profileId && ROLE_RANK[target.to] > ROLE_RANK[target.from]) {
    throw new AuthorizationError("You can't raise your own role.");
  }
}

export async function updateMemberRole(
  context: TenantServiceContext,
  input: UpdateMemberRoleInput,
  actorRole: Tables<"organization_memberships">["role"],
): Promise<OrganizationUserSummary> {
  const membership = await loadMembership(context, input.profileId);
  assertMayChangeRole(
    { profileId: context.actorProfileId, role: actorRole },
    { profileId: input.profileId, from: membership.role, to: input.role },
  );

  // Never leave an org ownerless by demoting its last owner.
  if (membership.role === "owner" && input.role !== "owner" && (await countOwners(context)) <= 1) {
    throw new ValidationError("An organization must have at least one owner.");
  }

  const { error } = await context.supabase
    .from("organization_memberships")
    .update({ role: input.role })
    .eq("organization_id", context.organizationId)
    .eq("profile_id", input.profileId);

  if (error) {
    throw error;
  }

  const { data: profileData } = await context.supabase
    .from("profiles")
    .select("*")
    .eq("id", input.profileId)
    .maybeSingle();
  const profile = profileData as Tables<"profiles"> | null;

  return {
    email: profile?.email ?? "",
    id: input.profileId,
    name: profile?.full_name?.trim() || profile?.email || "",
    role: input.role,
  };
}

export async function removeMember(
  context: TenantServiceContext,
  profileId: string,
  actorRole: Tables<"organization_memberships">["role"],
): Promise<{ id: string }> {
  const membership = await loadMembership(context, profileId);

  if (membership.role === "owner" && actorRole !== "owner") {
    throw new AuthorizationError("Only an owner can remove an owner.");
  }

  if (membership.role === "owner" && (await countOwners(context)) <= 1) {
    throw new ValidationError("An organization must have at least one owner.");
  }

  const { error } = await context.supabase
    .from("organization_memberships")
    .delete()
    .eq("organization_id", context.organizationId)
    .eq("profile_id", profileId);

  if (error) {
    throw error;
  }

  return { id: profileId };
}
