import { AuthorizationError, type OrganizationContext } from "@/server/organizations/context";

/** Industry packs are an operator/owner tool: only org owners and admins may list or apply them. */
export function assertCanManagePacks(organization: OrganizationContext): void {
  const role = organization.membership.role;
  if (role !== "owner" && role !== "admin") {
    throw new AuthorizationError("Only owners and admins can manage industry packs.");
  }
}
