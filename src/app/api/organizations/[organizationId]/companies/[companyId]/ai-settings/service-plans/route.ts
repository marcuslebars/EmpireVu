import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { UserFacingError } from "@/server/errors";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { planInputSchema, planPatchSchema } from "@/server/services/staff/service-plans/plans";
import { getServicePlansView, runServicePlansAction, ServicePlansError, updateServicePlansSettings, type ServicePlansAction } from "@/server/services/staff/service-plans/view";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    headsUp: z.object({ enabled: z.boolean() }).strict().optional(),
    renewals: z.object({ enabled: z.boolean() }).strict().optional(),
  })
  .strict();

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_plan"), plan: planInputSchema }).strict(),
  z.object({ action: z.literal("update_plan"), planId: z.string().uuid(), plan: planPatchSchema }).strict(),
  z.object({ action: z.literal("cancel_agreement"), agreementId: z.string().uuid() }).strict(),
]);

async function guard(context: RouteContext, manage: boolean): Promise<{ organizationId: string; companyId: string; manager: boolean; profileId: string }> {
  const supabase = createSupabaseServerClient();
  const organization = await requireOrganizationContext(supabase, context.params.organizationId);
  const role = organization.membership.role;
  const manager = role === "owner" || role === "admin";
  if (manage && !manager) throw new AuthorizationError("Only owners and admins can change service plans.");
  const ctx: TenantServiceContext = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
  // The company must be this org's (checked on the caller's own RLS client) before any service-role call.
  await assertCompanyInOrganization(ctx, context.params.companyId);
  return { organizationId: organization.organizationId, companyId: context.params.companyId, manager, profileId: organization.user.id };
}

function userFacing(err: unknown): never {
  if (err instanceof ServicePlansError) throw new UserFacingError(err.message, { status: err.status });
  throw err;
}

/** Settings → AI front desk → Service plans (members read plans; the customer list is owners/admins only). */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId, manager } = await guard(context, false);
    const data = await getServicePlansView(createSupabaseAdminClient(), organizationId, companyId, { manager });
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}

/** Owner/admin: merge ONLY ai_settings.service_plans. */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId } = await guard(context, true);
    const patch = await parseJsonBody(request, patchSchema);
    const data = await updateServicePlansSettings(createSupabaseAdminClient(), organizationId, companyId, patch).catch(userFacing);
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}

/** Owner/admin: create / edit a plan, or cancel a customer's plan. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId, profileId } = await guard(context, true);
    // (The SPA tsconfig isn't strict, so zod's inference loosens; the schema above is the check.)
    const input = (await parseJsonBody(request, actionSchema)) as ServicePlansAction;
    const result = await runServicePlansAction(createSupabaseAdminClient(), organizationId, companyId, profileId, input).catch(userFacing);
    return NextResponse.json({ data: result.view, message: result.message });
  });
}
