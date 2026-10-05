import { NextResponse } from "next/server";

import { resolveReviewClick } from "@/server/services/reviews/click";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { token: string };
}

const GONE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link expired</title></head><body style="font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#333"><h1 style="font-size:1.25rem">This link isn't available</h1><p>It may have been mistyped or is no longer active. Thanks for thinking of us!</p></body></html>`;

async function handle(request: Request, context: RouteContext): Promise<Response> {
  try {
    const target = await resolveReviewClick(context.params.token, request.headers.get("user-agent"), request.method);
    if (!target) return new NextResponse(GONE, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
    const res = NextResponse.redirect(target, 302);
    res.headers.set("cache-control", "no-store");
    res.headers.set("referrer-policy", "no-referrer");
    return res;
  } catch (err) {
    console.error("[reviews] click failed:", err instanceof Error ? err.message : err);
    return new NextResponse(GONE, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  }
}

export const GET = handle;
export const HEAD = handle;
