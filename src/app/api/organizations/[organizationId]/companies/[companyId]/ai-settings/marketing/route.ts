import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { UserFacingError } from "@/server/errors";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { getMarketingView, updateMarketingSettings } from "@/server/services/staff/marketer/view";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

// Owners choose what the Marketer does. The send throttle (30/hour, Mon-Sat 10-7) isn't
// editable here — it keeps campaigns inside the 9-to-8 rule for proactive texts.
const patchSchema = z
  .object({
    winBack: z
      .object({
        enabled: z.boolean().optional(),
        monthsMin: z.number().int().min(1).max(23).optional(),
        monthsMax: z.number().int().min(2).max(24).optional(),
        weeklyCap: z.number().int().min(1).max(2000).optional(),
      })
      .strict()
      .refine((v) => v.monthsMin === undefined || v.monthsMax === undefined || v.monthsMin < v.monthsMax, {
        message: "The start of the window must be before the end.",
      })
      .optional(),
    reviewReplies: z.object({ enabled: z.boolean() }).strict().optional(),
    googlePosts: z.object({ enabled: z.boolean() }).strict().optional(),
  })
  .strict();

async function guard(context: RouteContext, manage: boolean): Promise<{ organizationId: string; companyId: string; canManage: boolean }> {
  const supabase = createSupabaseServerClient();
  const organization = await requireOrganizationContext(supabase, context.params.organizationId);
  const role = organization.membership.role;
  const canManage = role === "owner" || role === "admin";
  if (manage && !canManage) throw new AuthorizationError("Only owners and admins can change the AI marketer.");
  const ctx: TenantServiceContext = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
  // The company must be this org's (checked on the caller's own RLS client) before any service-role call.
  await assertCompanyInOrganization(ctx, context.params.companyId);
  return { organizationId: organization.organizationId, companyId: context.params.companyId, canManage };
}

/** Settings → AI front desk → Marketer (any member reads). */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId, canManage } = await guard(context, false);
    const data = await getMarketingView(createSupabaseAdminClient(), { organizationId, companyId });
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data: { ...data, canManage } });
  });
}

/** Owner/admin: merge ONLY companies.ai_settings.marketing. */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId } = await guard(context, true);
    const patch = await parseJsonBody(request, patchSchema);
    const data = await updateMarketingSettings(createSupabaseAdminClient(), { organizationId, companyId }, patch);
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data: { ...data, canManage: true } });
  });
}
