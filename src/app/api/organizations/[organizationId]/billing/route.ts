import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

/**
 * Internal (member-authenticated) read of an org's billing state — plan, status,
 * customer link, and the latest subscription mirror. Used to verify the test-mode
 * flow. Reads go through the RLS server client (a member can read their own org).
 * Commit 6 enriches this with the per-feature gating map.
 */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    await requireOrganizationContext(supabase, context.params.organizationId);

    const { data: organization, error: orgError } = await supabase
      .from("organizations")
      .select("id, name, plan, subscription_status, stripe_customer_id, trial_ends_at")
      .eq("id", context.params.organizationId)
      .single();

    if (orgError) {
      throw orgError;
    }

    const { data: subscription, error: subError } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("organization_id", context.params.organizationId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (subError) {
      throw subError;
    }

    return NextResponse.json({ data: { organization, subscription } });
  });
}
