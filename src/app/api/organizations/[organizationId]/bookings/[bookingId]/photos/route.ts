import { NextResponse } from "next/server";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { listJobPhotos, recordJobPhoto, recordJobPhotoSchema } from "@/server/services/job-photos";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; bookingId: string };
}

/** Photos for a booking, each with a signed read URL valid for an hour. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const data = await listJobPhotos(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      createSupabaseAdminClient(),
      context.params.bookingId,
    );
    return NextResponse.json({ data });
  });
}

/** Record a photo already uploaded to its signed URL. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const input = await parseJsonBody(request, recordJobPhotoSchema);
    const data = await recordJobPhoto(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      context.params.bookingId,
      input,
    );
    return NextResponse.json({ data }, { status: 201 });
  });
}
