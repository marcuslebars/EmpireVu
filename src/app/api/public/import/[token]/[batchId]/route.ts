/**
 * One import batch by link — /import/:token.
 *
 *   GET  /api/public/import/{token}/{batchId}   status, columns, preview, progress
 *   POST /api/public/import/{token}/{batchId}   { action: "uploaded" | "mapping" | "import" | "undo" | "cancel" }
 *
 * The token is the credential and the batch must be that token's company's. One 404 for every miss.
 */
import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { ValidationError } from "@/server/organizations/context";
import { enforceRateLimit, trustedClientIp } from "@/server/services/rate-limit";
import { batchActionSchema, toBatchAction } from "@/server/services/staff/importer/actions";
import { loadBatch, runBatchAction, viewOf } from "@/server/services/staff/importer/batches";
import { companyForToken, isImportToken } from "@/server/services/staff/importer/links";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { token: string; batchId: string };
}

const HEADERS = { "cache-control": "no-store", "x-robots-tag": "noindex" };

function notFound(): NextResponse {
  return NextResponse.json({ error: "That import wasn't found." }, { status: 404, headers: HEADERS });
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { token, batchId } = context.params;
    if (!isImportToken(token)) return notFound();
    const limited =
      (await enforceRateLimit(request, { scope: "public_import_view_ip", limit: 300, windowSeconds: 600, keyParts: [trustedClientIp(request)] })) ??
      (await enforceRateLimit(request, { scope: "public_import_view", limit: 300, windowSeconds: 600, keyParts: [token] }));
    if (limited) return limited;
    const admin = createSupabaseAdminClient();
    const company = await companyForToken(admin, token, Date.now());
    if (!company) return notFound();
    const batch = await loadBatch(admin, company, batchId);
    if (!batch) return notFound();
    return NextResponse.json({ data: viewOf(batch) }, { headers: HEADERS });
  }, request);
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { token, batchId } = context.params;
    if (!isImportToken(token)) return notFound();
    const limited =
      (await enforceRateLimit(request, { scope: "public_import_action_ip", limit: 120, windowSeconds: 3600, keyParts: [trustedClientIp(request)] })) ??
      (await enforceRateLimit(request, { scope: "public_import_action", limit: 120, windowSeconds: 3600, keyParts: [token] }));
    if (limited) return limited;
    const raw: unknown = await request.json().catch(() => {
      throw new ValidationError("Something about that didn't look right - try again.");
    });
    const parsed = batchActionSchema.safeParse(raw);
    if (!parsed.success) throw new ValidationError("Something about that didn't look right - try again.");
    const admin = createSupabaseAdminClient();
    const company = await companyForToken(admin, token, Date.now());
    if (!company) return notFound();
    const data = await runBatchAction(admin, company, batchId, toBatchAction(parsed.data));
    return NextResponse.json({ data }, { headers: HEADERS });
  }, request);
}
