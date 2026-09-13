import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { requireFeature } from "@/server/services/billing/gating";
import { sendContactMessage } from "@/server/services/inbox";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; contactId: string };
}

const sendMessageInputSchema = z.object({
  channel: z.enum(["sms", "email"]),
  body: z.string().min(1).max(20000),
  subject: z.string().max(300).optional(),
});

/**
 * Send a message to a contact from the inbox composer. Goes through deliverMessage, so
 * consent is enforced and message_log is written; a consent refusal returns a 200 with
 * status "blocked" (not an error) so the UI can explain why nothing was sent.
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const body = await parseJsonBody(request, sendMessageInputSchema);

    // SMS is a gated feature; email replies are not (mirrors the AI draft-send route).
    if (body.channel === "sms") {
      await requireFeature(supabase, organization.organizationId, "sms_sequences");
    }

    const data = await sendContactMessage(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      context.params.contactId,
      { channel: body.channel, body: body.body, subject: body.subject ?? null },
    );

    return NextResponse.json({ data });
  });
}
