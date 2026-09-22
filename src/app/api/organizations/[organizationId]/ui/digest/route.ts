import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { getDigestSettings, updateDigestSettings } from "@/server/services/owner-digest";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

const updateSchema = z.object({
  companyId: z.string().uuid(),
  enabled: z.boolean().optional(),
  sendAtLocal: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "sendAtLocal must be HH:MM (24h)")
    .optional(),
  channels: z.array(z.enum(["email", "sms"])).optional(),
  alwaysSend: z.boolean().optional(),
});

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const companyId = new URL(request.url).searchParams.get("companyId");
    if (!companyId) {
      return NextResponse.json({ error: "companyId is required" }, { status: 400 });
    }

    const data = await getDigestSettings(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      companyId,
    );
    return NextResponse.json({ data });
  });
}

export async function PUT(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const { companyId, ...settings } = await parseJsonBody(request, updateSchema);

    const data = await updateDigestSettings(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      companyId,
      settings,
    );
    return NextResponse.json({ data });
  });
}
