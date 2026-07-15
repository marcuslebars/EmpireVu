import { NextResponse } from "next/server";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { confirmProposedSlot, confirmSlotInputSchema } from "@/server/services/ai-drafts";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
    contactId: string;
    draftId: string;
  };
}

/** Confirm one of the AI's proposed slots into a real booking. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const body = await parseJsonBody(request, confirmSlotInputSchema);

    const data = await confirmProposedSlot(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      context.params.draftId,
      body,
    );

    return NextResponse.json({ data });
  });
}
