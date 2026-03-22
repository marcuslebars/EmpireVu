import { NextResponse } from "next/server";

import { handleRoute, parseJsonBody, parseLimit } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { createSupabaseServerClient } from "@/server/supabase/server";
import { createTask, createTaskInputSchema, listTasks } from "@/server/services/tasks";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const url = new URL(request.url);

    const data = await listTasks(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      {
        assignedToProfileId: url.searchParams.get("assignedToProfileId"),
        companyId: url.searchParams.get("companyId"),
        limit: parseLimit(url.searchParams.get("limit")),
        status: url.searchParams.get("status") as "todo" | "in_progress" | "blocked" | "completed" | null,
      },
    );

    return NextResponse.json({ data });
  });
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const input = await parseJsonBody(request, createTaskInputSchema);

    const data = await createTask(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      input,
    );

    return NextResponse.json({ data }, { status: 201 });
  });
}