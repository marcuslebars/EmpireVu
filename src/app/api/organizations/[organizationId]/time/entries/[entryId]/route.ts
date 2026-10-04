import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { parseJsonBody } from "@/server/api/route";
import { deleteEntry, entryUpdateSchema, updateEntry } from "@/server/services/time/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; entryId: string };
}

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    const input = await parseJsonBody(request, entryUpdateSchema);
    return NextResponse.json({ data: await updateEntry(ctx, context.params.entryId, input) });
  });
}

export async function DELETE(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    await deleteEntry(ctx, context.params.entryId);
    return NextResponse.json({ data: { ok: true } });
  });
}
