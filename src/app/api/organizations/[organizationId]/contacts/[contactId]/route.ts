import { NextResponse } from "next/server";
import { z } from "zod";
import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import {
  updateContactStage,
  updateContactStageInputSchema,
  assignContactOwner,
  assignContactOwnerInputSchema,
  updateContactNotes,
  updateContactNotesInputSchema,
  updateContactFields,
  updateContactFieldsInputSchema,
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
  z.object({ action: z.literal("updateNotes"), notes: z.string().max(5000).nullable() }),
  z.object({
    action: z.literal("updateContact"),
    firstName: z.string().min(1).max(100),
    lastName: z.string().max(100).nullable().optional(),
    email: z.string().email().nullable().optional(),
    phone: z.string().max(50).nullable().optional(),
  }),
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

    if (body.action === "assignOwner") {
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
    }

    if (body.action === "updateNotes") {
      const data = await updateContactNotes(
        {
          actorProfileId: organization.user.id,
          organizationId: organization.organizationId,
          supabase,
        },
        updateContactNotesInputSchema.parse({
          contactId: context.params.contactId,
          notes: body.notes,
        }),
      );
      return NextResponse.json({ data });
    }

    // updateContact (fields)
    const data = await updateContactFields(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      updateContactFieldsInputSchema.parse({
        contactId: context.params.contactId,
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
        phone: body.phone,
      }),
    );
    return NextResponse.json({ data });
  });
}
