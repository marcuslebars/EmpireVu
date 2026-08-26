import { NextResponse } from "next/server";

import { logRetellPayload } from "@/server/services/retell/auth";
import { getRetellConfig } from "@/server/services/retell/config";
import { ingestRetellCall } from "@/server/services/retell/lead-adapter";
import { readString } from "@/server/services/retell/payload";
import { verifyRetellSignature } from "@/server/services/retell/signature";

export const dynamic = "force-dynamic";

/**
 * Retell voice-receptionist webhook. Verifies the X-Retell-Signature HMAC, ACKs fast,
 * and processes asynchronously (mirrors the Jobber webhook). Only `call_analyzed`
 * carries the final transcript + post-call analysis we build a lead from; every other
 * event (call_started / call_ended / …) is ACKed without work. ingestRetellCall is
 * durable-first internally, so the raw call + lead persist before enrichment.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const cfg = getRetellConfig();
  const rawBody = await request.text();
  const signature = request.headers.get("x-retell-signature");

  if (!verifyRetellSignature(rawBody, signature, cfg.apiKey, cfg.toleranceMs)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }

  // Inert unless intake OR outbound is enabled (ingestRetellCall routes by direction and
  // re-checks the specific flag). Signature is verified first, so a flagged-off endpoint
  // can't be probed unauthenticated; a valid-but-disabled call is ACKed (no retry).
  if (!cfg.enabled && !cfg.outboundEnabled) {
    return NextResponse.json({ ok: true, disabled: true }, { status: 200 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  logRetellPayload("webhook", payload);

  const event = readString(payload, ["event"]);
  if (event !== "call_analyzed") {
    return NextResponse.json({ ok: true, ignored: event ?? "unknown" }, { status: 200 });
  }

  // ACK fast; never block the response on downstream work.
  void ingestRetellCall(payload).catch((err) => console.error("[retell] webhook processing failed:", err));
  return NextResponse.json({ ok: true }, { status: 200 });
}
