/**
 * Public quote — GET /api/public/quotes/{token}
 *
 * Unauthenticated: the unguessable token IS the credential, so this returns a
 * NARROWED shape (see PublicQuote) — never the raw row. No internal ids, no
 * Stripe ids, no org internals reach the page.
 *
 * A first open of a `sent` quote transitions it to `viewed` (idempotently).
 */
import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { getQuotesConfig } from "@/server/services/quotes/config";
import { getPublicQuote } from "@/server/services/quotes/public-service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { token: string };
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    if (!getQuotesConfig().enabled) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const quote = await getPublicQuote(context.params.token);
    // Same 404 for "no such token" and "feature off" — a public endpoint should
    // not confirm that a token exists to someone guessing.
    if (!quote) return NextResponse.json({ error: "Not found." }, { status: 404 });

    return NextResponse.json({ data: quote });
  });
}
