import { NextResponse } from "next/server";

import { handleRoute, parseJsonBody, parseLimit } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import {
  createComment,
  createCommentInputSchema,
  listComments,
} from "@/server/services/comments";
import { createSupabaseServerClient } from "@/server/supabase/server";

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

    const data = await listComments(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      {
        companyId: url.searchParams.get("companyId"),
        entityId: url.searchParams.get("entityId"),
        entityType: url.searchParams.get("entityType") as
          | "company"
          | "contact"
          | "booking"
          | "task"
          | "workflow"
          | "workflow_run"
          | "activity_event"
          | null,
        limit: parseLimit(url.searchParams.get("limit")),
      },
    );

    return NextResponse.json({ data });
  });
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const input = await parseJsonBody(request, createCommentInputSchema);

    const data = await createComment(
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