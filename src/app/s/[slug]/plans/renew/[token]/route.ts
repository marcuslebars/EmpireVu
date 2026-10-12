import type { NextResponse } from "next/server";

import { enforceRateLimit, trustedClientIp } from "@/server/services/rate-limit";
import { respond, unavailable } from "@/server/services/staff/service-plans/http";
import { renewalPage, renewFromPage } from "@/server/services/staff/service-plans/public";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

/**
 * A customer's own renewal page (docs/ai-staff.md → "Service plans"), texted with the renewal link.
 * The token (32 hex, one per agreement) is the credential; one neutral 404 for every miss. POST:
 * annual → 303 to Stripe Checkout for the next year's invoice (or its invoice page); per visit →
 * renewed. Rate-limited per IP and per token.
 */
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string; token: string };
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const paid = new URL(request.url).searchParams.get("paid") === "1";
    return respond(await renewalPage(createSupabaseAdminClient(), context.params.slug, context.params.token, { paid }), "no-store");
  } catch (err) {
    console.error("[plans] renewal page failed:", err instanceof Error ? err.message : err);
    return unavailable();
  }
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const admin = createSupabaseAdminClient();
  const { slug, token } = context.params;
  try {
    const limited =
      (await enforceRateLimit(request, { scope: "plan_renew_ip", limit: 20, windowSeconds: 3600, keyParts: [trustedClientIp(request)] })) ??
      (await enforceRateLimit(request, { scope: "plan_renew_token", limit: 10, windowSeconds: 3600, keyParts: [token] }));
    if (limited) return limited as NextResponse;
    return respond(await renewFromPage(admin, { slug, token, nowMs: Date.now() }), "no-store");
  } catch (err) {
    console.error("[plans] renewal failed:", err instanceof Error ? err.message : err);
    return unavailable();
  }
}
