import { NextResponse } from "next/server";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { updateDraft, updateDraftInputSchema } from "@/server/services/ai-drafts";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
    contactId: string;
    draftId: string;
  };
}

/** Save the reviewer's edits to the drafted email / SMS before it goes out. */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const body = await parseJsonBody(request, updateDraftInputSchema);

    const data = await updateDraft(
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
