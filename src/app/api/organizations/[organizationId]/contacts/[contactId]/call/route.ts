import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { callContactWithMarina } from "@/server/services/voice";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
    contactId: string;
  };
}

/**
 * Place an on-demand voice call to this contact with the Cartesia agent (Marina).
 * This is the manual counterpart to the `call_lead` workflow action — same service,
 * triggered by the owner from the contact page rather than by an automation.
 */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);

    const result = await callContactWithMarina(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      context.params.contactId,
    );

    return NextResponse.json({ data: result });
  });
}
