import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { ValidationError } from "@/server/organizations/context";
import { csvCell, workedMinutes } from "@/server/services/time/logic";
import { listEntries } from "@/server/services/time/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/** Timesheet CSV for payroll: one row per entry, hours as decimals. */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    const url = new URL(request.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const tz = url.searchParams.get("tz") || "America/Toronto";
    if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw new ValidationError("from and to are required dates.");
    const entries = await listEntries(ctx, { from: new Date(from).toISOString(), to: new Date(to).toISOString() });
    const fmt = (iso: string | null) =>
      iso ? new Date(iso).toLocaleString("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "";
    const lines = [["Person", "Date", "Start", "End", "Break (min)", "Hours", "Job", "Notes", "Source"].join(",")];
    for (const e of [...entries].reverse()) {
      const mins = workedMinutes({ started_at: e.startedAt, ended_at: e.endedAt, break_minutes: e.breakMinutes });
      lines.push(
        [
          csvCell(e.personName),
          csvCell(new Date(e.startedAt).toLocaleDateString("en-CA", { timeZone: tz })),
          csvCell(fmt(e.startedAt)),
          csvCell(e.endedAt ? fmt(e.endedAt) : "running"),
          csvCell(e.breakMinutes),
          csvCell((mins / 60).toFixed(2)),
          csvCell(e.jobTitle),
          csvCell(e.notes),
          csvCell(e.source),
        ].join(","),
      );
    }
    return new NextResponse(lines.join("\n") + "\n", {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="timesheet-${from.slice(0, 10)}.csv"` },
    });
  });
}
