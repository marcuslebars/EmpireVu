import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { getOwnerPhoneView, startOwnerPhoneVerification } from "@/server/services/owner-channel/owner-phone";
import { ownerPhoneContext } from "@/server/services/owner-channel/owner-phone-route";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const ctx = await ownerPhoneContext(context.params, false);
    const view = await getOwnerPhoneView(createSupabaseAdminClient(), ctx.organizationId, context.params.companyId);
    return NextResponse.json({ data: { ...view, canManage: ctx.role === "owner" || ctx.role === "admin" } });
  });
}

const startSchema = z.object({ phone: z.string().min(7).max(40) }).strict();

/** Text a code to the number the owner wants to use. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const ctx = await ownerPhoneContext(context.params, true);
    const body = await parseJsonBody(request, startSchema);
    const admin = createSupabaseAdminClient();
    const { data: org } = await admin.from("organizations").select("platform_brand").eq("id", ctx.organizationId).maybeSingle();
    const result = await startOwnerPhoneVerification(admin, {
      organizationId: ctx.organizationId,
      companyId: context.params.companyId,
      phone: body.phone,
      requestedBy: ctx.actorProfileId,
      platformBrand: (org as { platform_brand: string | null } | null)?.platform_brand ?? null,
    });
    if (result.ok === false) return NextResponse.json({ error: { code: result.reason, message: result.message } }, { status: result.reason === "rate_limited" ? 429 : 400 });
    return NextResponse.json({ data: await getOwnerPhoneView(admin, ctx.organizationId, context.params.companyId) });
  });
}
