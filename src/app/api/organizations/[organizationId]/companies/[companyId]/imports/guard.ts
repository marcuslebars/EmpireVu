/**
 * Shared check for the Import customers routes: the caller is an owner/admin of the org (members
 * may only read the overview) and the company is that org's (checked on the caller's own RLS
 * client) — only then is the company handed to the service-role import code.
 */
import { UserFacingError } from "@/server/errors";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { loadImportCompany, type ImportCompany } from "@/server/services/staff/importer/settings";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export interface ImportRouteContext {
  params: { organizationId: string; companyId: string; batchId?: string };
}

export async function importGuard(context: ImportRouteContext, manage: boolean): Promise<{ company: ImportCompany; actorId: string }> {
  const supabase = createSupabaseServerClient();
  const organization = await requireOrganizationContext(supabase, context.params.organizationId);
  const role = organization.membership.role;
  if (manage && role !== "owner" && role !== "admin") {
    throw new AuthorizationError("Only owners and admins can import customers.");
  }
  const ctx: TenantServiceContext = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
  await assertCompanyInOrganization(ctx, context.params.companyId);
  const company = await loadImportCompany(createSupabaseAdminClient(), organization.organizationId, context.params.companyId);
  if (!company) throw new UserFacingError("Company not found.", { status: 404 });
  return { company, actorId: organization.user.id };
}
