import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { ValidationError, requireOrganizationContext } from "@/server/organizations/context";
import { getUnifiedTraceView } from "@/server/services/live-data";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    entityId: string;
    entityType: string;
    organizationId: string;
  };
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);

    if (![
      "contact",
      "booking",
      "task",
    ].includes(context.params.entityType)) {
      throw new ValidationError("entityType must be one of: contact, booking, task.");
    }

    const data = await getUnifiedTraceView(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      context.params.entityType as "contact" | "booking" | "task",
      context.params.entityId,
    );

    return NextResponse.json({ data });
  });
}