import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { enforceRateLimit } from "@/server/services/rate-limit";
import { VisitConflictError, VisitNotFoundError } from "@/server/services/visits/public";

/**
 * The public visit routes (/api/public/visits/{token}/…): rate-limited per token + caller,
 * one 404 for every miss, 409 when the visit can't be changed (or the time was taken).
 */
export function visitPublicRoute(
  request: Request,
  token: string,
  limit: { scope: string; limit: number; windowSeconds: number },
  run: () => Promise<NextResponse>,
): Promise<NextResponse> {
  return handleRoute(async () => {
    const limited = await enforceRateLimit(request, { ...limit, keyParts: [token] });
    if (limited) return limited;
    try {
      const res = await run();
      res.headers.set("cache-control", "no-store");
      res.headers.set("x-robots-tag", "noindex");
      return res;
    } catch (error) {
      if (error instanceof VisitNotFoundError) return NextResponse.json({ error: "Not found." }, { status: 404 });
      if (error instanceof VisitConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
      throw error;
    }
  });
}
