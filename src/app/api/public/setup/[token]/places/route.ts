/**
 * GET /api/public/setup/{token}/places?q=… — "Find your business" on the quick-setup page.
 * A proxy to Google Places Text Search (the API key never reaches the browser). Only names +
 * addresses come back. Valid setup token required; rate-limited per token and per IP.
 * Without GOOGLE_PLACES_API_KEY it answers { enabled: false } and the page offers the website
 * / no-website paths instead.
 */
import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { findIntakeByToken, isSetupToken } from "@/server/services/dfy/intake";
import { isPlacesConfigured, searchPlaces } from "@/server/services/dfy/places";
import { enforceRateLimit, trustedClientIp } from "@/server/services/rate-limit";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { token: string };
}

const HEADERS = { "cache-control": "no-store", "x-robots-tag": "noindex" };

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const token = context.params.token;
    if (!isSetupToken(token)) return NextResponse.json({ error: "Not found." }, { status: 404, headers: HEADERS });
    const limited =
      (await enforceRateLimit(request, { scope: "public_setup_places_ip", limit: 120, windowSeconds: 3600, keyParts: [trustedClientIp(request)] })) ??
      (await enforceRateLimit(request, { scope: "public_setup_places", limit: 60, windowSeconds: 3600, keyParts: [token] }));
    if (limited) return limited;
    const intake = await findIntakeByToken(createSupabaseAdminClient(), token, Date.now());
    if (!intake) return NextResponse.json({ error: "Not found." }, { status: 404, headers: HEADERS });

    const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 120);
    if (!isPlacesConfigured()) return NextResponse.json({ data: { enabled: false, results: [] } }, { headers: HEADERS });
    if (q.length < 2) return NextResponse.json({ data: { enabled: true, results: [] } }, { headers: HEADERS });
    try {
      const results = await searchPlaces(q);
      return NextResponse.json({ data: { enabled: true, results } }, { headers: HEADERS });
    } catch (err) {
      console.error("[setup/places] search failed:", err instanceof Error ? err.message : err);
      return NextResponse.json(
        { error: "Google search isn't working right now — paste your website instead, or pick “No website”." },
        { status: 502, headers: HEADERS },
      );
    }
  }, request);
}
