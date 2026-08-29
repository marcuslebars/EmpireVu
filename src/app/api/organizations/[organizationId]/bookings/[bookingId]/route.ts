import { NextResponse } from "next/server";
import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import {
  updateBookingStatus,
  updateBookingStatusInputSchema,
  rescheduleBooking,
  rescheduleBookingInputSchema,
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
    const ctx = {
      actorProfileId: organization.user.id,
      organizationId: organization.organizationId,
      supabase,
    };

    // Presence of scheduledFor means a reschedule; otherwise this is a status change
    // (keeps the existing status-only PATCH callers working unchanged).
    if (body.scheduledFor !== undefined) {
      const data = await rescheduleBooking(
        ctx,
        rescheduleBookingInputSchema.parse({
          bookingId: context.params.bookingId,
          scheduledFor: body.scheduledFor,
          durationMinutes: body.durationMinutes,
        }),
      );
      return NextResponse.json({ data });
    }

    const data = await updateBookingStatus(
      ctx,
      updateBookingStatusInputSchema.parse({ bookingId: context.params.bookingId, status: body.status }),
    );
    return NextResponse.json({ data });
  });
}
