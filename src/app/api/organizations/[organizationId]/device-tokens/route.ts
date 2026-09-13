import { NextResponse } from "next/server";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { getAuthenticatedUser, requireOrganizationContext } from "@/server/organizations/context";
import { registerDeviceToken, registerDeviceTokenSchema, revokeDeviceToken, revokeDeviceTokenSchema } from "@/server/services/device-tokens";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/** Register (or refresh) this install's push token under the organization. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const input = await parseJsonBody(request, registerDeviceTokenSchema);

    const data = await registerDeviceToken(createSupabaseAdminClient(), {
      ...input,
      userId: organization.user.id,
      organizationId: organization.organizationId,
    });

    return NextResponse.json({ data });
  });
}

/** Revoke on sign-out. Needs only authentication — revoking must work even after losing membership. */
export async function DELETE(request: Request): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const user = await getAuthenticatedUser(supabase);
    const input = await parseJsonBody(request, revokeDeviceTokenSchema);

    const data = await revokeDeviceToken(createSupabaseAdminClient(), { userId: user.id, token: input.token });
    return NextResponse.json({ data });
  });
}
