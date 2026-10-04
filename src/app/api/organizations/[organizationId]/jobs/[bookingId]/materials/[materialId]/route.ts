import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { deleteMaterial } from "@/server/services/time/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; bookingId: string; materialId: string };
}

export async function DELETE(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) =>
    NextResponse.json({ data: await deleteMaterial(ctx, context.params.bookingId, context.params.materialId) }),
  );
}
