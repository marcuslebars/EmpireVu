import { NextResponse } from "next/server";

import { handleRoute, parseLimit } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { listTasks } from "@/server/services/tasks";
import { createSupabaseServerClient } from "@/server/supabase/server";
import type { Tables } from "@/server/db/database.types";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

interface OpsTaskRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueAt: string | null;
  companyId: string | null;
  companyName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  assigneeEmail: string | null;
  createdAt: string;
  isOverdue: boolean;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const url = new URL(request.url);

    const tasks = await listTasks(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      {
        limit: parseLimit(url.searchParams.get("limit")),
      },
    );

    const assigneeProfileIds = [...new Set(tasks.map((t) => t.assigned_to_profile_id).filter(Boolean))];
    const companyIds = [...new Set(tasks.map((t) => t.company_id).filter(Boolean))];

    const [{ data: profiles }, { data: companies }] = await Promise.all([
      assigneeProfileIds.length > 0
        ? supabase.from("profiles").select("id, full_name, email").in("id", assigneeProfileIds)
        : { data: [] as Tables<"profiles">[] | null },
      companyIds.length > 0
        ? supabase.from("companies").select("id, name").in("id", companyIds)
        : { data: [] as Tables<"companies">[] | null },
    ]);

    const profileMap = new Map((profiles ?? []).map((p) => [p.id, p]));
    const companyMap = new Map((companies ?? []).map((c) => [c.id, c]));

    const now = new Date();

    const rows: OpsTaskRow[] = tasks.map((task) => {
      const company = task.company_id ? companyMap.get(task.company_id) : null;
      const assignee = task.assigned_to_profile_id ? profileMap.get(task.assigned_to_profile_id) : null;
      const dueAt = task.due_at ? new Date(task.due_at) : null;
      const isOverdue = dueAt ? dueAt < now && task.status !== "completed" : false;

      return {
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority ?? "medium",
        dueAt: task.due_at,
        companyId: task.company_id,
        companyName: company?.name ?? null,
        assigneeId: task.assigned_to_profile_id,
        assigneeName: assignee?.full_name ?? null,
        assigneeEmail: assignee?.email ?? null,
        createdAt: task.created_at,
        isOverdue,
      };
    });

    return NextResponse.json({ data: rows });
  });
}
