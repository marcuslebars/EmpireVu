import type { NextResponse } from "next/server";

import { respond, unavailable } from "@/server/services/staff/service-plans/http";
import { plansListPage } from "@/server/services/staff/service-plans/public";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

/**
 * A company's service plans (docs/ai-staff.md → "Service plans"). Served at /s/<slug>/plans, and at
 * /<slug>/plans on the PAGES_BASE_URL host (src/middleware.ts rewrites it here). Only published sites
 * of done-for-you businesses with Service plans on and an active plan render; anything else is the
 * neutral 404.
 */
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string };
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    return respond(await plansListPage(createSupabaseAdminClient(), context.params.slug), "public, max-age=0, s-maxage=60, stale-while-revalidate=300");
  } catch (err) {
    console.error("[plans] public list failed:", err instanceof Error ? err.message : err);
    return unavailable();
  }
}
