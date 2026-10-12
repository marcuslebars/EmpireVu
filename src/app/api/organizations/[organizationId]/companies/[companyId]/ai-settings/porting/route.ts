import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { UserFacingError } from "@/server/errors";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { MAX_RING_SECONDS, MIN_RING_SECONDS } from "@/server/services/staff/porting/settings";
import { cancelPortFromSettings, getPortingView, startPortFromSettings, updatePortingSettings } from "@/server/services/staff/porting/view";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    ring: z
      .object({
        enabled: z.boolean().optional(),
        seconds: z.number().int().min(MIN_RING_SECONDS).max(MAX_RING_SECONDS).optional(),
        crew: z.boolean().optional(),
        screen: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), number: z.string().max(40).nullable().optional() }).strict(),
  z.object({ action: z.literal("cancel"), portId: z.string().uuid() }).strict(),
]);

/**
 * Members may read; changes are owner/admin only. Porting details (authorized name, service address,
 * the form link) are owner/admin only too: a plain member gets the settings without the port.
 */
async function guard(context: RouteContext, manage: boolean): Promise<{ organizationId: string; companyId: string; canManage: boolean }> {
  const supabase = createSupabaseServerClient();
  const organization = await requireOrganizationContext(supabase, context.params.organizationId);
  const role = organization.membership.role;
  const canManage = role === "owner" || role === "admin";
  if (manage && !canManage) throw new AuthorizationError("Only owners and admins can change this.");
  const ctx: TenantServiceContext = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
  // The company must be this org's (checked on the caller's own RLS client) before any service-role call.
  await assertCompanyInOrganization(ctx, context.params.companyId);
  return { organizationId: organization.organizationId, companyId: context.params.companyId, canManage };
}

/** Settings → AI front desk → Keep your number: switches, ring settings, the current port. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId, canManage } = await guard(context, false);
    const data = await getPortingView(createSupabaseAdminClient(), { organizationId, companyId });
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data: canManage ? data : { ...data, port: data.port ? { ...data.port, url: null } : null } });
  });
}

/** Owner/admin: merge ONLY ai_settings.porting ({ enabled, ring: { enabled, seconds, crew, screen } }). */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId } = await guard(context, true);
    const patch = await parseJsonBody(request, patchSchema);
    const data = await updatePortingSettings(createSupabaseAdminClient(), { organizationId, companyId }, patch);
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}

/** Owner/admin: { action: "start", number? } texts the owner the form link; { action: "cancel", portId }. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const scope = await guard(context, true);
    const body = await parseJsonBody(request, actionSchema);
    const admin = createSupabaseAdminClient();
    if (body.action === "start") {
      const result = await startPortFromSettings(admin, scope, body.number ?? null);
      if (!result.view) throw new UserFacingError("Company not found.", { status: 404 });
      return NextResponse.json({ data: { ...result.view, started: { url: result.url, texted: result.texted } } });
    }
    const data = await cancelPortFromSettings(admin, scope, body.portId);
    return NextResponse.json({ data });
  });
}
