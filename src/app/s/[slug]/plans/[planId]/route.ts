import type { NextResponse } from "next/server";

import { enforceRateLimit, trustedClientIp } from "@/server/services/rate-limit";
import { toE164 } from "@/server/services/retell/payload";
import { readBodyCapped, respond, unavailable } from "@/server/services/staff/service-plans/http";
import { planPage, planPageWithError, signUpForPlan } from "@/server/services/staff/service-plans/public";
import { assessFormSignals, verifyTurnstile } from "@/server/services/turnstile";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

/**
 * One service plan + its sign-up form (docs/ai-staff.md → "Service plans"). GET renders it; POST is
 * the plain HTML form submit: an annual plan of a business that takes cards online answers 303 to
 * Stripe Checkout (the first year's invoice, on the business's own Stripe account); otherwise the
 * owner is asked (plan_signup) and the page says so.
 * Abuse layers on POST: a streamed 16 KB body cap, per-IP and per-plan rate limits, a per-phone
 * daily cap, honeypot + minimum fill time (the render time is required), Turnstile when configured.
 * The company and plan come from the slug row and the plan id only; the body never picks a tenant.
 */
export const dynamic = "force-dynamic";

interface RouteContext {
  params: { slug: string; planId: string };
}

const MAX_BODY = 16 * 1024;
const GENERIC = "Your sign-up couldn't be sent. Please try again in a few minutes.";

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    return respond(await planPage(createSupabaseAdminClient(), context.params.slug, context.params.planId), "no-store");
  } catch (err) {
    console.error("[plans] public plan page failed:", err instanceof Error ? err.message : err);
    return unavailable();
  }
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const admin = createSupabaseAdminClient();
  const { slug, planId } = context.params;
  try {
    const raw = await readBodyCapped(request, MAX_BODY);
    const params = new URLSearchParams(raw ?? "");
    if (raw === null) return respond(await planPageWithError(admin, slug, planId, new URLSearchParams(), "That was too long - please shorten it.", 413), "no-store");
    const ip = trustedClientIp(request);
    const limited =
      (await enforceRateLimit(request, { scope: "plan_signup_ip", limit: 6, windowSeconds: 3600, keyParts: [ip] })) ??
      (await enforceRateLimit(request, { scope: "plan_signup_plan", limit: 100, windowSeconds: 3600, keyParts: [planId] }));
    if (limited) return respond(await planPageWithError(admin, slug, planId, params, "Too many tries - please wait a bit and try again.", 429), "no-store");
    const phone = toE164(params.get("phone"));
    if (phone && (await enforceRateLimit(request, { scope: "plan_signup_phone", limit: 5, windowSeconds: 86_400, keyParts: [phone] }))) {
      return respond(await planPageWithError(admin, slug, planId, params, "Too many sign-ups for this number today - please try again tomorrow.", 429), "no-store");
    }
    const t = Number(params.get("t"));
    const signals = assessFormSignals({ honeypot: params.get("website") ?? "", formStartedAt: Number.isFinite(t) && t > 0 ? t : undefined });
    if (!signals.ok || !(Number.isFinite(t) && t > 0)) return respond(await planPageWithError(admin, slug, planId, params, GENERIC), "no-store");
    const turnstile = await verifyTurnstile(request, params.get("cf-turnstile-response"));
    if (!turnstile.ok) return respond(await planPageWithError(admin, slug, planId, params, "Please complete the check above the button and try again."), "no-store");
    return respond(await signUpForPlan(admin, { slug, planId, params, nowMs: Date.now() }), "no-store");
  } catch (err) {
    console.error("[plans] sign-up failed:", err instanceof Error ? err.message : err);
    return unavailable();
  }
}
