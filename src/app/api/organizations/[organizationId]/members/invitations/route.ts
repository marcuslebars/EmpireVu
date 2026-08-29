import { NextResponse } from "next/server";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import {
  createInvitation,
  createInvitationInputSchema,
  listInvitations,
} from "@/server/services/organization-invitations";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

function assertCanManageMembers(role: string): void {
  if (role !== "owner" && role !== "admin") {
    throw new AuthorizationError("Only owners and admins can manage team members.");
  }
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const data = await listInvitations(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      { status: "pending" },
    );
    return NextResponse.json({ data });
  });
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    assertCanManageMembers(organization.membership.role);
    const input = await parseJsonBody(request, createInvitationInputSchema);
    const data = await createInvitation(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      input,
    );
    return NextResponse.json({ data });
  });
}
