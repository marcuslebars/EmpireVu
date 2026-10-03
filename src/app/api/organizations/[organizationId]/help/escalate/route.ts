import { NextResponse } from "next/server";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { isEmailSendConfigured, sendEmail } from "@/server/outbound/email";
import { requireOrganizationContext } from "@/server/organizations/context";
import { loadHelpAccountContext } from "@/server/services/help/account-context";
import { enforceHelpEscalateLimits } from "@/server/services/help/limits";
import {
  SUPPORT_CONFIRMATION,
  createSupportRequest,
  escalateBodySchema,
} from "@/server/services/help/support";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/**
 * "Contact support" from the Help panel (docs/help-assistant.md). Org members only.
 * Saves a support_requests row for THIS org on the caller's RLS client, then emails the
 * operator (OWNER_EMAIL) with org/company, the user's email, plan/tier and the transcript.
 * Rate-limited per user and per org.
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const body = await parseJsonBody(request, escalateBodySchema);

    const limited = await enforceHelpEscalateLimits(request, {
      userId: organization.user.id,
      organizationId: organization.organizationId,
    });
    if (limited) return limited;

    const ctx = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
    const account = await loadHelpAccountContext(ctx, organization.membership.role ?? null);

    const result = await createSupportRequest(
      ctx,
      { body, requesterEmail: organization.user.email ?? organization.profile?.email ?? null, account },
      { sendEmail, isEmailConfigured: isEmailSendConfigured },
    );

    return NextResponse.json({ data: { id: result.id, message: SUPPORT_CONFIRMATION } });
  });
}
