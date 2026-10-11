import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { ValidationError } from "@/server/organizations/context";
import { enRouteSchema, getJobSheet, markEnRoute } from "@/server/services/crew/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; bookingId: string };
}

/** Optional body { etaMinutes } — an empty body is fine (older clients send none). */
async function readEta(request: Request): Promise<number | null> {
  const raw = await request.text().catch(() => "");
  if (!raw.trim()) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ValidationError("Invalid JSON body.");
  }
  const parsed = enRouteSchema.safeParse(json);
  if (!parsed.success) throw new ValidationError("ETA must be between 1 and 240 minutes.");
  return parsed.data.etaMinutes ?? null;
}

/** "On my way" (optionally with an ETA) — fires the customer heads-up (once per job). */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    const etaMinutes = await readEta(request);
    await markEnRoute(ctx, context.params.bookingId, { etaMinutes });
    return NextResponse.json({ data: await getJobSheet(ctx, context.params.bookingId) });
  });
}
