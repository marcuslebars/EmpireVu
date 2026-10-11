/**
 * Keep your number — a one-time signed upload URL for the phone bill (private bucket
 * `porting-docs`, this request's folder only). POST { contentType } → { path, token, bucket };
 * the page uploads straight to storage, then sends `billPath` with the form.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { enforceRateLimit, trustedClientIp } from "@/server/services/rate-limit";
import { createBillUpload, isPortToken } from "@/server/services/staff/porting/service";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { token: string };
}

const HEADERS = { "cache-control": "no-store", "x-robots-tag": "noindex" };
const bodySchema = z.object({ contentType: z.string().max(60) }).strict();

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const token = context.params.token;
    const notFound = () => NextResponse.json({ error: "This link isn't valid." }, { status: 404, headers: HEADERS });
    if (!isPortToken(token)) return notFound();
    const limited =
      (await enforceRateLimit(request, { scope: "public_port_upload_ip", limit: 30, windowSeconds: 3600, keyParts: [trustedClientIp(request)] })) ??
      (await enforceRateLimit(request, { scope: "public_port_upload", limit: 20, windowSeconds: 3600, keyParts: [token] }));
    if (limited) return limited;
    const body = await parseJsonBody(request, bodySchema);
    const upload = await createBillUpload(createSupabaseAdminClient(), token, body.contentType);
    if (!upload) return notFound();
    return NextResponse.json({ data: upload }, { headers: HEADERS });
  }, request);
}
