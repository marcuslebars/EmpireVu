/**
 * Public invoice — GET /api/public/invoices/{token}
 *
 * Unauthenticated: the unguessable token IS the credential, so this returns the
 * narrowed InvoiceDocument (no internal ids, no Stripe ids). Each customer open is
 * counted (the first marks it viewed and alerts the owner); opens by the brand's own
 * signed-in staff and by bots are not. Drafts are never exposed.
 */
import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { getPublicInvoice } from "@/server/services/invoices/public";
import { enforceRateLimit } from "@/server/services/rate-limit";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { token: string };
}

/** The signed-in EmpireVu user behind this request, if any. Best-effort: null on any doubt. */
async function signedInUserId(request: Request): Promise<string | null> {
  const cookie = request.headers.get("cookie") ?? "";
  const hasSession = /(^|;\s*)sb-[^=]*-auth-token/.test(cookie) || /^Bearer\s+\S+/i.test(request.headers.get("authorization") ?? "");
  if (!hasSession) return null;
  try {
    const { data } = await createSupabaseServerClient().auth.getUser();
    return data.user?.id ?? null;
  } catch {
    return null;
  }
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

    const invoice = await getPublicInvoice(context.params.token, {
      userId: await signedInUserId(request),
      userAgent: request.headers.get("user-agent"),
    });
    // One 404 for every miss — a public endpoint must not confirm a token exists.
    if (!invoice) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ data: invoice });
  });
}
