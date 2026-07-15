import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { sendDraftEmail, sendDraftSms } from "@/server/services/ai-drafts";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
    contactId: string;
    draftId: string;
  };
}

const sendDraftInputSchema = z.object({
  channel: z.enum(["email", "sms"]),
});

/**
 * Send a drafted reply to the customer. This is the only path that puts an AI
 * draft in front of a real person, and it is always an explicit human action —
 * nothing in the engine calls it.
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const body = await parseJsonBody(request, sendDraftInputSchema);

    const serviceContext = {
      actorProfileId: organization.user.id,
      organizationId: organization.organizationId,
      supabase,
    };

    const data =
      body.channel === "email"
        ? await sendDraftEmail(serviceContext, context.params.draftId)
        : await sendDraftSms(serviceContext, context.params.draftId);

    return NextResponse.json({ data });
  });
}
