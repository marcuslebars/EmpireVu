import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { sendTestDigest } from "@/server/services/owner-digest";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

const testSchema = z.object({ companyId: z.string().uuid() });

// "Send me a test digest now" — sends immediately regardless of schedule/quiet gating and
// does NOT consume the day's idempotency slot, so the real morning send still fires.
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const { companyId } = await parseJsonBody(request, testSchema);

    const data = await sendTestDigest(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      companyId,
    );
    return NextResponse.json({ data });
  });
}
