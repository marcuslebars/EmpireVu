import { NextResponse } from "next/server";
import { z } from "zod";
import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import {
  updateTaskStatus,
  updateTaskStatusInputSchema,
  assignTaskUser,
  assignTaskUserInputSchema,
} from "@/server/services/tasks";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    taskId: string;
    organizationId: string;
  };
}

const patchTaskInputSchema = z.union([
  z.object({ action: z.literal("updateStatus"), status: z.enum(["todo", "in_progress", "blocked", "completed"]) }),
  z.object({ action: z.literal("assignUser"), assignedToProfileId: z.string().uuid() }),
]);

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const body = await parseJsonBody(request, patchTaskInputSchema);

    if (body.action === "updateStatus") {
      const data = await updateTaskStatus(
        {
          actorProfileId: organization.user.id,
          organizationId: organization.organizationId,
          supabase,
        },
        updateTaskStatusInputSchema.parse({
          taskId: context.params.taskId,
          status: body.status,
        }),
      );
      return NextResponse.json({ data });
    }

    // assignUser
    const data = await assignTaskUser(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      assignTaskUserInputSchema.parse({
        taskId: context.params.taskId,
        assignedToProfileId: body.assignedToProfileId,
      }),
    );
    return NextResponse.json({ data });
  });
}
