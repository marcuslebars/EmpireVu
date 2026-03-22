import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { manualWorkflowEventInputSchema } from "@/server/services/workflow-engine/definitions";
import { runWorkflowNow } from "@/server/services/workflow-engine/processor";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

const runWorkflowNowInputSchema = z.object({
  event: manualWorkflowEventInputSchema.optional(),
  eventId: z.string().uuid().optional(),
}).refine((value) => value.event || value.eventId, {
  message: "run-now requires either eventId or event.",
});

interface RouteContext {
  params: {
    organizationId: string;
    workflowId: string;
  };
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const input = await parseJsonBody(request, runWorkflowNowInputSchema);

    const data = await runWorkflowNow(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      context.params.workflowId,
      input,
    );

    return NextResponse.json({ data });
  });
}