import { NextResponse } from "next/server";

import { renderSiteNotFound } from "@/server/services/dfy/site-render";
import { jobsListPage } from "@/server/services/staff/recruiter/public";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

/**
 * Open jobs on a company's generated site (docs/ai-staff.md → "Hiring & payroll"). Served at
 * /s/<slug>/jobs, and at /<slug>/jobs on the PAGES_BASE_URL host (src/middleware.ts rewrites it
 * here). Only published sites with hiring on render; anything else is the neutral 404.
 */
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string };
}

const HTML = "text/html; charset=utf-8";

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const page = await jobsListPage(createSupabaseAdminClient(), context.params.slug);
    if (!page.html) return new NextResponse(renderSiteNotFound(), { status: 404, headers: { "content-type": HTML, "cache-control": "public, max-age=0, s-maxage=30", "x-robots-tag": "noindex" } });
    return new NextResponse(page.html, {
      status: page.status,
      headers: { "content-type": HTML, "cache-control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300", "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin" },
    });
  } catch (err) {
    console.error("[jobs] public list failed:", err instanceof Error ? err.message : err);
    return new NextResponse(renderSiteNotFound(), { status: 503, headers: { "content-type": HTML, "cache-control": "no-store" } });
  }
}
