import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { createBillingPortalSession } from "@/server/services/billing/checkout";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

const bodySchema = z.object({
  returnUrl: z.string().url().optional(),
});

/**
 * Internal (member-authenticated) route to open a Stripe Billing Portal session.
 * Body is optional ({ returnUrl? }).
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    await requireOrganizationContext(supabase, context.params.organizationId);

    const raw = await request.json().catch(() => ({}));
    const parsed = bodySchema.safeParse(raw);
    const returnUrl = parsed.success ? parsed.data.returnUrl : undefined;

    const result = await createBillingPortalSession(createSupabaseAdminClient(), {
      organizationId: context.params.organizationId,
      returnUrl,
    });

    return NextResponse.json({ data: result });
  });
}
