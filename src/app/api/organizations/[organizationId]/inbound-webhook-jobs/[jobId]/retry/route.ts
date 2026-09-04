import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { retryInboundWebhookJob } from "@/server/services/inbound-webhook-jobs";
// inbound_webhook_jobs is service-role only (no member RLS) and org-nullable, so the
// reset runs on the admin client AFTER the org-membership authz check below. The
// service scopes the job to the caller's org (or an unresolved null-org job).
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    jobId: string;
    organizationId: string;
  };
}

/** Internal ops action: re-drive a failed/stuck inbound webhook job. Mirrors
 *  workflow-event-jobs/[jobId]/retry. */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);

    const data = await retryInboundWebhookJob(
      createSupabaseAdminClient(),
      context.params.jobId,
      organization.organizationId,
    );

    return NextResponse.json({ data });
  });
}
