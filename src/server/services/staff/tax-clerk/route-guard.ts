/**
 * The Receipts & HST routes' guard (ai-settings/tax-clerk/**): the caller must be a member of the
 * org (owner/admin to change anything), and the company must be the org's — checked on the
 * caller's own RLS client before any service-role call.
 */
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { createSupabaseServerClient } from "@/server/supabase/server";

export async function guardTaxClerk(
  params: { organizationId: string; companyId: string },
  manage: boolean,
): Promise<{ organizationId: string; companyId: string; profileId: string; canManage: boolean }> {
  const supabase = createSupabaseServerClient();
  const organization = await requireOrganizationContext(supabase, params.organizationId);
  const role = organization.membership.role;
  const canManage = role === "owner" || role === "admin";
  if (manage && !canManage) throw new AuthorizationError("Only owners and admins can change Receipts & HST.");
  const ctx: TenantServiceContext = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
  await assertCompanyInOrganization(ctx, params.companyId);
  return { organizationId: organization.organizationId, companyId: params.companyId, profileId: organization.user.id, canManage };
}
