import { NextResponse } from "next/server";

import {
  CRANKLEADS_CHECKOUT_MAX_BODY_BYTES,
  CrankleadsCheckoutUnavailableError,
  crankleadsCheckoutSchema,
  createCrankleadsCheckout,
} from "@/server/services/crankleads/checkout";
import { crankleadsSiteOrigins } from "@/server/services/crankleads/config";
import { enforceRateLimit, trustedClientIp } from "@/server/services/rate-limit";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Public CrankLeads checkout (no session — the buyer has no account yet). Called from
 * crankleads.com. See docs/crankleads-purchase.md.
 *
 *   POST { tier, name, email, phone, businessName, businessType, founding?, utm? }
 *     → 200 { url }  (Stripe Checkout — redirect the browser there)
 *
 * Layers, in order: body cap (Content-Length, then streamed) → Origin allow-list
 * (CRANKLEADS_SITE_ORIGINS; no credentials) → per-IP + per-email rate limits → zod →
 * durable staging row (crankleads_purchases) → Stripe Checkout Session.
 */

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
  if (origin && crankleadsSiteOrigins().has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(body: unknown, status: number, origin: string | null): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...corsHeaders(origin) } });
}

/** Read the body as text, aborting past `max` bytes (Content-Length can lie or be absent). */
async function readBodyCapped(request: Request, max: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function OPTIONS(request: Request): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
}

export async function POST(request: Request): Promise<NextResponse> {
  const origin = request.headers.get("origin");

  // (1) Body cap — before anything else.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > CRANKLEADS_CHECKOUT_MAX_BODY_BYTES) {
    return json({ error: "Request too large." }, 413, origin);
  }

  // (2) A browser on another site can't start a checkout here. (No Origin = a server-side
  // caller, e.g. a crankleads.com server function — allowed; there are no cookies to ride.)
  if (origin && !crankleadsSiteOrigins().has(origin)) {
    return json({ error: "Origin not allowed." }, 403, origin);
  }

  // (3) Per-IP limit.
  const ipLimited = await enforceRateLimit(request, {
    scope: "crankleads_checkout",
    limit: 10,
    windowSeconds: 600,
    keyParts: [trustedClientIp(request)],
    responseHeaders: corsHeaders(origin),
  });
  if (ipLimited) return ipLimited;

  const raw = await readBodyCapped(request, CRANKLEADS_CHECKOUT_MAX_BODY_BYTES);
  if (raw === null) {
    return json({ error: "Request too large." }, 413, origin);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON." }, 400, origin);
  }

  const parsed = crankleadsCheckoutSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "body";
      fields[key] ??= issue.message;
    }
    return json({ error: "Please check the highlighted fields.", fields }, 400, origin);
  }

  // (4) Per-email limit — one buyer hammering the button doesn't open dozens of sessions.
  const emailLimited = await enforceRateLimit(request, {
    scope: "crankleads_checkout_email",
    limit: 5,
    windowSeconds: 3600,
    keyParts: [parsed.data.email],
    responseHeaders: corsHeaders(origin),
  });
  if (emailLimited) return emailLimited;

  try {
    const admin = createSupabaseAdminClient();
    const { url } = await createCrankleadsCheckout(admin, parsed.data);
    return json({ url }, 200, origin);
  } catch (err) {
    if (err instanceof CrankleadsCheckoutUnavailableError) {
      console.error("[crankleads/checkout] not configured:", err.message);
      return json({ error: "Checkout is temporarily unavailable. Please call or email us." }, 503, origin);
    }
    console.error("[crankleads/checkout] failed:", err instanceof Error ? err.message : err);
    return json({ error: "Couldn't start checkout. Please try again." }, 502, origin);
  }
}
