import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { assertCompanyInOrganization } from "@/server/services/shared";
import { sendTestLead } from "@/server/services/lead-intake/test-lead";
import { recordOnboardingEvent, upsertOnboardingStep } from "@/server/services/onboarding";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

const bodySchema = z.object({ companyId: z.string().uuid() });

/**
 * Website-leads step: fire a test lead through the real intake pipeline so the user watches
 * it appear. Marks the step complete on success.
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const ctx = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
    const body = await parseJsonBody(request, bodySchema);
    await assertCompanyInOrganization(ctx, body.companyId);

    await recordOnboardingEvent(ctx, { companyId: body.companyId, step: "website", event: "start" });
    try {
      const result = await sendTestLead(ctx, body.companyId);
      await upsertOnboardingStep(ctx, body.companyId, "website", { completed: true, data: { testLeadId: result.leadId } });
      await recordOnboardingEvent(ctx, { companyId: body.companyId, step: "website", event: "complete" });
      return NextResponse.json({ data: result });
    } catch (err) {
      await recordOnboardingEvent(ctx, {
        companyId: body.companyId,
        step: "website",
        event: "error",
        metadata: { message: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  });
}
