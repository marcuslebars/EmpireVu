import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { UserFacingError } from "@/server/errors";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { CALL_ANSWERING_MODES } from "@/server/services/voice/answering-settings";
import { getCallAnsweringView, updateCallAnswering } from "@/server/services/voice/answering-view";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

// Owners choose the MODE only. The included minutes are part of what they pay for, so they're
// set by an operator (concierge "Set AI call minutes"), never from here — a strict schema
// rejects included_minutes.
const patchSchema = z.object({ mode: z.enum(CALL_ANSWERING_MODES) }).strict();

async function guard(context: RouteContext, manage: boolean): Promise<{ organizationId: string; companyId: string }> {
  const supabase = createSupabaseServerClient();
  const organization = await requireOrganizationContext(supabase, context.params.organizationId);
  const role = organization.membership.role;
  if (manage && role !== "owner" && role !== "admin") {
    throw new AuthorizationError("Only owners and admins can change how calls are answered.");
  }
  const ctx: TenantServiceContext = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
  // The company must be this org's (checked on the caller's own RLS client) before any service-role call.
  await assertCompanyInOrganization(ctx, context.params.companyId);
  return { organizationId: organization.organizationId, companyId: context.params.companyId };
}

/** Settings → AI front desk → Call answering: mode, this month's minutes, what the AI says. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId } = await guard(context, false);
    const data = await getCallAnsweringView(createSupabaseAdminClient(), organizationId, companyId);
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}

/** Owner/admin: merge ONLY ai_settings.call_answering ({ mode }). */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId } = await guard(context, true);
    const patch = await parseJsonBody(request, patchSchema);
    const data = await updateCallAnswering(createSupabaseAdminClient(), organizationId, companyId, patch);
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}
