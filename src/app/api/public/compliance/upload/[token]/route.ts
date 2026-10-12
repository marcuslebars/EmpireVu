/**
 * A sub's upload link — /compliance/upload/:token (docs/ai-staff.md → "Compliance").
 *
 *   GET  /api/public/compliance/upload/{token}   what's asked for, what's been sent
 *   POST { action: "upload_url", contentType }     a one-time signed upload URL; the server builds
 *                                                  the path ({org}/{company}/sub-{request}-{uuid})
 *   POST { action: "submit", path, contentType, kind? }  read + file it under that sub, tell the owner
 *
 * Unauthenticated: the unguessable token IS the credential and only reaches the one request it
 * was minted for; it dies after 14 days. One 404 for every miss. Rate-limited per token and IP.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { enforceRateLimit, trustedClientIp } from "@/server/services/rate-limit";
import { createSubUploadUrl, getUploadPageView, isLinkToken, submitSubUpload } from "@/server/services/staff/compliance/requests";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { token: string };
}

const HEADERS = { "cache-control": "no-store", "x-robots-tag": "noindex" };

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("upload_url"), contentType: z.string().max(60) }).strict(),
  z.object({ action: z.literal("submit"), path: z.string().max(300), contentType: z.string().max(60), kind: z.string().max(40).nullable().optional() }).strict(),
]);

function notFound(): NextResponse {
  return NextResponse.json({ error: "This link isn't valid any more. Reply to the text you got and ask for a new one." }, { status: 404, headers: HEADERS });
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const token = context.params.token;
    if (!isLinkToken(token)) return notFound();
    const limited =
      (await enforceRateLimit(request, { scope: "public_compliance_view_ip", limit: 120, windowSeconds: 600, keyParts: [trustedClientIp(request)] })) ??
      (await enforceRateLimit(request, { scope: "public_compliance_view", limit: 120, windowSeconds: 600, keyParts: [token] }));
    if (limited) return limited;
    const view = await getUploadPageView(createSupabaseAdminClient(), token);
    if (!view) return notFound();
    return NextResponse.json({ data: view }, { headers: HEADERS });
  }, request);
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const token = context.params.token;
    if (!isLinkToken(token)) return notFound();
    const limited =
      (await enforceRateLimit(request, { scope: "public_compliance_upload_ip", limit: 30, windowSeconds: 3600, keyParts: [trustedClientIp(request)] })) ??
      (await enforceRateLimit(request, { scope: "public_compliance_upload", limit: 30, windowSeconds: 3600, keyParts: [token] }));
    if (limited) return limited;
    const body = await parseJsonBody(request, bodySchema);
    const admin = createSupabaseAdminClient();
    if (body.action === "upload_url") {
      const upload = await createSubUploadUrl(admin, token, body.contentType);
      if (!upload) return notFound();
      return NextResponse.json({ data: upload }, { headers: HEADERS });
    }
    const result = await submitSubUpload(admin, token, { path: body.path, contentType: body.contentType, kind: body.kind ?? null }, {
      ip: trustedClientIp(request) || null,
      userAgent: request.headers.get("user-agent"),
    });
    if (!result) return notFound();
    return NextResponse.json({ data: result }, { headers: HEADERS });
  }, request);
}
