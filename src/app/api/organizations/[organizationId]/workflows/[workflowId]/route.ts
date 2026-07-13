import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import {
  updateWorkflow,
  updateWorkflowInputSchema,
  updateWorkflowStatus,
  updateWorkflowStatusInputSchema,
} from "@/server/services/workflows";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
    workflowId: string;
  };
}

const patchWorkflowInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("updateStatus"),
    status: z.enum(["draft", "active", "paused", "archived"]),
  }),
  z.object({
    action: z.literal("update"),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(5000).nullable().optional(),
    triggerEvent: z.string().min(2).max(120).optional(),
    definition: z.record(z.string(), z.unknown()).optional(),
    status: z.enum(["draft", "active", "paused", "archived"]).optional(),
  }),
]);

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const body = await parseJsonBody(request, patchWorkflowInputSchema);

    const serviceContext = {
      actorProfileId: organization.user.id,
      organizationId: organization.organizationId,
      supabase,
    };

    if (body.action === "update") {
      const data = await updateWorkflow(
        serviceContext,
        updateWorkflowInputSchema.parse({
          workflowId: context.params.workflowId,
          name: body.name,
          description: body.description,
          triggerEvent: body.triggerEvent,
          definition: body.definition,
          status: body.status,
        }),
      );
      return NextResponse.json({ data });
    }

    const data = await updateWorkflowStatus(
      serviceContext,
      updateWorkflowStatusInputSchema.parse({
        workflowId: context.params.workflowId,
        status: body.status,
      }),
    );
    return NextResponse.json({ data });
  });
}
