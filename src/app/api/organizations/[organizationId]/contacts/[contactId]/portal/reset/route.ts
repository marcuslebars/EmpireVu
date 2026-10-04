import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { resetPortalLink } from "@/server/services/portal/links";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; contactId: string };
}

/** Reset: the old link stops working immediately. */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => NextResponse.json({ data: await resetPortalLink(ctx, context.params.contactId) }));
}
