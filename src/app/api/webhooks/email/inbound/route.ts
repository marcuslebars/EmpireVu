import { NextResponse } from "next/server";

import { emailClerkDeps } from "@/server/services/staff/email-clerk/deps";
import { receiveInboundEmail } from "@/server/services/staff/email-clerk/intake";
import { inboundConfigured } from "@/server/services/staff/email-clerk/settings";
import { enforceWebhookBackstop } from "@/server/services/rate-limit";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

/** Resend's inbound deliveries are small JSON metadata; anything this big isn't one. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Resend Inbound webhook (docs/ai-staff.md → "Email inbox"). Public (the middleware matcher
 * excludes /api/*), authenticated by the Svix signature over the RAW body (RESEND_WEBHOOK_SECRET):
 *
 *   not set up on this server (INBOUND_EMAIL_DOMAIN / RESEND_WEBHOOK_SECRET) → 503, nothing stored
 *   bad / missing / stale signature                                            → 400, nothing stored
 *   another event type, or an address that isn't one of our inboxes          → 200, ignored
 *   email.received → stored once (a retry is a no-op), content fetched        → 200 fast
 *
 * SANCTIONED EXCEPTION (service role): Resend has no user session. The tenant is resolved ONLY from
 * our own inbox address the email was delivered to (email_inboxes, server-side); nothing in the
 * payload picks an organization or company. Sorting, attachments and drafting run later in the
 * `email_clerk:process` sweep. Only a failed durable write answers 500, so Resend retries.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const backstop = await enforceWebhookBackstop(request, "email_inbound");
  if (backstop) return backstop;

  if (!inboundConfigured()) {
    console.error("[email-inbound] INBOUND_EMAIL_DOMAIN / RESEND_WEBHOOK_SECRET not configured — rejecting");
    return NextResponse.json({ error: "Inbound email not configured." }, { status: 503 });
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) return NextResponse.json({ error: "Too large." }, { status: 413 });

  const verified = emailClerkDeps().provider.verify({ rawBody, headers: request.headers });
  if (!("event" in verified)) {
    console.warn("[email-inbound] webhook rejected:", "reason" in verified ? verified.reason : "invalid");
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }
  if (verified.event.type !== "email.received") return NextResponse.json({ received: true, ignored: verified.event.eventType }, { status: 200 });

  try {
    const result = await receiveInboundEmail(createSupabaseAdminClient(), verified.event.data);
    return NextResponse.json({ received: true, status: result.status }, { status: 200 });
  } catch (err) {
    console.error("[email-inbound] could not store the email:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not store the email." }, { status: 500 });
  }
}
