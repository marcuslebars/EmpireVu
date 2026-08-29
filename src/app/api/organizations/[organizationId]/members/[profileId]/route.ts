import { NextResponse } from "next/server";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import {
  removeMember,
  updateMemberRole,
  updateMemberRoleInputSchema,
} from "@/server/services/organization-users";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
    profileId: string;
  };
}

function assertCanManageMembers(role: string): void {
  if (role !== "owner" && role !== "admin") {
    throw new AuthorizationError("Only owners and admins can manage team members.");
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    assertCanManageMembers(organization.membership.role);
    const body = await parseJsonBody(request, updateMemberRoleInputSchema.pick({ role: true }));
    const data = await updateMemberRole(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      updateMemberRoleInputSchema.parse({ profileId: context.params.profileId, role: body.role }),
    );
    return NextResponse.json({ data });
  });
}

export async function DELETE(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    assertCanManageMembers(organization.membership.role);
    const data = await removeMember(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      context.params.profileId,
    );
    return NextResponse.json({ data });
  });
}
