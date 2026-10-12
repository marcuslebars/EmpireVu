/**
 * Import customers (docs/ai-staff.md → "Customer import").
 *
 *   GET  …/imports   the overview: setting, recent imports, balances on hold (members read)
 *   POST …/imports   { fileName, fileSize, contentType? } → a new batch + a one-time signed upload
 *                    URL for the private customer-imports bucket (owner/admin)
 */
import { NextResponse } from "next/server";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { createBatchSchema } from "@/server/services/staff/importer/actions";
import { createBatch } from "@/server/services/staff/importer/batches";
import { overviewFor } from "@/server/services/staff/importer/view";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { importGuard, type ImportRouteContext } from "./guard";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: ImportRouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { company } = await importGuard(context, false);
    return NextResponse.json({ data: await overviewFor(createSupabaseAdminClient(), company) });
  });
}

export async function POST(request: Request, context: ImportRouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { company, actorId } = await importGuard(context, true);
    const body = await parseJsonBody(request, createBatchSchema);
    const data = await createBatch(createSupabaseAdminClient(), company, { fileName: String(body.fileName), fileSize: Number(body.fileSize), contentType: body.contentType ?? null, source: "app", createdBy: actorId });
    return NextResponse.json({ data }, { status: 201 });
  });
}
