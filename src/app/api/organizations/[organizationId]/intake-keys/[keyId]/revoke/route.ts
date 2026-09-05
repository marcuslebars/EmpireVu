import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { revokeIntakeKey } from "@/server/services/lead-intake/intake-keys";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; keyId: string };
}

export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    if (!["owner", "admin"].includes(organization.membership.role)) {
      throw new AuthorizationError("Admin access is required to revoke intake keys.");
    }
    await revokeIntakeKey(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      context.params.keyId,
    );
    return NextResponse.json({ data: { ok: true } });
  });
}
