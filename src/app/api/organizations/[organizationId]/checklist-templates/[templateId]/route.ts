import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { parseJsonBody } from "@/server/api/route";
import { deleteTemplate, templateUpdateSchema, updateTemplate } from "@/server/services/crew/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; templateId: string };
}

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(
    context.params.organizationId,
    async (ctx) => {
      const input = await parseJsonBody(request, templateUpdateSchema);
      return NextResponse.json({ data: await updateTemplate(ctx, context.params.templateId, input) });
    },
    { adminOnly: true },
  );
}

export async function DELETE(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(
    context.params.organizationId,
    async (ctx) => {
      await deleteTemplate(ctx, context.params.templateId);
      return NextResponse.json({ data: { ok: true } });
    },
    { adminOnly: true },
  );
}
