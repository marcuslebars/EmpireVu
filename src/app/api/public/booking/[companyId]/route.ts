import { NextResponse } from "next/server";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import {
  createPublicBookingRequest,
  getPublicAvailability,
  publicBookingRequestSchema,
} from "@/server/services/public-booking";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    companyId: string;
  };
}

/**
 * Public, unauthenticated. The middleware matcher excludes /api/*, so no session
 * is required. The company is resolved server-side from the URL; the request can
 * never choose which org/company it touches.
 */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const data = await getPublicAvailability(context.params.companyId);
    if (!data) {
      return NextResponse.json({ error: "This booking link is not valid." }, { status: 404 });
    }
    return NextResponse.json({ data });
  });
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const input = await parseJsonBody(request, publicBookingRequestSchema);
    const data = await createPublicBookingRequest(context.params.companyId, input);
    return NextResponse.json({ data });
  });
}
