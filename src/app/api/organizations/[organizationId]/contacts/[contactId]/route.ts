import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext, ValidationError } from "@/server/organizations/context";
import {
  assignContactOwner,
  assignContactOwnerInputSchema,
  getContactById,
  updateContactStage,
  updateContactStageInputSchema,
} from "@/server/services/contacts";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    contactId: string;
    organizationId: string;
  };
}

const patchContactInputSchema = z.object({
  ownerProfileId: z.string().uuid().optional(),
  stage: z.enum(["lead", "qualified", "active", "closed"]).optional(),
});

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const data = await getContactById(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      context.params.contactId,
    );

    return NextResponse.json({ data });
  });
}

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const input = await parseJsonBody(request, patchContactInputSchema);
    const serviceContext = {
      actorProfileId: organization.user.id,
      organizationId: organization.organizationId,
      supabase,
    };

    if (input.stage && input.ownerProfileId) {
      throw new ValidationError("PATCH contact accepts either stage or ownerProfileId, not both.");
    }

    if (input.stage) {
      const data = await updateContactStage(
        serviceContext,
        updateContactStageInputSchema.parse({ contactId: context.params.contactId, stage: input.stage }),
      );

      return NextResponse.json({ data });
    }

    if (input.ownerProfileId) {
      const data = await assignContactOwner(
        serviceContext,
        assignContactOwnerInputSchema.parse({
          contactId: context.params.contactId,
          ownerProfileId: input.ownerProfileId,
        }),
      );

      return NextResponse.json({ data });
    }

    throw new ValidationError("PATCH contact requires stage or ownerProfileId.");
  });
}