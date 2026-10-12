/**
 * Customer import by link — /import/:token (docs/ai-staff.md → "Customer import"). The owner was
 * texted the link (owner tool send_import_link, Settings, or the concierge).
 *
 *   GET  /api/public/import/{token}   business name + recent imports
 *   POST /api/public/import/{token}   { fileName, fileSize, contentType? } → batch + signed upload URL
 *
 * Unauthenticated: the unguessable token IS the credential, and it only ever reaches the one
 * company it was minted for. One 404 for every miss (bad / unknown / expired token, import off).
 * Rate-limited per token and per IP.
 */
import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { ValidationError } from "@/server/organizations/context";
import { enforceRateLimit, trustedClientIp } from "@/server/services/rate-limit";
import { createBatchSchema } from "@/server/services/staff/importer/actions";
import { createBatch, listBatches } from "@/server/services/staff/importer/batches";
import { companyForToken, isImportToken } from "@/server/services/staff/importer/links";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { token: string };
}

const HEADERS = { "cache-control": "no-store", "x-robots-tag": "noindex" };

function notFound(): NextResponse {
  return NextResponse.json({ error: "This import link isn't valid any more. Text us \"import\" and we'll send a fresh one." }, { status: 404, headers: HEADERS });
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const token = context.params.token;
    if (!isImportToken(token)) return notFound();
    const limited =
      (await enforceRateLimit(request, { scope: "public_import_view_ip", limit: 300, windowSeconds: 600, keyParts: [trustedClientIp(request)] })) ??
      (await enforceRateLimit(request, { scope: "public_import_view", limit: 300, windowSeconds: 600, keyParts: [token] }));
    if (limited) return limited;
    const admin = createSupabaseAdminClient();
    const company = await companyForToken(admin, token, Date.now());
    if (!company) return notFound();
    const batches = await listBatches(admin, company, 5);
    return NextResponse.json({ data: { businessName: company.name, platformBrand: company.platformBrand, batches } }, { headers: HEADERS });
  }, request);
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const token = context.params.token;
    if (!isImportToken(token)) return notFound();
    const limited =
      (await enforceRateLimit(request, { scope: "public_import_upload_ip", limit: 30, windowSeconds: 3600, keyParts: [trustedClientIp(request)] })) ??
      (await enforceRateLimit(request, { scope: "public_import_upload", limit: 20, windowSeconds: 3600, keyParts: [token] }));
    if (limited) return limited;
    const raw: unknown = await request.json().catch(() => {
      throw new ValidationError("Something about that upload didn't look right - try again.");
    });
    const parsed = createBatchSchema.safeParse(raw);
    if (!parsed.success) throw new ValidationError("Something about that upload didn't look right - try again.");
    const admin = createSupabaseAdminClient();
    const company = await companyForToken(admin, token, Date.now());
    if (!company) return notFound();
    const data = await createBatch(admin, company, { fileName: String(parsed.data.fileName), fileSize: Number(parsed.data.fileSize), contentType: parsed.data.contentType ?? null, source: "link", createdBy: null });
    return NextResponse.json({ data }, { status: 201, headers: HEADERS });
  }, request);
}
