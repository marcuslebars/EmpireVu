import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { deactivateVoiceNumber } from "@/server/services/voice-numbers";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; numberId: string };
}

export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    if (!["owner", "admin"].includes(organization.membership.role)) {
      throw new AuthorizationError("Admin access is required to deactivate voice numbers.");
    }
    await deactivateVoiceNumber(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      context.params.numberId,
    );
    return NextResponse.json({ data: { ok: true } });
  });
}
