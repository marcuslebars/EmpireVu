import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { getQuotesConfig } from "@/server/services/quotes/config";
import { QuoteTransitionError } from "@/server/services/quotes/lifecycle";
import { sendQuote } from "@/server/services/quotes/service";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; quoteId: string };
}

/**
 * Move a draft to sent: allocate the customer-facing quote number, stamp sent_at and
 * valid_until. Phase 3 hangs the "quote sent" email off this.
 */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    if (!getQuotesConfig().enabled) {
      return NextResponse.json({ error: "Quotes are not enabled." }, { status: 404 });
    }

    const supabase = createSupabaseServerClient();
    const org = await requireOrganizationContext(supabase, context.params.organizationId);

    try {
      const quote = await sendQuote(
        { organizationId: org.organizationId, actorProfileId: org.user.id, supabase },
        context.params.quoteId,
      );
      return NextResponse.json({ data: quote });
    } catch (err) {
      // An illegal move is the caller's mistake, not a server fault — 409, not 500.
      if (err instanceof QuoteTransitionError) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      throw err;
    }
  });
}
