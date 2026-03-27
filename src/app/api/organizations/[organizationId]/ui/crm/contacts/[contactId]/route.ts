import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { getCRMContactDetailView } from "@/server/services/live-data";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    contactId: string;
    organizationId: string;
  };
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const url = new URL(_request.url);

    const data = await getCRMContactDetailView(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      context.params.contactId,
      {
        companyId: url.searchParams.get("companyId"),
      },
    );

    return NextResponse.json({ data });
  });
}
