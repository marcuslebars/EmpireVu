import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { UserFacingError } from "@/server/errors";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { MAX_CUSHION_CENTS, WEEKLY_TIMES } from "@/server/services/staff/profit-advisor/settings";
import { getProfitAdvisorView, updateProfitAdvisorSettings } from "@/server/services/staff/profit-advisor/view";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    weekly: z
      .object({
        enabled: z.boolean().optional(),
        day: z.number().int().min(0).max(6).optional(),
        time: z.enum(WEEKLY_TIMES as [string, ...string[]]).optional(),
      })
      .strict()
      .optional(),
    pricingCheck: z.object({ enabled: z.boolean().optional() }).strict().optional(),
    tightCushionCents: z.number().int().min(0).max(MAX_CUSHION_CENTS).optional(),
  })
  .strict();

async function guard(context: RouteContext, manage: boolean): Promise<{ organizationId: string; companyId: string; manager: boolean }> {
  const supabase = createSupabaseServerClient();
  const organization = await requireOrganizationContext(supabase, context.params.organizationId);
  const role = organization.membership.role;
  const manager = role === "owner" || role === "admin";
  if (manage && !manager) throw new AuthorizationError("Only owners and admins can change the profit advisor.");
  const ctx: TenantServiceContext = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
  // The company must be this org's (checked on the caller's own RLS client) before any service-role call.
  await assertCompanyInOrganization(ctx, context.params.companyId);
  return { organizationId: organization.organizationId, companyId: context.params.companyId, manager };
}

/** Settings → AI front desk → Profit advisor. Members read the switches; the money is for owners/admins. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId, manager } = await guard(context, false);
    const data = await getProfitAdvisorView(createSupabaseAdminClient(), { organizationId, companyId }, { manager });
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}

/** Owner/admin: merge ONLY ai_settings.profit_advisor. */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId } = await guard(context, true);
    const patch = await parseJsonBody(request, patchSchema);
    const data = await updateProfitAdvisorSettings(createSupabaseAdminClient(), { organizationId, companyId }, patch);
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}
