import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { callNumberWithMarina } from "@/server/services/voice";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

const quickCallInputSchema = z.object({
  phone: z.string().min(1).max(40),
  name: z.string().max(120).optional(),
});

/**
 * Place an ad-hoc voice call to a raw phone number with Marina — no contact
 * record needed. The owner-facing "Quick call" for dialing a lead on the spot.
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const body = await parseJsonBody(request, quickCallInputSchema);

    const result = await callNumberWithMarina(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      { toNumber: body.phone, name: body.name },
    );

    return NextResponse.json({ data: result });
  });
}
