/**
 * Done-for-you quick setup — /setup/:token (docs/done-for-you.md, "Intake & enrichment").
 *
 *   GET  /api/public/setup/{token}   the page's state (marks the intake opened)
 *   POST /api/public/setup/{token}   the buyer's answers (first time or an update)
 *
 * Unauthenticated: the unguessable token IS the credential, and it only ever reaches the one
 * company it was minted for. One 404 for every miss. Rate-limited per token and per IP.
 */
import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { ValidationError } from "@/server/organizations/context";
import { getSetupView, isSetupToken, submitSetupAnswers } from "@/server/services/dfy/intake";
import { enforceRateLimit, trustedClientIp } from "@/server/services/rate-limit";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { token: string };
}

const HEADERS = { "cache-control": "no-store", "x-robots-tag": "noindex" };

function notFound(): NextResponse {
  return NextResponse.json({ error: "This setup link isn't valid. Check the text we sent you, or reply to it for help." }, { status: 404, headers: HEADERS });
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const token = context.params.token;
    if (!isSetupToken(token)) return notFound();
    const limited =
      (await enforceRateLimit(request, { scope: "public_setup_view_ip", limit: 120, windowSeconds: 600, keyParts: [trustedClientIp(request)] })) ??
      (await enforceRateLimit(request, { scope: "public_setup_view", limit: 120, windowSeconds: 600, keyParts: [token] }));
    if (limited) return limited;
    const view = await getSetupView(createSupabaseAdminClient(), token);
    if (!view) return notFound();
    return NextResponse.json({ data: view }, { headers: HEADERS });
  }, request);
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const token = context.params.token;
    if (!isSetupToken(token)) return notFound();
    const limited =
      (await enforceRateLimit(request, { scope: "public_setup_submit_ip", limit: 30, windowSeconds: 3600, keyParts: [trustedClientIp(request)] })) ??
      (await enforceRateLimit(request, { scope: "public_setup_submit", limit: 20, windowSeconds: 3600, keyParts: [token] }));
    if (limited) return limited;
    const body: unknown = await request.json().catch(() => {
      throw new ValidationError("Something in the form didn't look right — check it and try again.");
    });
    const view = await submitSetupAnswers(createSupabaseAdminClient(), token, body);
    if (!view) return notFound();
    return NextResponse.json({ data: view }, { headers: HEADERS });
  }, request);
}
