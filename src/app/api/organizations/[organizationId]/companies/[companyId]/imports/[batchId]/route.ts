/**
 * One import batch.
 *
 *   GET  …/imports/{batchId}   status, columns, preview, progress, undo report
 *   POST …/imports/{batchId}   { action: "uploaded" | "mapping" (+ mapping) | "import" | "undo" | "cancel" }
 *
 * Owner/admin only. Nothing is written to contacts / jobs / invoices until "import"; the import
 * itself (and an undo) runs in the background sweep, never in this request.
 */
import { NextResponse } from "next/server";

import { UserFacingError } from "@/server/errors";
import { handleRoute, parseJsonBody } from "@/server/api/route";
import { batchActionSchema, toBatchAction } from "@/server/services/staff/importer/actions";
import { loadBatch, runBatchAction, viewOf } from "@/server/services/staff/importer/batches";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { importGuard, type ImportRouteContext } from "../guard";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: ImportRouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { company } = await importGuard(context, true);
    const batch = await loadBatch(createSupabaseAdminClient(), company, context.params.batchId ?? "");
    if (!batch) throw new UserFacingError("That import wasn't found.", { status: 404 });
    return NextResponse.json({ data: viewOf(batch) });
  });
}

export async function POST(request: Request, context: ImportRouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { company } = await importGuard(context, true);
    const body = await parseJsonBody(request, batchActionSchema);
    const data = await runBatchAction(createSupabaseAdminClient(), company, context.params.batchId ?? "", toBatchAction(body));
    return NextResponse.json({ data });
  });
}
