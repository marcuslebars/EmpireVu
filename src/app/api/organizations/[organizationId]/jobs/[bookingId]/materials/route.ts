import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { parseJsonBody } from "@/server/api/route";
import { addMaterial, listMaterials, materialSchema } from "@/server/services/time/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; bookingId: string };
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => NextResponse.json({ data: await listMaterials(ctx, context.params.bookingId) }));
}

/** Log materials / expenses used on the job. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    const input = await parseJsonBody(request, materialSchema);
    return NextResponse.json({ data: await addMaterial(ctx, context.params.bookingId, input) }, { status: 201 });
  });
}
