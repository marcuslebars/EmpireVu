import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { parseJsonBody } from "@/server/api/route";
import { z } from "zod";

import { applyChecklistTemplate } from "@/server/services/crew/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; bookingId: string };
}

const schema = z.object({ templateId: z.string().uuid() });

/** Add a saved checklist's items to the job (items already there are skipped). */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    const { templateId } = await parseJsonBody(request, schema);
    return NextResponse.json({ data: await applyChecklistTemplate(ctx, context.params.bookingId, templateId) });
  });
}
