import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { UserFacingError } from "@/server/errors";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { createEmailInbox, getEmailClerkView, updateEmailClerkSettings } from "@/server/services/staff/email-clerk/view";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    draftReplies: z.boolean().optional(),
    digest: z.boolean().optional(),
    digestTime: z
      .string()
      .regex(/^(1[2-9]):(00|30)$/, "Pick a time between 12:00 and 19:30.")
      .optional(),
  })
  .strict();

async function guard(context: RouteContext, manage: boolean): Promise<{ organizationId: string; companyId: string; manager: boolean }> {
  const supabase = createSupabaseServerClient();
  const organization = await requireOrganizationContext(supabase, context.params.organizationId);
  const role = organization.membership.role;
  const manager = role === "owner" || role === "admin";
  if (manage && !manager) throw new AuthorizationError("Only owners and admins can change the email inbox.");
  const ctx: TenantServiceContext = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
  // The company must be this org's (checked on the caller's own RLS client) before any service-role call.
  await assertCompanyInOrganization(ctx, context.params.companyId);
  return { organizationId: organization.organizationId, companyId: context.params.companyId, manager };
}

/** Settings → AI front desk → Email inbox. Members read the switches; the address and emails are for owners/admins. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId, manager } = await guard(context, false);
    const data = await getEmailClerkView(createSupabaseAdminClient(), { organizationId, companyId }, { manager });
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}

/** Owner/admin: merge ONLY ai_settings.email_clerk. */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId } = await guard(context, true);
    const patch = await parseJsonBody(request, patchSchema);
    const data = await updateEmailClerkSettings(createSupabaseAdminClient(), { organizationId, companyId }, patch);
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}

const actionSchema = z.object({ action: z.literal("create_inbox") }).strict();

/** Owner/admin: `{ action: "create_inbox" }` makes the business inbox address (a GET never does). */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId } = await guard(context, true);
    await parseJsonBody(request, actionSchema);
    const data = await createEmailInbox(createSupabaseAdminClient(), { organizationId, companyId });
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    if ("error" in data) throw new UserFacingError(data.error, { status: 400 });
    return NextResponse.json({ data });
  });
}
