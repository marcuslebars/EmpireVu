import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { getOnlineBookingSettings, updateOnlineBookingSettings, updateOnlineBookingSettingsSchema } from "@/server/services/scheduling/settings";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

/** The brand's online booking settings and booking page link. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => NextResponse.json({ data: await getOnlineBookingSettings(ctx, context.params.companyId) }));
}

/** Owners and admins only. */
export async function PUT(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(
    context.params.organizationId,
    async (ctx) => {
      const body = updateOnlineBookingSettingsSchema.parse(await request.json().catch(() => ({})));
      return NextResponse.json({ data: await updateOnlineBookingSettings(ctx, context.params.companyId, body) });
    },
    { adminOnly: true, adminOnlyMessage: "Only owners and admins can change online booking." },
  );
}
