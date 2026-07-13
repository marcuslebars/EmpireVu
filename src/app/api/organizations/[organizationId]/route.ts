import { NextResponse } from "next/server";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { updateOrganization, updateOrganizationInputSchema } from "@/server/services/organizations";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);

    if (organization.membership.role !== "owner" && organization.membership.role !== "admin") {
      throw new AuthorizationError("Only organization owners and admins can update the organization.");
    }

    const input = await parseJsonBody(request, updateOrganizationInputSchema);
    const data = await updateOrganization(supabase, context.params.organizationId, input);

    return NextResponse.json({ data });
  });
}
