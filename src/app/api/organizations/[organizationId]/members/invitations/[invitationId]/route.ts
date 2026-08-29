import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { revokeInvitation } from "@/server/services/organization-invitations";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    invitationId: string;
    organizationId: string;
  };
}

export async function DELETE(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    if (organization.membership.role !== "owner" && organization.membership.role !== "admin") {
      throw new AuthorizationError("Only owners and admins can manage team members.");
    }
    const data = await revokeInvitation(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      context.params.invitationId,
    );
    return NextResponse.json({ data });
  });
}
