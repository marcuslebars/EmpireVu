import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { updateWorkflowStatus, updateWorkflowStatusInputSchema } from "@/server/services/workflows";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
    workflowId: string;
  };
}

const patchWorkflowInputSchema = z.object({
  action: z.literal("updateStatus"),
  status: z.enum(["draft", "active", "paused", "archived"]),
});

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const body = await parseJsonBody(request, patchWorkflowInputSchema);

    const data = await updateWorkflowStatus(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      updateWorkflowStatusInputSchema.parse({
        workflowId: context.params.workflowId,
        status: body.status,
      }),
    );
    return NextResponse.json({ data });
  });
}
