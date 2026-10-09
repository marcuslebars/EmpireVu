import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { SMS_AGENT_AUTONOMY } from "@/server/services/sms-agent/settings";
import { getSmsAgentSettingsView, updateSmsAgentSettings } from "@/server/services/sms-agent/settings-view";
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

/** Settings → AI front desk → Text conversations (members). */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const ctx = await memberContext(context.params, false);
    return NextResponse.json({ data: await getSmsAgentSettingsView(ctx, context.params.companyId) });
  });
}

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    autonomy: z.enum(SMS_AGENT_AUTONOMY as unknown as [string, ...string[]]).optional(),
  })
  .strict();

/** Turn the text assistant on/off, or change how much it does alone (owners/admins). Merges ai_settings.sms_agent only. */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const ctx = await memberContext(context.params, true);
    const body = await parseJsonBody(request, patchSchema);
    await updateSmsAgentSettings(createSupabaseAdminClient(), ctx.organizationId, context.params.companyId, {
      enabled: body.enabled,
      autonomy: body.autonomy as (typeof SMS_AGENT_AUTONOMY)[number] | undefined,
    });
    return NextResponse.json({ data: await getSmsAgentSettingsView(ctx, context.params.companyId) });
  });
}
