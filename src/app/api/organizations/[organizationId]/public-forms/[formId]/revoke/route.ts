import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { revokePublicFormKey } from "@/server/services/lead-intake/public-form-keys";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; formId: string };
}

/** Turn a website form off. The hosted link and every embed stop accepting leads. */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    if (!["owner", "admin"].includes(organization.membership.role)) {
      throw new AuthorizationError("Admin access is required to turn off website forms.");
    }
    await revokePublicFormKey(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      context.params.formId,
    );
    return NextResponse.json({ data: { ok: true } });
  });
}
