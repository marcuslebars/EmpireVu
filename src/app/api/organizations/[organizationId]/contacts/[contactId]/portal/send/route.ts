import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { parseJsonBody } from "@/server/api/route";
import { sendPortalLink, sendPortalSchema } from "@/server/services/portal/links";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; contactId: string };
}

/** Text or email the customer their portal link. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    const { channel } = await parseJsonBody(request, sendPortalSchema);
    return NextResponse.json({ data: await sendPortalLink(ctx, context.params.contactId, channel) });
  });
}
