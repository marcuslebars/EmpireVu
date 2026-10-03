import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { AuthorizationError, requireOrganizationContext, ValidationError } from "@/server/organizations/context";
import { getForwardingVerificationStatus, startOwnerForwardingTest } from "@/server/services/twilio/forwarding-test";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/**
 * Forwarding verification state for a company's catcher number + its latest test (the
 * wizard polls this while a test runs). Org members (RLS reads).
 */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const companyId = new URL(request.url).searchParams.get("companyId");
    if (!companyId || !z.string().uuid().safeParse(companyId).success) {
      throw new ValidationError("companyId is required.");
    }
    const data = await getForwardingVerificationStatus(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      companyId,
    );
    return NextResponse.json({ data });
  });
}

const bodySchema = z.object({ companyId: z.string().uuid() });

/**
 * "Test my forwarding": place a test call to the company's own stored business line from
 * the catcher number (or the platform verifier). Owner/admin only (it places a billed call);
 * rate-limited per company (1 per 2 min, 10 per 24 h → 429); only 08:00–21:00 company time.
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    if (!["owner", "admin"].includes(organization.membership.role)) {
      throw new AuthorizationError("Admin access is required to run a forwarding test.");
    }
    const body = await parseJsonBody(request, bodySchema);
    const data = await startOwnerForwardingTest(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      body.companyId,
    );
    return NextResponse.json({ data }, { status: 201 });
  });
}
