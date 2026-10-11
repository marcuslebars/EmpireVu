import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { getDispatchSettingsView, updateDispatchSettings } from "@/server/services/staff/dispatcher/settings-view";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

async function memberContext(params: RouteContext["params"], manage: boolean): Promise<TenantServiceContext> {
  const supabase = createSupabaseServerClient();
  const organization = await requireOrganizationContext(supabase, params.organizationId);
  const role = organization.membership.role;
  if (manage && role !== "owner" && role !== "admin") {
    throw new AuthorizationError("Only owners and admins can change the AI front desk.");
  }
  const ctx: TenantServiceContext = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
  await assertCompanyInOrganization(ctx, params.companyId);
  return ctx;
}

/**
 * Settings → AI front desk → Dispatcher (members read). The service role reads are pinned to the
 * caller's org + this company (checked above) — a sanctioned service-role surface.
 */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const ctx = await memberContext(context.params, false);
    return NextResponse.json({ data: await getDispatchSettingsView(createSupabaseAdminClient(), ctx.organizationId, context.params.companyId) });
  });
}

const patchSchema = z
  .object({
    weather: z
      .object({
        enabled: z.boolean().optional(),
        sensitive: z.union([z.literal("all"), z.literal("none"), z.array(z.string().min(1).max(80)).max(100), z.null()]).optional(),
        rainProbability: z.number().int().min(1).max(100).optional(),
        rainMm: z.number().min(0.1).max(200).optional(),
        windKmh: z.number().int().min(5).max(250).optional(),
        minTempC: z.number().int().min(-60).max(20).optional(),
        maxTempC: z.number().int().min(15).max(60).optional(),
      })
      .strict()
      .optional(),
    onOurWay: z.object({ enabled: z.boolean().optional() }).strict().optional(),
    // Crew texts go out 06:00–21:00, so the send time is 06:00–20:59.
    crewTexts: z.object({ enabled: z.boolean().optional(), time: z.string().regex(/^(0[6-9]|1\d|20):[0-5]\d$/, "Pick a time between 6:00 a.m. and 8:59 p.m.").optional() }).strict().optional(),
    fillGap: z.object({ enabled: z.boolean().optional() }).strict().optional(),
  })
  .strict();

/** Change the Dispatcher's switches / weather limits (owners/admins). Merges ai_settings.dispatch only. */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const ctx = await memberContext(context.params, true);
    const body = await parseJsonBody(request, patchSchema);
    const admin = createSupabaseAdminClient();
    await updateDispatchSettings(admin, ctx.organizationId, context.params.companyId, body);
    return NextResponse.json({ data: await getDispatchSettingsView(admin, ctx.organizationId, context.params.companyId) });
  });
}
