import { NextResponse } from "next/server";

import { handleLeadIntake } from "@/server/services/lead-intake/intake";
import {
  buildPublicFormEnvelope,
  evaluateOrigin,
  PUBLIC_FORM_MAX_BODY_BYTES,
  PUBLIC_FORM_SOURCE,
  publicFormCorsHeaders,
  publicFormSubmissionSchema,
  selfOrigins,
} from "@/server/services/lead-intake/public-form-envelope";
import {
  listPublicServiceLabels,
  resolvePublicFormKey,
  toPublicFormConfig,
  touchPublicFormKey,
} from "@/server/services/lead-intake/public-forms";
import { enforceRateLimit, trustedClientIp } from "@/server/services/rate-limit";
import { assessFormSignals, verifyTurnstile } from "@/server/services/turnstile";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { formKey: string };
}

/**
 * Public website lead form (hosted page /f/:formKey + /embed/v1.js). No session — the
 * middleware matcher excludes /api/*. The tenant is resolved from the KEY ROW only; the
 * body can never choose an org/company.
 *
 *   GET  → display-safe config (company name/logo/public phone, catalog labels, consent text).
 *   POST → abuse layers (streamed body cap, per-IP + per-form rate limits, Origin / allowed_origins,
 *          honeypot + minimum fill time, Turnstile) → schemaVersion-1 envelope →
 *          handleLeadIntake with the key's org/company pinned (durable raw_leads write
 *          first; dedup, notification, contact.created automations unchanged after it).
 */

const GENERIC_REJECT = "Your request could not be sent. Please try again.";

function readField(raw: unknown, key: string): unknown {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>)[key] : undefined;
}

/**
 * Read the body as text, aborting once it exceeds `max` bytes — Content-Length can be
 * absent (chunked) or lie, so the stream itself is capped. Returns null when too large.
 */
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

