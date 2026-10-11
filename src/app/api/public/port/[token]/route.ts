/**
 * Keep your number — /port/:token (docs/ai-staff.md → "Keep your number").
 *
 *   GET  /api/public/port/{token}   the form's state (never the account number or PIN)
 *   POST /api/public/port/{token}   the owner's answers + typed signature → the signed LOA
 *
 * Unauthenticated: the unguessable token IS the credential, and it only ever reaches the one
 * port request it was minted for. One 404 for every miss. Rate-limited per token and per IP.
 * The request body (account number, PIN) is never logged.
 */
import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { ValidationError } from "@/server/organizations/context";
import { enforceRateLimit, trustedClientIp } from "@/server/services/rate-limit";
import { getPortView, isPortToken, submitPortForm } from "@/server/services/staff/porting/service";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { token: string };
}

const HEADERS = { "cache-control": "no-store", "x-robots-tag": "noindex" };

function notFound(): NextResponse {
  return NextResponse.json({ error: "This link isn't valid. Check the text we sent you, or reply to it for help." }, { status: 404, headers: HEADERS });
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const token = context.params.token;
    if (!isPortToken(token)) return notFound();
    const limited =
      (await enforceRateLimit(request, { scope: "public_port_view_ip", limit: 120, windowSeconds: 600, keyParts: [trustedClientIp(request)] })) ??
      (await enforceRateLimit(request, { scope: "public_port_view", limit: 120, windowSeconds: 600, keyParts: [token] }));
    if (limited) return limited;
    const view = await getPortView(createSupabaseAdminClient(), token);
    if (!view) return notFound();
    return NextResponse.json({ data: view }, { headers: HEADERS });
  }, request);
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const token = context.params.token;
    if (!isPortToken(token)) return notFound();
    const limited =
      (await enforceRateLimit(request, { scope: "public_port_submit_ip", limit: 30, windowSeconds: 3600, keyParts: [trustedClientIp(request)] })) ??
      (await enforceRateLimit(request, { scope: "public_port_submit", limit: 20, windowSeconds: 3600, keyParts: [token] }));
    if (limited) return limited;
    const body: unknown = await request.json().catch(() => {
      throw new ValidationError("Something in the form didn't look right - check it and try again.");
    });
    const view = await submitPortForm(createSupabaseAdminClient(), token, body, {
      ip: trustedClientIp(request) || null,
      userAgent: request.headers.get("user-agent"),
    });
    if (!view) return notFound();
    return NextResponse.json({ data: view }, { headers: HEADERS });
  }, request);
}
