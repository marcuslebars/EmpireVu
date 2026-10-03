import { NextResponse } from "next/server";

import { isCheckoutSessionId } from "@/server/services/crankleads/checkout";
import { resendWelcomeEmail } from "@/server/services/crankleads/provision";
import { enforceRateLimit, trustedClientIp } from "@/server/services/rate-limit";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { sessionId: string };
}

/**
 * "Resend my login email" on the welcome page. Public (the Checkout Session id is the
 * credential); the email only ever goes to the address the buyer paid with, never to one
 * supplied here. Rate-limited per session (3/hour) and per IP.
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const headers = { "Cache-Control": "no-store" };
  const sessionId = context.params.sessionId;
  if (!isCheckoutSessionId(sessionId)) {
    return NextResponse.json({ error: "Not found." }, { status: 404, headers });
  }

  const ipLimited = await enforceRateLimit(request, {
    scope: "crankleads_resend_ip",
    limit: 10,
    windowSeconds: 3600,
    keyParts: [trustedClientIp(request)],
  });
  if (ipLimited) return ipLimited;
  const sessionLimited = await enforceRateLimit(request, {
    scope: "crankleads_resend",
    limit: 3,
    windowSeconds: 3600,
    keyParts: [sessionId],
  });
  if (sessionLimited) return sessionLimited;

  try {
    const outcome = await resendWelcomeEmail(createSupabaseAdminClient(), sessionId);
    if (outcome === "not_found") {
      return NextResponse.json({ error: "Not found." }, { status: 404, headers });
    }
    if (outcome === "not_ready") {
      return NextResponse.json({ error: "Your system is still being set up — the email goes out as soon as it's ready." }, { status: 409, headers });
    }
    return NextResponse.json({ data: { sent: true } }, { status: 200, headers });
  } catch (err) {
    console.error("[crankleads/resend] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't send the email. Please try again in a minute." }, { status: 502, headers });
  }
}
