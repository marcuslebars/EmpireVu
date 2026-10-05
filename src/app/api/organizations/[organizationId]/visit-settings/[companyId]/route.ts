import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { getVisitSettings, updateVisitSettings, updateVisitSettingsSchema } from "@/server/services/visits/settings";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

/** Confirm & reschedule settings for a brand, and whether its reminders carry the link. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => NextResponse.json({ data: await getVisitSettings(ctx, context.params.companyId) }));
}

/** Owners and admins only. */
export async function PUT(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(
    context.params.organizationId,
    async (ctx) => {
      const body = updateVisitSettingsSchema.parse(await request.json().catch(() => ({})));
      return NextResponse.json({ data: await updateVisitSettings(ctx, context.params.companyId, body) });
    },
    { adminOnly: true, adminOnlyMessage: "Only owners and admins can change visit settings." },
  );
}
