import { NextResponse } from "next/server";

import { renderSiteNotFound } from "@/server/services/dfy/site-render";
import { enforceRateLimit, trustedClientIp } from "@/server/services/rate-limit";
import { toE164 } from "@/server/services/retell/payload";
import { applyToJob, jobPage, jobPageWithError, type PublicPage } from "@/server/services/staff/recruiter/public";
import { assessFormSignals, verifyTurnstile } from "@/server/services/turnstile";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

/**
 * One job + its apply form (docs/ai-staff.md → "Hiring & payroll"). GET renders it; POST is the
 * plain HTML form submit. Abuse layers on POST: a streamed 16 KB body cap, per-IP and per-job
 * rate limits, a per-phone daily cap (5, across jobs), honeypot + minimum fill time (the render
 * time is required), Turnstile (when configured). The company and job
 * come from the slug row and the job id only; the body can never choose a tenant.
 */
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string; jobId: string };
}

const HTML = "text/html; charset=utf-8";
const MAX_BODY = 16 * 1024;
const GENERIC = "Your application couldn't be sent. Please try again in a few minutes.";

function respond(page: PublicPage, cache: string): NextResponse {
  if (!page.html) return new NextResponse(renderSiteNotFound(), { status: 404, headers: { "content-type": HTML, "cache-control": "public, max-age=0, s-maxage=30", "x-robots-tag": "noindex" } });
  return new NextResponse(page.html, {
    status: page.status,
    headers: { "content-type": HTML, "cache-control": cache, "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin" },
  });
}

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

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    return respond(await jobPage(createSupabaseAdminClient(), context.params.slug, context.params.jobId), "public, max-age=0, s-maxage=60, stale-while-revalidate=300");
  } catch (err) {
    console.error("[jobs] public job page failed:", err instanceof Error ? err.message : err);
    return new NextResponse(renderSiteNotFound(), { status: 503, headers: { "content-type": HTML, "cache-control": "no-store" } });
  }
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const admin = createSupabaseAdminClient();
  const { slug, jobId } = context.params;
  try {
    const raw = await readBodyCapped(request, MAX_BODY);
    const params = new URLSearchParams(raw ?? "");
    if (raw === null) return respond(await jobPageWithError(admin, slug, jobId, new URLSearchParams(), "That was too long - please shorten your answers.", 413), "no-store");
    const ip = trustedClientIp(request);
    const limited =
      (await enforceRateLimit(request, { scope: "job_apply_ip", limit: 6, windowSeconds: 3600, keyParts: [ip] })) ??
      (await enforceRateLimit(request, { scope: "job_apply_job", limit: 200, windowSeconds: 3600, keyParts: [jobId] }));
    if (limited) return respond(await jobPageWithError(admin, slug, jobId, params, "Too many tries - please wait a bit and try again.", 429), "no-store");
    // One phone number: at most 5 applications a day, across every job and business.
    const phone = toE164(params.get("phone"));
    if (phone && (await enforceRateLimit(request, { scope: "job_apply_phone", limit: 5, windowSeconds: 86_400, keyParts: [phone] }))) {
      return respond(await jobPageWithError(admin, slug, jobId, params, "You've sent a lot of applications today - please try again tomorrow.", 429), "no-store");
    }
    // The form always carries its render time (server-side, so it works without JS): missing = a bot.
    const t = Number(params.get("t"));
    const signals = assessFormSignals({ honeypot: params.get("website") ?? "", formStartedAt: Number.isFinite(t) && t > 0 ? t : undefined });
    if (!signals.ok || !(Number.isFinite(t) && t > 0)) return respond(await jobPageWithError(admin, slug, jobId, params, GENERIC), "no-store");
    const turnstile = await verifyTurnstile(request, params.get("cf-turnstile-response"));
    if (!turnstile.ok) return respond(await jobPageWithError(admin, slug, jobId, params, "Please complete the check above the button and try again."), "no-store");
    return respond(await applyToJob(admin, { slug, jobId, params, nowMs: Date.now() }), "no-store");
  } catch (err) {
    console.error("[jobs] apply failed:", err instanceof Error ? err.message : err);
    return new NextResponse(renderSiteNotFound(), { status: 503, headers: { "content-type": HTML, "cache-control": "no-store" } });
  }
}
