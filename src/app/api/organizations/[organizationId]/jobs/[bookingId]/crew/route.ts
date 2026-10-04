import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { parseJsonBody } from "@/server/api/route";
import { setCrew, setCrewSchema } from "@/server/services/crew/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; bookingId: string };
}

/** Replace who is on the job. Newly added people are notified. */
export async function PUT(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    const { profileIds } = await parseJsonBody(request, setCrewSchema);
    return NextResponse.json({ data: await setCrew(ctx, context.params.bookingId, profileIds) });
  });
}
