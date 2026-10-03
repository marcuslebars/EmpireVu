import { NextResponse } from "next/server";

import { getPublicPurchaseStatus, isCheckoutSessionId } from "@/server/services/crankleads/checkout";
import { enforceRateLimit, trustedClientIp } from "@/server/services/rate-limit";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { sessionId: string };
}

/**
 * Welcome-page poll (/welcome/crankleads?session_id=…). Public: the Checkout Session id
 * Stripe put in the success URL is the credential. Returns ONLY
 * `{ status, businessName, emailMasked }` — no ids, no phone, no full email.
 * Same-origin (the app's own page), so no CORS.
 */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  const headers = { "Cache-Control": "no-store" };
  const limited = await enforceRateLimit(request, {
    scope: "crankleads_status",
    limit: 120,
    windowSeconds: 600,
    keyParts: [trustedClientIp(request)],
  });
  if (limited) return limited;

  const sessionId = context.params.sessionId;
  if (!isCheckoutSessionId(sessionId)) {
    return NextResponse.json({ error: "Not found." }, { status: 404, headers });
  }

  try {
    const view = await getPublicPurchaseStatus(createSupabaseAdminClient(), sessionId);
    if (!view) {
      return NextResponse.json({ error: "Not found." }, { status: 404, headers });
    }
    return NextResponse.json({ data: view }, { status: 200, headers });
  } catch (err) {
    console.error("[crankleads/status] lookup failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't check your setup. Please refresh." }, { status: 500, headers });
  }
}
