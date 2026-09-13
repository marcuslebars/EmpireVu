import { NextResponse } from "next/server";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import {
  getNotificationPreferences,
  updateNotificationPreferences,
  updateNotificationPreferencesSchema,
} from "@/server/services/notification-preferences";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/** The signed-in user's push preferences for this organization (defaults when unset). */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const data = await getNotificationPreferences(supabase, organization.user.id, organization.organizationId);
    return NextResponse.json({ data });
  });
}

export async function PUT(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const input = await parseJsonBody(request, updateNotificationPreferencesSchema);
    const data = await updateNotificationPreferences(supabase, organization.user.id, organization.organizationId, input);
    return NextResponse.json({ data });
  });
}
