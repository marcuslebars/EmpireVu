import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role) — internal onboarding funnel (Task 13).
//
// Cross-tenant: started/completed + median time-to-complete per step, over all orgs. This
// is how the "<2 hours to a working setup" gate is proven. No platform-admin session
// exists, so it's gated by the OPS_ADMIN_TOKEN bearer (same as /ops/tenant-costs).
// Service-role reads onboarding_events (member-RLS) across tenants; aggregates only.
// ─────────────────────────────────────────────────────────────────────────────
import { getOnboardingFunnel } from "@/server/services/onboarding-ops";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request): Promise<NextResponse> {
  const expected = process.env.OPS_ADMIN_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: "Ops report is not configured." }, { status: 503 });
  }
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token || !tokenMatches(token, expected)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const funnel = await getOnboardingFunnel(createSupabaseAdminClient());
  return NextResponse.json({ data: funnel });
}
