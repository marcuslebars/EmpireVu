import { NextResponse } from "next/server";

import { verifyIntakeSignature } from "@/server/services/lead-intake/hmac";
import { resolveIntakeKey } from "@/server/services/lead-intake/intake-keys";
import { handleLeadIntake } from "@/server/services/lead-intake/intake";
import { enforceWebhookBackstop } from "@/server/services/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Public lead intake (no session — the middleware matcher excludes /api/*). Never drops a
 * lead: an authenticated request always gets 200 with a leadId. Two auth modes (Task 7):
 *
 *   (a) KEY mode — `x-empirevu-key` names a per-tenant intake key. The org+company are
 *       pinned by the KEY ROW (the payload can't choose them); the HMAC body signature is
 *       signed with the key itself. A brand-new tenant works with no env change/deploy.
 *   (b) LEGACY mode — no key header; the HMAC verifies against LEAD_INTAKE_SECRET and the
 *       tenant is resolved from sourceSite (the A1 spokes until cutover). Logged once/hour
 *       per sourceSite so the cutover can be tracked. Do NOT remove this path yet.
 *
 * The body HMAC signature is mandatory in BOTH modes. `sourceSite` is stored on the lead as
 * a free-text tag in both modes; it only ROUTES in legacy mode.
 */

// intake.legacy_auth_used — throttled to once per hour per sourceSite so the cutover of the
// five A1 spokes is visible without flooding the logs.
const LEGACY_LOG_INTERVAL_MS = 60 * 60 * 1000;
const legacyAuthLoggedAt = new Map<string, number>();

function logLegacyAuthUsed(sourceSite: string): void {
  const now = Date.now();
  const key = sourceSite || "-";
  if (now - (legacyAuthLoggedAt.get(key) ?? 0) >= LEGACY_LOG_INTERVAL_MS) {
    legacyAuthLoggedAt.set(key, now);
    console.warn(
      `[intake] intake.legacy_auth_used sourceSite=${key} — issue an intake key and cut this spoke over (docs/tenant-provisioning.md).`,
    );
  }
}

function readSourceSite(parsed: unknown): string {
  if (parsed && typeof parsed === "object" && "sourceSite" in parsed) {
    const value = (parsed as { sourceSite?: unknown }).sourceSite;
    return typeof value === "string" ? value : "";
  }
  return "";
}

export async function POST(request: Request): Promise<NextResponse> {
  const backstop = await enforceWebhookBackstop(request, "intake");
  if (backstop) return backstop;

  const rawBody = await request.text();
  const signature = request.headers.get("x-empirevu-signature");
  const keyHeader = request.headers.get("x-empirevu-key");

  // Parse may fail; a null parsedBody is still handled (stored raw, never dropped).
  let parsedBody: unknown = null;
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    parsedBody = null;
  }

  // ── Mode (a): per-tenant intake key ─────────────────────────────────────────
  if (keyHeader) {
    let resolved;
    try {
      resolved = await resolveIntakeKey(keyHeader);
    } catch (err) {
      console.error("[intake] key lookup failed:", err);
      return NextResponse.json({ error: "Could not verify the intake key." }, { status: 500 });
    }
    if (!resolved) {
      return NextResponse.json({ error: "Invalid or revoked intake key." }, { status: 401 });
    }
    // The body must be signed with the key itself.
    if (!verifyIntakeSignature(rawBody, signature, keyHeader)) {
      return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
    }
    try {
      const result = await handleLeadIntake(rawBody, parsedBody, {
        target: { organizationId: resolved.organizationId, companyId: resolved.companyId },
      });
      return NextResponse.json(result, { status: 200 });
    } catch (err) {
      console.error("[intake] durable write failed (key mode):", err);
      return NextResponse.json({ error: "Could not record the lead." }, { status: 500 });
    }
  }

  // ── Mode (b): legacy HMAC against LEAD_INTAKE_SECRET ─────────────────────────
  const secret = process.env.LEAD_INTAKE_SECRET;
  if (!secret) {
    console.error("[intake] LEAD_INTAKE_SECRET not configured and no intake key — rejecting");
    return NextResponse.json({ error: "Intake not configured." }, { status: 503 });
  }
  if (!verifyIntakeSignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }
  logLegacyAuthUsed(readSourceSite(parsedBody));

  try {
    const result = await handleLeadIntake(rawBody, parsedBody);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    console.error("[intake] durable write failed:", err);
    return NextResponse.json({ error: "Could not record the lead." }, { status: 500 });
  }
}
