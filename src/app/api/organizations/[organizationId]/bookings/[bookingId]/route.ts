import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import {
  getBookingById,
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

const patchBookingInputSchema = z.object({
  status: z.enum(["pending", "confirmed", "completed", "cancelled"]),
});

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const data = await getBookingById(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      context.params.bookingId,
    );

    return NextResponse.json({ data });
  });
}

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const input = await parseJsonBody(request, patchBookingInputSchema);
    const data = await updateBookingStatus(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      updateBookingStatusInputSchema.parse({ bookingId: context.params.bookingId, status: input.status }),
    );

    return NextResponse.json({ data });
  });
}