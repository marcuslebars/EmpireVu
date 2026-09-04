import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { getJobberConfig } from "@/server/services/jobber/config";
import { verifyJobberWebhook } from "@/server/services/jobber/hmac";
import { enqueueInboundWebhookJob } from "@/server/services/inbound-webhook-jobs";
import { enforceWebhookBackstop } from "@/server/services/rate-limit";
// Jobber is a sanctioned service-role surface (convention #2); the webhook has no user
// session, so the durable enqueue runs on the admin client.
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

/** Prefer a stable Jobber event id; Jobber's webhook shape carries none today. */
function jobberEventId(payload: unknown): string | null {
  if (payload && typeof payload === "object") {
    const p = payload as { id?: unknown; data?: { webHookEvent?: { id?: unknown } } };
    if (typeof p.id === "string" && p.id) return p.id;
    if (typeof p.data?.webHookEvent?.id === "string" && p.data.webHookEvent.id) {
      return p.data.webHookEvent.id;
    }
  }
  return null;
}

/**
 * Jobber webhook receiver (e.g. quote approved). Verifies the HMAC, then is
 * DURABLE-FIRST: it enqueues an inbound_webhook_jobs row and ACKs only after that
 * write succeeds (< 1s SLA). The workflow-event worker drains the queue and runs the
 * Jobber handler later. Signature is base64 HMAC-SHA256 of the raw body keyed by the
 * app client secret.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const backstop = await enforceWebhookBackstop(request, "jobber_webhook");
  if (backstop) return backstop;

  const cfg = getJobberConfig();
  const rawBody = await request.text();
  const signature = request.headers.get("x-jobber-hmac-sha256");

  if (!cfg.clientSecret || !verifyJobberWebhook(rawBody, signature, cfg.clientSecret)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  // No stable event id, so dedupe on a hash of the raw body — an identical redelivery
  // is a no-op insert (and the handler is idempotent anyway).
  const externalId = jobberEventId(payload) ?? createHash("sha256").update(rawBody).digest("hex");

  try {
    const admin = createSupabaseAdminClient();
    await enqueueInboundWebhookJob(admin, { provider: "jobber", externalId, payload });
  } catch (err) {
    console.error("[jobber] durable enqueue failed:", err);
    return NextResponse.json({ error: "Failed to persist webhook." }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
