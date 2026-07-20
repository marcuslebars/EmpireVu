import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { syncCallOutcomesForContact } from "@/server/services/voice";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
    contactId: string;
  };
}

/**
 * Pull outcomes for this contact's placed calls from Cartesia and record any
 * that have finished. Idempotent — safe to call whenever the contact is opened.
 */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);

    const result = await syncCallOutcomesForContact(
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
