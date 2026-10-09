/**
 * Email open tracking — GET /api/public/invoices/{token}/open?e=invoice|reminder-N
 *
 * The 1×1 image in the invoice and reminder emails. Always answers with the same
 * transparent GIF (a miss must not confirm whether a token exists) and never caches,
 * so each real open reaches us. Recording is best-effort and never fails the image.
 */
import { NextResponse } from "next/server";

import { parseEmailKind, TRANSPARENT_GIF } from "@/server/services/invoices/opens";
import { recordEmailOpen } from "@/server/services/invoices/public";
import { enforceRateLimit } from "@/server/services/rate-limit";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { token: string };
}

function gif(): NextResponse {
  return new NextResponse(new Uint8Array(TRANSPARENT_GIF), {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(TRANSPARENT_GIF.length),
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      Pragma: "no-cache",
    },
  });
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const kind = parseEmailKind(new URL(request.url).searchParams.get("e"));
    if (!kind) return gif();
    const limited = await enforceRateLimit(request, {
      scope: "public_invoice_email_open",
      limit: 60,
      windowSeconds: 600,
      keyParts: [context.params.token],
    });
    if (limited) return gif();
    await recordEmailOpen(context.params.token, kind, request.headers.get("user-agent"));
  } catch (err) {
    console.error("[invoices] email open route:", err instanceof Error ? err.message : err);
  }
  return gif();
}
