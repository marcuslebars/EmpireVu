import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { addLinkToReminders } from "@/server/services/visits/settings";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

/** Add the visit link to the brand's reminder automations (owners and admins). */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => NextResponse.json({ data: await addLinkToReminders(ctx, context.params.companyId) }), {
    adminOnly: true,
    adminOnlyMessage: "Only owners and admins can change reminder automations.",
  });
}
