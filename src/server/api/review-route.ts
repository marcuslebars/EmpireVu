import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { ReviewConflictError, ReviewNotFoundError } from "@/server/services/reviews/service";
import type { TenantServiceContext } from "@/server/services/shared";
import { createSupabaseServerClient } from "@/server/supabase/server";

/** Review-request routes: org membership, tenant context, 404/409 mapping, optional owner/admin gate. */
export function reviewRoute(
  organizationId: string,
  run: (ctx: TenantServiceContext, role: string) => Promise<NextResponse>,
  options: { adminOnly?: boolean } = {},
): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, organizationId);
    const role = organization.membership.role;
    if (options.adminOnly && role !== "owner" && role !== "admin") {
      throw new AuthorizationError("Only owners and admins can change review settings.");
    }
    const ctx: TenantServiceContext = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
    try {
      return await run(ctx, role);
    } catch (error) {
      if (error instanceof ReviewConflictError) return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
      if (error instanceof ReviewNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
      throw error;
    }
  });
}
