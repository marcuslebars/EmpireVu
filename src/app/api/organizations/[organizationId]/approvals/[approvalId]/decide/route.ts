import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { decideApprovalBodySchema, decideApprovalFromApp } from "@/server/services/owner-channel/app";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; approvalId: string };
}

/**
 * Approve / Skip from the app (owners and admins). Runs the same decide path as a texted
 * "Y" / "N" (decidedVia 'app'): claim-then-run, so a click racing a text can't run it twice.
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const approvalId = z.string().uuid().parse(context.params.approvalId);
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const role = organization.membership.role;
    if (role !== "owner" && role !== "admin") {
      throw new AuthorizationError("Only owners and admins can approve or skip.");
    }
    const body = await parseJsonBody(request, decideApprovalBodySchema);
    const result = await decideApprovalFromApp(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      approvalId,
      body,
    );
    if (result.outcome === "not_found") return NextResponse.json({ error: "That approval wasn't found." }, { status: 404 });
    return NextResponse.json({ data: result });
  }, request);
}
