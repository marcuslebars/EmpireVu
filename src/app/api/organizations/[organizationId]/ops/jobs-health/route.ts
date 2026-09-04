import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { getInboundWebhookJobsHealth } from "@/server/services/inbound-webhook-jobs";
import { getWorkflowEventJobsHealthSummary } from "@/server/services/workflow-event-jobs";
// Aggregate-only read of the platform inbound-webhook queue (service-role; the table
// has no member RLS). No tenant rows are read — just pending/running/failed counts.
import { createSupabaseAdminClient } from "@/server/supabase/admin";
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

    const summary = await getWorkflowEventJobsHealthSummary(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      {
        companyId: url.searchParams.get("companyId") ?? undefined,
        staleAfterSeconds: 900,
      },
    );
    const inboundWebhookJobs = await getInboundWebhookJobsHealth(createSupabaseAdminClient());

    return NextResponse.json({ data: { ...summary, inboundWebhookJobs } });
  });
}
