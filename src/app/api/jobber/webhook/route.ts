import { NextResponse } from "next/server";

import { getJobberConfig } from "@/server/services/jobber/config";
import { verifyJobberWebhook } from "@/server/services/jobber/hmac";
import { handleJobberWebhook } from "@/server/services/jobber/webhook";

export const dynamic = "force-dynamic";

/**
 * Jobber webhook receiver (e.g. quote approved). Verifies the HMAC, ACKs within 1s
 * (Jobber's requirement), and processes asynchronously. Signature is base64
 * HMAC-SHA256 of the raw body keyed by the app client secret.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const cfg = getJobberConfig();
  const rawBody = await request.text();
  const signature = request.headers.get("x-jobber-hmac-sha256");

  if (!cfg.clientSecret || !verifyJobberWebhook(rawBody, signature, cfg.clientSecret)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }

  // ACK immediately; never block the response on downstream work (< 1s SLA).
  void handleJobberWebhook(rawBody).catch((err) => console.error("[jobber] webhook processing failed:", err));
  return NextResponse.json({ ok: true }, { status: 200 });
}
