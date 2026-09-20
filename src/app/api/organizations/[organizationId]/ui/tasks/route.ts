import { NextResponse } from "next/server";

import { handleRoute, parseBoolean, parseLimit, parsePage } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { getTasksListView } from "@/server/services/live-data";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

/** "a,b" → ["a", "b"]; a single value → a one-element list; empty/absent → null. */
function parseCsv(value: string | null): string[] | null {
  if (!value) {
    return null;
  }

  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);

  return parts.length > 0 ? parts : null;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const url = new URL(request.url);
    // Both accept a comma-separated list ("todo,in_progress") so a caller whose tab spans
    // several statuses filters in SQL instead of trimming a page client-side. A single
    // value behaves exactly as before.
    const priority = parseCsv(url.searchParams.get("priority"));
    const status = parseCsv(url.searchParams.get("status"));

    const data = await getTasksListView(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      {
        assigneeId: url.searchParams.get("assigneeId") ?? url.searchParams.get("assignedToProfileId"),
        companyId: url.searchParams.get("companyId"),
        overdue: parseBoolean(url.searchParams.get("overdue")),
        page: parsePage(url.searchParams.get("page")),
        pageSize: parseLimit(url.searchParams.get("pageSize") ?? url.searchParams.get("limit")),
        priority: priority as Array<"low" | "medium" | "high" | "urgent"> | null,
        search: url.searchParams.get("search"),
        status: status as Array<"todo" | "in_progress" | "blocked" | "completed"> | null,
      },
    );

    return NextResponse.json({ data });
  });
}