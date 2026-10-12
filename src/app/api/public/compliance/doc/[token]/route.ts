/**
 * A certificate link sent to a customer / GC (share_compliance_doc) — our own redirect, so the
 * owner can turn it off and every open is recorded (docs/ai-staff.md → "Compliance").
 *
 *   GET /api/public/compliance/doc/{token}
 *     live    → the open is logged (IP, browser) and the visitor is redirected to a 60-second
 *               signed URL for that one file in the private bucket
 *     revoked / expired / Compliance off → 410 "This link has expired"; unknown → 404
 *
 * Unauthenticated: the token is the credential. Rate-limited per token and IP. Never cached.
 */
import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { enforceRateLimit, trustedClientIp } from "@/server/services/rate-limit";
import { openShare } from "@/server/services/staff/compliance/shares";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { token: string };
}

const HEADERS = { "cache-control": "no-store", "x-robots-tag": "noindex", "referrer-policy": "no-referrer" };

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function gonePage(status: 404 | 410, businessName: string | null): NextResponse {
  const who = businessName ? esc(businessName) : "the business";
  const text = status === 410 ? `This link has expired or was turned off. Ask ${who} for a new one.` : "This link isn't valid.";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Link not available</title></head><body style="font-family:system-ui,-apple-system,sans-serif;margin:0;padding:48px 16px;background:#f7f7f5;color:#1f2933"><main style="max-width:420px;margin:0 auto;text-align:center"><h1 style="font-size:20px;margin:0 0 12px">Link not available</h1><p style="font-size:15px;line-height:1.5;margin:0">${text}</p></main></body></html>`;
  return new NextResponse(html, { status, headers: { ...HEADERS, "content-type": "text/html; charset=utf-8" } });
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const token = context.params.token;
    const limited =
      (await enforceRateLimit(request, { scope: "public_compliance_doc_ip", limit: 120, windowSeconds: 3600, keyParts: [trustedClientIp(request)] })) ??
      (await enforceRateLimit(request, { scope: "public_compliance_doc", limit: 30, windowSeconds: 3600, keyParts: [token] }));
    if (limited) return limited;
    const result = await openShare(createSupabaseAdminClient(), token, { ip: trustedClientIp(request) || null, userAgent: request.headers.get("user-agent") });
    if (!result.ok || !result.url) return gonePage(result.status ?? 404, result.businessName ?? null);
    return NextResponse.redirect(result.url, { status: 302, headers: HEADERS });
  }, request);
}
