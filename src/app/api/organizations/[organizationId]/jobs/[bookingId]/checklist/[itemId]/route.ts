import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { parseJsonBody } from "@/server/api/route";
import { deleteChecklistItem, setChecklistItemDone, toggleChecklistSchema } from "@/server/services/crew/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; bookingId: string; itemId: string };
}

/** Tick or untick an item. */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    const { done } = await parseJsonBody(request, toggleChecklistSchema);
    return NextResponse.json({ data: await setChecklistItemDone(ctx, context.params.bookingId, context.params.itemId, done) });
  });
}

export async function DELETE(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    return NextResponse.json({ data: await deleteChecklistItem(ctx, context.params.bookingId, context.params.itemId) });
  });
}
