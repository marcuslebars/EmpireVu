import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { parseJsonBody } from "@/server/api/route";
import { ValidationError } from "@/server/organizations/context";
import { createTemplate, listTemplates, templateSchema } from "@/server/services/crew/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/** A brand's saved checklists. ?companyId required. */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    const companyId = new URL(request.url).searchParams.get("companyId");
    if (!companyId) throw new ValidationError("companyId is required.");
    return NextResponse.json({ data: await listTemplates(ctx, companyId) });
  });
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(
    context.params.organizationId,
    async (ctx) => {
      const input = await parseJsonBody(request, templateSchema);
      return NextResponse.json({ data: await createTemplate(ctx, input) }, { status: 201 });
    },
    { adminOnly: true },
  );
}
