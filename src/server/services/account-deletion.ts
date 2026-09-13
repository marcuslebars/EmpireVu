import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";

/**
 * Self-service account deletion (App Store Review Guideline 5.1.1(v), Google Play account
 * deletion policy).
 *
 * Deleting the auth user cascades to the profile and every membership. Organizations are
 * not owned by a user row, so two cases need a decision first:
 *  - the user is the only owner of an organization that still has other members → refuse
 *    until ownership is transferred, so a team is never left without an owner;
 *  - the user is the organization's only member → its data would be orphaned, so it is
 *    deleted too, but only when the request explicitly confirms that.
 */
type Admin = SupabaseClient<Database>;

export const deleteAccountSchema = z.object({
  confirm: z.literal("DELETE"),
  deleteSoleOrganizations: z.boolean().optional(),
});

export class AccountDeletionBlocked extends ValidationError {
  constructor(
    message: string,
    public readonly code: "transfer_ownership" | "confirm_sole_organizations",
    public readonly organizations: Array<{ id: string; name: string }>,
  ) {
    super(message);
  }
}

export async function planAccountDeletion(admin: Admin, userId: string) {
  const { data: memberships, error } = await admin
    .from("organization_memberships")
    .select("organization_id, role")
    .eq("profile_id", userId);
  if (error) throw error;

  const orgIds = [...new Set((memberships ?? []).map((m) => m.organization_id))];
  if (orgIds.length === 0) return { needsTransfer: [], soleOrganizations: [] };

  const [{ data: allMembers, error: membersError }, { data: orgs, error: orgsError }] = await Promise.all([
    admin.from("organization_memberships").select("organization_id, profile_id, role").in("organization_id", orgIds),
    admin.from("organizations").select("id, name").in("id", orgIds),
  ]);
  if (membersError) throw membersError;
  if (orgsError) throw orgsError;

  const nameOf = (id: string) => (orgs ?? []).find((o) => o.id === id)?.name ?? "an organization";
  const needsTransfer: Array<{ id: string; name: string }> = [];
  const soleOrganizations: Array<{ id: string; name: string }> = [];

  for (const orgId of orgIds) {
    const members = (allMembers ?? []).filter((m) => m.organization_id === orgId);
    const others = members.filter((m) => m.profile_id !== userId);
    const mine = members.find((m) => m.profile_id === userId);
    if (others.length === 0) {
      soleOrganizations.push({ id: orgId, name: nameOf(orgId) });
    } else if (mine?.role === "owner" && !others.some((m) => m.role === "owner")) {
      needsTransfer.push({ id: orgId, name: nameOf(orgId) });
    }
  }

  return { needsTransfer, soleOrganizations };
}

export async function deleteAccount(admin: Admin, userId: string, input: z.output<typeof deleteAccountSchema>): Promise<{ deletedOrganizations: string[] }> {
  const plan = await planAccountDeletion(admin, userId);

  if (plan.needsTransfer.length) {
    const names = plan.needsTransfer.map((o) => o.name).join(", ");
    throw new AccountDeletionBlocked(
      `You're the only owner of ${names}. Make another member an owner first, then delete your account.`,
      "transfer_ownership",
      plan.needsTransfer,
    );
  }

  if (plan.soleOrganizations.length && !input.deleteSoleOrganizations) {
    const names = plan.soleOrganizations.map((o) => o.name).join(", ");
    throw new AccountDeletionBlocked(
      `You're the only member of ${names}. Deleting your account also permanently deletes ${plan.soleOrganizations.length === 1 ? "that organization" : "those organizations"} and all of its contacts, bookings, quotes and history.`,
      "confirm_sole_organizations",
      plan.soleOrganizations,
    );
  }

  if (plan.soleOrganizations.length) {
    const { error } = await admin.from("organizations").delete().in("id", plan.soleOrganizations.map((o) => o.id));
    if (error) throw error;
  }

  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) throw error;

  return { deletedOrganizations: plan.soleOrganizations.map((o) => o.id) };
}
