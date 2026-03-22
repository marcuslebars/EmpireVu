import { NextResponse } from "next/server";
import { z } from "zod";
import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import {
  updateContactStage,
  updateContactStageInputSchema,
  assignContactOwner,
  assignContactOwnerInputSchema,
} from "@/server/services/contacts";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    contactId: string;
    organizationId: string;
  };
}

const patchContactInputSchema = z.union([
  z.object({ action: z.literal("updateStage"), stage: z.enum(["lead", "qualified", "active", "closed"]) }),
  z.object({ action: z.literal("assignOwner"), ownerProfileId: z.string().uuid() }),
]);

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const body = await parseJsonBody(request, patchContactInputSchema);

    if (body.action === "updateStage") {
      const data = await updateContactStage(
        {
          actorProfileId: organization.user.id,
          organizationId: organization.organizationId,
          supabase,
        },
        updateContactStageInputSchema.parse({
          contactId: context.params.contactId,
          stage: body.stage,
        }),
      );
      return NextResponse.json({ data });
    }

    // assignOwner
    const data = await assignContactOwner(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      assignContactOwnerInputSchema.parse({
        contactId: context.params.contactId,
        ownerProfileId: body.ownerProfileId,
      }),
    );
    return NextResponse.json({ data });
  });
}
