/**
 * Live repricing — POST /api/public/quotes/{token}/reprice
 *
 * The customer ticks optional lines and the totals move. The client sends WHICH
 * options it wants, never what they cost: every amount is recomputed here from
 * the quote's stored pricing inputs. A tampered payload can change the selection
 * (which is the customer's to choose anyway) but can never change a price.
 *
 * Returns only money and the line breakdown — nothing that identifies the quote
 * beyond what the caller already holds.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute } from "@/server/api/route";
import { getQuotesConfig } from "@/server/services/quotes/config";
import { getPublicQuote, isApprovable, repriceForSelection } from "@/server/services/quotes/public-service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { token: string };
}

const bodySchema = z.object({
  // Service ids for engine lines; `custom:{index}` for hand-priced optional lines.
  selected: z.array(z.string().min(1).max(120)).max(40).default([]),
});

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    if (!getQuotesConfig().enabled) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const token = context.params.token;
    const quote = await getPublicQuote(token);
    if (!quote) return NextResponse.json({ error: "Not found." }, { status: 404 });

    // Repricing an expired, replaced or already-approved quote would show the
    // customer a number they cannot act on — and, worse, imply they still can.
    if (!isApprovable(quote.state)) {
      return NextResponse.json({ error: "This quote can no longer be changed." }, { status: 409 });
    }

    const parsed = bodySchema.parse(await request.json().catch(() => ({})));
    const pricing = await repriceForSelection(token, parsed.selected);
    if (!pricing) return NextResponse.json({ error: "Not found." }, { status: 404 });

    return NextResponse.json({
      data: {
        lineItems: pricing.lineItems,
        subtotalCents: pricing.subtotalCents,
        taxCents: pricing.taxCents,
        totalCents: pricing.totalCents,
        depositCents: pricing.depositCents,
        currency: pricing.currency,
      },
    });
  });
}
