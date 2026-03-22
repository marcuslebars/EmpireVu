import { NextResponse } from "next/server";
import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import {
  updateBookingStatus,
  updateBookingStatusInputSchema,
} from "@/server/services/bookings";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    bookingId: string;
    organizationId: string;
  };
}

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const body = await request.json();
    const input = updateBookingStatusInputSchema.parse({ bookingId: context.params.bookingId, status: body.status });
    const data = await updateBookingStatus(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      input,
    );
    return NextResponse.json({ data });
  });
}
