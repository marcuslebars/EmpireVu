import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext, ValidationError } from "@/server/organizations/context";
import {
  assignTaskUser,
  assignTaskUserInputSchema,
  getTaskById,
  updateTaskStatus,
  updateTaskStatusInputSchema,
} from "@/server/services/tasks";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
    taskId: string;
  };
}

const patchTaskInputSchema = z.object({
  assignedToProfileId: z.string().uuid().optional(),
  status: z.enum(["todo", "in_progress", "blocked", "completed"]).optional(),
});

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const data = await getTaskById(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      context.params.taskId,
    );

    return NextResponse.json({ data });
  });
}

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const input = await parseJsonBody(request, patchTaskInputSchema);
    const serviceContext = {
      actorProfileId: organization.user.id,
      organizationId: organization.organizationId,
      supabase,
    };

    if (input.status && input.assignedToProfileId) {
      throw new ValidationError("PATCH task accepts either status or assignedToProfileId, not both.");
    }

    if (input.status) {
      const data = await updateTaskStatus(
        serviceContext,
        updateTaskStatusInputSchema.parse({ status: input.status, taskId: context.params.taskId }),
      );

      return NextResponse.json({ data });
    }

    if (input.assignedToProfileId) {
      const data = await assignTaskUser(
        serviceContext,
        assignTaskUserInputSchema.parse({
          assignedToProfileId: input.assignedToProfileId,
          taskId: context.params.taskId,
        }),
      );

      return NextResponse.json({ data });
    }

    throw new ValidationError("PATCH task requires status or assignedToProfileId.");
  });
}