import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { memberRole, setMemberPhone } from "@/server/services/staff/dispatcher/member-phone";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; profileId: string };
}

const bodySchema = z.object({ phone: z.string().max(40).nullable() }).strict();

/**
 * Set or clear a team member's cell for crew schedule texts. Members may set their own; owners
 * and admins anyone's on the team. Service role write pinned to the caller's org.
 */
export async function PUT(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const organization = await requireOrganizationContext(createSupabaseServerClient(), context.params.organizationId);
    const role = organization.membership.role;
    const self = organization.user.id === context.params.profileId;
    if (!self && role !== "owner" && role !== "admin") {
      throw new AuthorizationError("You can only change your own number.");
    }
    const admin = createSupabaseAdminClient();
    // Same rule as roles: only an owner can touch an owner's details.
    if (!self && role !== "owner" && (await memberRole(admin, organization.organizationId, context.params.profileId)) === "owner") {
      throw new AuthorizationError("Only an owner can change an owner's number.");
    }
    const body = await parseJsonBody(request, bodySchema);
    const phone = await setMemberPhone(admin, organization.organizationId, context.params.profileId, body.phone);
    return NextResponse.json({ data: { profileId: context.params.profileId, phone } });
  });
}
