import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { getQuotesConfig } from "@/server/services/quotes/config";
import { QuoteTransitionError } from "@/server/services/quotes/lifecycle";
import { reissueQuote } from "@/server/services/quotes/service";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; quoteId: string };
}

const bodySchema = z.object({ reason: z.string().max(500).optional() });

/**
 * Revise a quote the customer has already seen: cancel it and create a DRAFT
 * successor pre-filled from it (see reissueQuote). The customer's old link shows
 * "this quote was replaced". Returns { cancelled, successor } — edit and send the
 * successor.
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    if (!getQuotesConfig().enabled) {
      return NextResponse.json({ error: "Quotes are not enabled." }, { status: 404 });
    }
    const supabase = createSupabaseServerClient();
    const org = await requireOrganizationContext(supabase, context.params.organizationId);
    const { reason } = bodySchema.parse(await request.json().catch(() => ({})));
    try {
      const result = await reissueQuote(
        { organizationId: org.organizationId, actorProfileId: org.user.id, supabase },
        context.params.quoteId,
        { reason },
      );
      return NextResponse.json({ data: result });
    } catch (err) {
      if (err instanceof QuoteTransitionError) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      throw err;
    }
  });
}
