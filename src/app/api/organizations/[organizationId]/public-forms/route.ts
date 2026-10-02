import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { createPublicFormKey, listPublicFormKeys } from "@/server/services/lead-intake/public-form-keys";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

const createInputSchema = z.object({
  companyId: z.string().uuid(),
  label: z.string().max(120).nullable().optional(),
  formType: z.enum(["quote", "contact"]).optional(),
  allowedOrigins: z.array(z.string().max(300)).max(50).nullable().optional(),
});

/**
 * Website lead forms (publishable `evpk_` keys). Members can list; only owners/admins
 * create. RLS on public_form_keys enforces the same split at the database.
 */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const companyId = new URL(request.url).searchParams.get("companyId");
    const data = await listPublicFormKeys(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      { companyId },
    );
    return NextResponse.json({ data });
  });
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    if (!["owner", "admin"].includes(organization.membership.role)) {
      throw new AuthorizationError("Admin access is required to create website forms.");
    }
    const input = await parseJsonBody(request, createInputSchema);
    const data = await createPublicFormKey(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      {
        companyId: input.companyId,
        label: input.label ?? null,
        formType: input.formType,
        allowedOrigins: input.allowedOrigins ?? [],
      },
    );
    return NextResponse.json({ data });
  });
}