function json(body: unknown, status: number, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export async function OPTIONS(request: Request, context: RouteContext): Promise<NextResponse> {
  let corsOrigin: string | null = null;
  try {
    const form = await resolvePublicFormKey(context.params.formKey);
    if (form) {
      const decision = evaluateOrigin({
        requestOrigin: request.headers.get("origin"),
        allowedOrigins: form.allowedOrigins,
        selfOrigins: selfOrigins(request),
        write: false,
      });
      corsOrigin = decision.ok ? decision.corsOrigin : null;
    }
  } catch {
    corsOrigin = null;
  }
  return new NextResponse(null, { status: 204, headers: publicFormCorsHeaders(corsOrigin) });
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, {
    scope: "public_form_get",
    limit: 60,
    windowSeconds: 600,
    keyParts: [trustedClientIp(request)],
  });
  if (limited) return limited;

  try {
    const form = await resolvePublicFormKey(context.params.formKey);
    if (!form) {
      return json({ error: "This form isn't available." }, 404);
    }
    const decision = evaluateOrigin({
      requestOrigin: request.headers.get("origin"),
      allowedOrigins: form.allowedOrigins,
      selfOrigins: selfOrigins(request),
      write: false,
    });
    if (!decision.ok) {
      return json({ error: "This form isn't available on this website." }, 403);
    }
    const services = await listPublicServiceLabels(form);
    return json({ data: toPublicFormConfig(form, services) }, 200, publicFormCorsHeaders(decision.corsOrigin));
  } catch (err) {
    console.error("[public-forms] config lookup failed:", err instanceof Error ? err.message : err);
    return json({ error: "Couldn't load this form. Please try again." }, 500);
  }
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  // (1) Body size cap — before reading anything.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > PUBLIC_FORM_MAX_BODY_BYTES) {
    return json({ error: "That message is too long." }, 413);
  }

  // (2) Per-IP limit — sheds floods before any key lookup.
  const ipLimited = await enforceRateLimit(request, {
    scope: "public_form_post",
    limit: 8,
    windowSeconds: 600,
    keyParts: [trustedClientIp(request)],
  });
  if (ipLimited) return ipLimited;

  const rawBody = await readBodyCapped(request, PUBLIC_FORM_MAX_BODY_BYTES);
  if (rawBody === null) {
    return json({ error: "That message is too long." }, 413);
  }

  // (3) Resolve the tenant from the KEY (unknown / revoked → 404, nothing written).
  let form;
  try {
    form = await resolvePublicFormKey(context.params.formKey);
  } catch (err) {
    console.error("[public-forms] key lookup failed:", err instanceof Error ? err.message : err);
    return json({ error: "Couldn't send right now. Please try again or call us." }, 500);
  }
  if (!form) {
    return json({ error: "This form is no longer accepting requests." }, 404);
  }

  let parsedBody: unknown = null;
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    parsedBody = null;
  }

  // (4) Origin / allowed_origins.
  const embedOrigin = readField(parsedBody, "embedOrigin");
  const decision = evaluateOrigin({
    requestOrigin: request.headers.get("origin"),
    embedOrigin: typeof embedOrigin === "string" ? embedOrigin : null,
    framed: readField(parsedBody, "framed") === true,
    allowedOrigins: form.allowedOrigins,
    selfOrigins: selfOrigins(request),
    write: true,
  });
  if (!decision.ok) {
    console.warn(
      `[public-forms] origin refused reason=${decision.reason} org=${form.organizationId} company=${form.companyId}`,
    );
    return json({ error: "This form isn't available on this website." }, 403);
  }
  const cors = publicFormCorsHeaders(decision.corsOrigin);

  // (5) Per-form limit — caps total spam into one tenant's CRM.
  const formLimited = await enforceRateLimit(request, {
    scope: "public_form_post_key",
    limit: 100,
    windowSeconds: 3600,
    keyParts: [form.id],
    responseHeaders: cors,
    logContext: { organizationId: form.organizationId, companyId: form.companyId },
  });
  if (formLimited) return formLimited;

  if (!parsedBody || typeof parsedBody !== "object") {
    return json({ error: GENERIC_REJECT }, 400, cors);
  }

  // (6) Honeypot + minimum fill time. Generic 400 so a bot can't tell which tripped,
  //     and a real (very fast) person can simply press Send again.
  const signals = assessFormSignals({
    honeypot: readField(parsedBody, "website"),
    formStartedAt: readField(parsedBody, "formStartedAt"),
  });
  if (!signals.ok) {
    return json({ error: GENERIC_REJECT }, 400, cors);
  }

  // (7) Turnstile (fail-open until TURNSTILE_SECRET_KEY is set).
  const tokenField = readField(parsedBody, "turnstileToken");
  const turnstile = await verifyTurnstile(request, typeof tokenField === "string" ? tokenField : undefined);
  if (!turnstile.ok) {
    return json({ error: "Please complete the verification and try again." }, 400, cors);
  }

  // (8) Field validation. Unknown keys (organizationId, companyId, sourceSite, …) are
  //     stripped by the schema — the tenant is the key's, full stop.
  const parsed = publicFormSubmissionSchema.safeParse(parsedBody);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return json({ error: first?.message ?? "Please check the form and try again." }, 400, cors);
  }

  const envelope = buildPublicFormEnvelope(parsed.data, {
    formType: form.formType,
    companyName: form.company.name,
    companySlug: form.company.slug,
  });

  // (9) The SAME durable intake path as every other lead, with the tenant pinned. A throw
  //     here means the durable write failed → 500 (never a false success).
  let result;
  try {
    result = await handleLeadIntake(JSON.stringify(envelope), envelope, {
      target: { organizationId: form.organizationId, companyId: form.companyId },
      // Customer-facing paid automations (instant-reply SMS, call_lead) only run when
      // the bot check actually verified — not when Turnstile is unset or degraded.
      workflowTrigger: { source: PUBLIC_FORM_SOURCE, paidActionsVerified: turnstile.ok && !turnstile.degraded },
    });
  } catch (err) {
    console.error(
      `[public-forms] durable write failed org=${form.organizationId} company=${form.companyId}:`,
      err instanceof Error ? err.message : err,
    );
    return json({ error: "Couldn't send right now. Please try again or call us." }, 500, cors);
  }

  // (10) After the durable write: telemetry only, never fatal.
  await touchPublicFormKey(form.id);

  return json({ data: { ok: true, leadId: result.leadId } }, 200, cors);
}
