import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { updatePublicFormKey } from "@/server/services/lead-intake/public-form-keys";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; formId: string };
}

const updateInputSchema = z.object({
  label: z.string().max(120).nullable().optional(),
  formType: z.enum(["quote", "contact"]).optional(),
  allowedOrigins: z.array(z.string().max(300)).max(50).nullable().optional(),
});

/** Edit a website form's label / form type / allowed websites (owners/admins). */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    if (!["owner", "admin"].includes(organization.membership.role)) {
      throw new AuthorizationError("Admin access is required to edit website forms.");
    }
    const input = await parseJsonBody(request, updateInputSchema);
    const data = await updatePublicFormKey(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      context.params.formId,
      {
        label: input.label,
        formType: input.formType,
        allowedOrigins: input.allowedOrigins === null ? [] : input.allowedOrigins,
      },
    );
    return NextResponse.json({ data });
  });
}
