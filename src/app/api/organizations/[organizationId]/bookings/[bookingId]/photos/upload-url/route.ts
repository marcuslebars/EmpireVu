import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { createJobPhotoUpload, createJobPhotoUploadSchema } from "@/server/services/job-photos";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; bookingId: string };
}

/** A one-time signed upload URL for a new photo on this booking. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    // Older clients post no body at all, so an unparseable one means "mint a fresh name".
    const input = createJobPhotoUploadSchema.parse(await request.json().catch(() => ({})));
    const data = await createJobPhotoUpload(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      createSupabaseAdminClient(),
      context.params.bookingId,
      input,
    );
    return NextResponse.json({ data });
  });
}
