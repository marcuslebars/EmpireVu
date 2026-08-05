import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { createCheckoutSession } from "@/server/services/billing/checkout";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

const bodySchema = z.object({
  cancelUrl: z.string().url().optional(),
  plan: z.enum(["launch", "operate", "front_desk"]),
  successUrl: z.string().url().optional(),
});

/**
 * Internal (member-authenticated) route to create a Stripe Checkout session — no
 * customer-facing UI in Phase 1, this exists to drive the test-mode flow. Authz
 * is org membership via the RLS server client; the privileged billing write runs
 * on the service-role admin client inside createCheckoutSession.
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    await requireOrganizationContext(supabase, context.params.organizationId);
    const body = await parseJsonBody(request, bodySchema);

    const result = await createCheckoutSession(createSupabaseAdminClient(), {
      cancelUrl: body.cancelUrl,
      organizationId: context.params.organizationId,
      plan: body.plan,
      successUrl: body.successUrl,
    });

    return NextResponse.json({ data: result });
  });
}
