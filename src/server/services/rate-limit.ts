import { NextResponse } from "next/server";

// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION #2 (service role) — abuse-control rate limiter (Task 5).
//
// The DB-backed limiter table (rate_limit_buckets) is service-role only: RLS is on
// with no member policies, so the public/unauthenticated routes that call this — which
// hold no session and no forgeable RLS identity — must write through the admin client.
// This module never reads tenant business data; it only increments a per-key counter.
// Keys are derived from the client IP and the targeted resource (company id / quote
// token), never from anything the caller can spoof into another tenant's scope.
// Listed in docs/EMPIREVU_RUNBOOK.md.
// ─────────────────────────────────────────────────────────────────────────────
import { createSupabaseAdminClient } from "@/server/supabase/admin";

/** First hop of x-forwarded-for (the client), falling back to x-real-ip. */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip");
}

const PRIVATE_IP = [
  /^10\./,
  /^127\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT / internal mesh
  /^169\.254\./,
  /^::1$/,
  /^f[cd][0-9a-f]{2}:/i,
  /^fe80:/i,
];

/**
 * The client IP as appended by OUR edge, for keying per-IP limits on unauthenticated
 * routes where a spoofed key would defeat the limit. Railway's edge APPENDS the real
 * client address to x-forwarded-for (it does not strip client-sent values), so the
 * leftmost hop is attacker-controlled; the rightmost public hop is the one the edge
 * added. Internal/private hops (Railway's mesh, localhost) are skipped from the right.
 * Falls back to x-real-ip, then null. If a CDN is ever put in front of Railway, the
 * rightmost public hop becomes the CDN — switch to that CDN's verified client header.
 * See docs/EMPIREVU_RUNBOOK.md (Abuse controls).
 */
export function trustedClientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((h) => h.trim()).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
      if (!PRIVATE_IP.some((re) => re.test(hops[i]))) return hops[i];
    }
  }
  return request.headers.get("x-real-ip");
}

export interface EnforceRateLimitOptions {
  /** Stable identifier for this limit, e.g. "public_booking_post". First key segment. */
  scope: string;
  /** Max hits allowed within the window. */
  limit: number;
  /** Fixed window length in seconds. */
  windowSeconds: number;
  /**
   * The parts that identify who/what is being limited — an IP, a company id, a token.
   * Empty/nullish parts are dropped; if nothing is left the bucket degrades to the scope
   * alone (a conservative shared bucket) rather than skipping the limit.
   */
  keyParts: Array<string | null | undefined>;
  /** Merged into the 429 response (e.g. CORS headers for cross-origin routes). */
  responseHeaders?: Record<string, string>;
  /** Logged (no PII) when the limit trips, to attribute abuse to a tenant. */
  logContext?: { organizationId?: string | null; companyId?: string | null };
}

/**
 * Consume one hit against a rate-limit bucket. Returns a ready-to-send 429 NextResponse
 * when the caller is over the limit, or null to proceed.
 *
 * FAILS OPEN: any error talking to the limiter returns null (allow). The limiter is a
 * backstop, not the security boundary — a limiter outage must never drop a legitimate
 * signed webhook or block a real customer. The signed routes verify signatures; the
 * public forms have honeypot + Turnstile as independent layers.
 */
export async function enforceRateLimit(
  request: Request,
  options: EnforceRateLimitOptions,
): Promise<NextResponse | null> {
  const parts = options.keyParts.map((p) => (p ?? "").trim()).filter((p) => p.length > 0);
  const key = [options.scope, ...(parts.length > 0 ? parts : ["unknown"])].join(":");

  let withinLimit: boolean;
  try {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin.rpc("consume_rate_limit", {
      p_key: key,
      p_limit: options.limit,
      p_window_seconds: options.windowSeconds,
    });
    if (error) throw error;
    // A null/undefined result is treated as "allow" (fail open).
    withinLimit = data !== false;
  } catch (err) {
    console.error(
      `[rate-limit] check failed (allowing) scope=${options.scope}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  if (withinLimit) {
    return null;
  }

  // Attribute the block to a tenant, never to a person: scope + org/company only. The
  // key (which contains the IP) is deliberately NOT logged — no PII in the log line.
  console.warn(
    `[rate-limit] 429 scope=${options.scope}` +
      ` org=${options.logContext?.organizationId ?? "-"} company=${options.logContext?.companyId ?? "-"}`,
  );

  return NextResponse.json(
    { error: "Too many requests. Please slow down and try again shortly." },
    {
      status: 429,
      headers: { "Retry-After": String(options.windowSeconds), ...options.responseHeaders },
    },
  );
}

/**
 * Generous per-IP DoS backstop for the SIGNED machine-to-machine endpoints (intake,
 * Retell/Telnyx/Stripe webhooks). These already authenticate by signature; this
 * only sheds a flood. 600/min/IP — far above any real caller's rate. Fails open like
 * enforceRateLimit, so a limiter blip never drops a legitimate signed delivery.
 */
export function enforceWebhookBackstop(request: Request, scope: string): Promise<NextResponse | null> {
  return enforceRateLimit(request, {
    scope: `backstop_${scope}`,
    limit: 600,
    windowSeconds: 60,
    keyParts: [clientIp(request)],
  });
}
