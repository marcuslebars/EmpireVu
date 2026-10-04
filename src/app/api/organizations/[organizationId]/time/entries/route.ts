import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { parseJsonBody } from "@/server/api/route";
import { ValidationError } from "@/server/organizations/context";
import { createManualEntry, listEntries, manualEntrySchema, timesheetSummary } from "@/server/services/time/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

function window(url: URL): { from: string; to: string } {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw new ValidationError("from and to are required dates.");
  if (Date.parse(to) - Date.parse(from) > 93 * 86_400_000) throw new ValidationError("Pick a range of 3 months or less.");
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/** Time entries in a window (mine, or everyone's for owners/admins) + per-person totals. */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx, role) => {
    const url = new URL(request.url);
    const entries = await listEntries(ctx, {
      ...window(url),
      profileId: url.searchParams.get("profileId"),
      bookingId: url.searchParams.get("bookingId"),
      companyId: url.searchParams.get("companyId"),
    });
    const manager = role === "owner" || role === "admin";
    return NextResponse.json({ data: { entries, summary: await timesheetSummary(ctx, entries, manager), canSeeCosts: manager } });
  });
}

/** Log time by hand (your own; owners/admins can log for anyone). */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    const input = await parseJsonBody(request, manualEntrySchema);
    return NextResponse.json({ data: await createManualEntry(ctx, input) }, { status: 201 });
  });
}
