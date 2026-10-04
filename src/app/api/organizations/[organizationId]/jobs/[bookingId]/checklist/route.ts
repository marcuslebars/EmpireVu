import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { parseJsonBody } from "@/server/api/route";
import { addChecklistItems, addChecklistSchema } from "@/server/services/crew/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; bookingId: string };
}

/** Add items to the job's checklist. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    const { labels } = await parseJsonBody(request, addChecklistSchema);
    return NextResponse.json({ data: await addChecklistItems(ctx, context.params.bookingId, labels) }, { status: 201 });
  });
}
