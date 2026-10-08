// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): the no-login one-tap forwarding page
// (/forward/:token, docs/done-for-you.md → "Automatic switch-on"). Public: the unguessable
// dfy_progress.forward_token is the credential and resolves to exactly one company; the
// response carries only what the page shows (business name, the number to forward to, the
// code, verification state). Writes: the row's own forward_* stamps, and — after a tap — one
// automatic forwarding test (rate-limited owner-test path). GET never changes owner-visible
// state except starting that test once the owner has tapped (a scanner can't tap).
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { pollForwardPage, recordForwardAction } from "@/server/services/dfy/forwarding";
import { forwardingHelpHandler } from "@/server/services/dfy/orchestrator";
import { isForwardToken } from "@/server/services/dfy/progress";
import { enforceRateLimit } from "@/server/services/rate-limit";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { token: string };
}

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

function notFound(): NextResponse {
  return NextResponse.json({ error: "This link isn't valid." }, { status: 404, headers: HEADERS });
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const token = context.params.token;
    if (!isForwardToken(token)) return notFound();
    const limited = await enforceRateLimit(request, { scope: "dfy_forward_view", limit: 240, windowSeconds: 600, keyParts: [token] });
    if (limited) return limited;
    const view = await pollForwardPage(createSupabaseAdminClient(), token);
    return view ? NextResponse.json({ data: view }, { headers: HEADERS }) : notFound();
  });
}

const bodySchema = z.object({ action: z.enum(["opened", "tapped", "help"]) });

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const token = context.params.token;
    if (!isForwardToken(token)) return notFound();
    const limited = await enforceRateLimit(request, { scope: "dfy_forward_action", limit: 30, windowSeconds: 600, keyParts: [token] });
    if (limited) return limited;
    const body = await parseJsonBody(request, bodySchema);
    const admin = createSupabaseAdminClient();
    const view = await recordForwardAction(admin, token, body.action, { onHelpRequested: forwardingHelpHandler(admin) });
    return view ? NextResponse.json({ data: view }, { headers: HEADERS }) : notFound();
  });
}
