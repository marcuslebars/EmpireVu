/**
 * Public invoice — GET /api/public/invoices/{token}
 *
 * Unauthenticated: the unguessable token IS the credential, so this returns the
 * narrowed InvoiceDocument (no internal ids, no Stripe ids). The first open of a
 * sent invoice marks it viewed. Drafts are never exposed.
 */
import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { getPublicInvoice } from "@/server/services/invoices/public";
import { enforceRateLimit } from "@/server/services/rate-limit";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { token: string };
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const limited = await enforceRateLimit(request, {
      scope: "public_invoice_view",
      limit: 120,
      windowSeconds: 600,
      keyParts: [context.params.token],
    });
    if (limited) return limited;

    const invoice = await getPublicInvoice(context.params.token);
    // One 404 for every miss — a public endpoint must not confirm a token exists.
    if (!invoice) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ data: invoice });
  });
}
