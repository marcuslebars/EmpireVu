import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { getPortalLink } from "@/server/services/portal/links";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; contactId: string };
}

/** The customer's portal link (created on first use) and when they last opened it. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => NextResponse.json({ data: await getPortalLink(ctx, context.params.contactId) }));
}
