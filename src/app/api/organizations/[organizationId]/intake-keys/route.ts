import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { createIntakeKey, listIntakeKeys } from "@/server/services/lead-intake/intake-keys";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

const createInputSchema = z.object({
  companyId: z.string().uuid().nullable().optional(),
  label: z.string().max(120).nullable().optional(),
});

/** Members can list keys; only owners/admins may create/revoke them. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const data = await listIntakeKeys({
      actorProfileId: organization.user.id,
      organizationId: organization.organizationId,
      supabase,
    });
    return NextResponse.json({ data });
  });
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    if (!["owner", "admin"].includes(organization.membership.role)) {
      throw new AuthorizationError("Admin access is required to create intake keys.");
    }
    const input = await parseJsonBody(request, createInputSchema);

    // Returns the FULL key once — the UI must show it now; it is never retrievable again.
    const data = await createIntakeKey(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      { companyId: input.companyId ?? null, label: input.label ?? null },
    );
    return NextResponse.json({ data });
  });
}
