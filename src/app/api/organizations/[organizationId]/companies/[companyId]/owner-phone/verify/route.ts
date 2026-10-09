import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { confirmOwnerPhoneVerification, getOwnerPhoneView } from "@/server/services/owner-channel/owner-phone";
import { ownerPhoneContext } from "@/server/services/owner-channel/owner-phone-route";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

const schema = z.object({ code: z.string().min(4).max(12) }).strict();

/** The code from the text → the number becomes the verified owner phone (owners/admins). */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const ctx = await ownerPhoneContext(context.params, true);
    const body = await parseJsonBody(request, schema);
    const admin = createSupabaseAdminClient();
    const result = await confirmOwnerPhoneVerification(admin, { organizationId: ctx.organizationId, companyId: context.params.companyId, code: body.code });
    if (result.ok === false) return NextResponse.json({ error: { code: result.reason, message: result.message } }, { status: 400 });
    return NextResponse.json({ data: await getOwnerPhoneView(admin, ctx.organizationId, context.params.companyId) });
  });
}
