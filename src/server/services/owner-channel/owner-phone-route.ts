import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { createSupabaseServerClient } from "@/server/supabase/server";

/**
 * The owner's cell (the owner channel's identity). SANCTIONED EXCEPTION (service role):
 * owner_phone_e164 isn't client-writable (20261009160000_front_desk_hardening), so after the
 * caller is checked as an owner/admin of the org and the company is checked to be in it, the
 * read/write uses the service role pinned to that org + company. A new number only becomes the
 * owner phone after the 6-digit code texted to it is entered (…/owner-phone/verify).
 */
export async function ownerPhoneContext(params: { organizationId: string; companyId: string }, manage: boolean): Promise<TenantServiceContext & { role: string }> {
  const supabase = createSupabaseServerClient();
  const organization = await requireOrganizationContext(supabase, params.organizationId);
  const role = organization.membership.role;
  if (manage && role !== "owner" && role !== "admin") {
    throw new AuthorizationError("Only owners and admins can change the owner's phone.");
  }
  const ctx: TenantServiceContext = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
  await assertCompanyInOrganization(ctx, params.companyId);
  return { ...ctx, role };
}

