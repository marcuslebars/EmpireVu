import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { ChecklistIncompleteError, CrewNotFoundError } from "@/server/services/crew/service";
import type { TenantServiceContext } from "@/server/services/shared";
import { createSupabaseServerClient } from "@/server/supabase/server";

/**
 * Shared wrapper for the crew-dispatch routes: org membership, the tenant context,
 * and the crew-specific errors (404 not found, 409 checklist still open).
 */
export function crewRoute(
  organizationId: string,
  run: (ctx: TenantServiceContext, role: string) => Promise<NextResponse>,
  options: { adminOnly?: boolean } = {},
): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, organizationId);
    const role = organization.membership.role;
    if (options.adminOnly && role !== "owner" && role !== "admin") {
      throw new AuthorizationError("Only owners and admins can change checklists.");
    }
    const ctx: TenantServiceContext = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
    try {
      return await run(ctx, role);
    } catch (error) {
      if (error instanceof ChecklistIncompleteError) {
        return NextResponse.json({ error: error.message, code: "checklist_incomplete", openItems: error.openItems }, { status: 409 });
      }
      if (error instanceof CrewNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
      throw error;
    }
  });
}
