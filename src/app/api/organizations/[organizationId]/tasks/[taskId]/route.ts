import { NextResponse } from "next/server";
import { z } from "zod";
import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import {
  updateTaskStatus,
  updateTaskStatusInputSchema,
  assignTaskUser,
  assignTaskUserInputSchema,
  updateTask,
  updateTaskInputSchema,
  deleteTask,
  deleteTaskInputSchema,
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
  z.object({
    action: z.literal("updateTask"),
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(3000).nullable().optional(),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
    dueAt: z.union([z.string().datetime(), z.date()]).nullable().optional(),
  }),
]);

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const body = await parseJsonBody(request, patchTaskInputSchema);
    const ctx = {
      actorProfileId: organization.user.id,
      organizationId: organization.organizationId,
      supabase,
    };

    if (body.action === "updateStatus") {
      const data = await updateTaskStatus(
        ctx,
        updateTaskStatusInputSchema.parse({
          taskId: context.params.taskId,
          status: body.status,
        }),
      );
      return NextResponse.json({ data });
    }

    if (body.action === "assignUser") {
      const data = await assignTaskUser(
        ctx,
        assignTaskUserInputSchema.parse({
          taskId: context.params.taskId,
          assignedToProfileId: body.assignedToProfileId,
        }),
      );
      return NextResponse.json({ data });
    }

    // updateTask
    const data = await updateTask(
      ctx,
      updateTaskInputSchema.parse({
        taskId: context.params.taskId,
        title: body.title,
        description: body.description,
        priority: body.priority,
        dueAt: body.dueAt,
      }),
    );
    return NextResponse.json({ data });
  });
}

export async function DELETE(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const data = await deleteTask(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      deleteTaskInputSchema.parse({ taskId: context.params.taskId }),
    );
    return NextResponse.json({ data });
  });
}
