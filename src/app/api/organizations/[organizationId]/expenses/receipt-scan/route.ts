import { NextResponse } from "next/server";
import { z } from "zod";

import { ReceiptReadingUnavailableError, readReceipt } from "@/server/ai/receipt-reader";
import { crewRoute } from "@/server/api/crew-route";
import { parseJsonBody } from "@/server/api/route";
import { getBusinessTimezone } from "@/server/services/ai";
import { downloadReceipt } from "@/server/services/expenses/receipts";
import { enforceRateLimit } from "@/server/services/rate-limit";
import { recordAiUsageSafe } from "@/server/services/usage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface RouteContext {
  params: { organizationId: string };
}

const bodySchema = z.object({ path: z.string().max(512) });

/**
 * Read an uploaded receipt with AI and return suggested details (vendor, date, total,
 * tax, category). Nothing is saved here — the form shows them for the person to confirm.
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    const body = await parseJsonBody(request, bodySchema);
    const limited = await enforceRateLimit(request, {
      scope: "expense_receipt_scan",
      limit: 60,
      windowSeconds: 3600,
      keyParts: [ctx.organizationId, ctx.actorProfileId],
      logContext: { organizationId: ctx.organizationId },
    });
    if (limited) return limited;

    const file = await downloadReceipt(ctx.organizationId, body.path);
    const today = new Date().toLocaleDateString("en-CA", { timeZone: getBusinessTimezone() });
    try {
      const { scan, usage } = await readReceipt(file, today);
      await recordAiUsageSafe({ organizationId: ctx.organizationId, companyId: null, model: usage.model, responseId: usage.responseId, usage: usage.usage });
      return NextResponse.json({ data: scan });
    } catch (err) {
      if (err instanceof ReceiptReadingUnavailableError) return NextResponse.json({ error: err.message, code: "ai_unavailable" }, { status: 503 });
      console.error("[expenses] receipt reading failed:", err instanceof Error ? err.message : err);
      return NextResponse.json({ error: "Couldn't read that receipt — fill the details in by hand.", code: "scan_failed" }, { status: 502 });
    }
  });
}
