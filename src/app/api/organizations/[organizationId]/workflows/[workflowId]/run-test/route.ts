import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { manualWorkflowEventInputSchema } from "@/server/services/workflow-engine/definitions";
import { runWorkflowTest } from "@/server/services/workflow-engine/processor";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

const runWorkflowTestInputSchema = z.object({
  dryRun: z.boolean().optional(),
  sampleEvent: manualWorkflowEventInputSchema,
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
    const input = await parseJsonBody(request, runWorkflowTestInputSchema);

    const data = await runWorkflowTest(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      context.params.workflowId,
      {
        dryRun: input.dryRun,
        sampleEvent: input.sampleEvent,
      },
    );

    return NextResponse.json({ data });
  });
}