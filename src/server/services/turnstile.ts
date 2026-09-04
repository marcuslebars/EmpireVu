import { clientIp } from "@/server/services/rate-limit";

/**
 * Cloudflare Turnstile verification for the public forms (booking, waitlist).
 *
 * FAIL-OPEN UNTIL CONFIGURED: when TURNSTILE_SECRET_KEY is unset we skip verification
 * with a one-time warning in EVERY environment (not a 503), so shipping this never
 * breaks a live form before the secret is provisioned. Once the secret is set, a
 * missing or invalid token is rejected. A transient error reaching Cloudflare also
 * fails open (allow + warn) — the honeypot, timing check, and rate limiter are
 * independent layers, so Turnstile going soft never takes a form down.
 *
 * Client side: VITE_TURNSTILE_SITE_KEY renders the widget (see TurnstileWidget.tsx).
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

let warnedUnset = false;

export interface TurnstileResult {
  ok: boolean;
  /** Why it failed, for the caller's log/response. Absent when ok. */
  reason?: "missing_token" | "invalid_token";
  /** True when verification was skipped (unset secret) or softened (network error). */
  degraded?: boolean;
}

export async function verifyTurnstile(
  request: Request,
  token: string | null | undefined,
): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY;

  if (!secret) {
    if (!warnedUnset) {
      console.warn(
        "[turnstile] TURNSTILE_SECRET_KEY is not set — skipping CAPTCHA verification. " +
          "Set it (and the client VITE_TURNSTILE_SITE_KEY) to enforce.",
      );
      warnedUnset = true;
    }
    return { ok: true, degraded: true };
  }

  if (!token) {
    return { ok: false, reason: "missing_token" };
  }

  try {
    const body = new URLSearchParams({ secret, response: token });
    const ip = clientIp(request);
    if (ip) body.set("remoteip", ip);

    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = (await res.json()) as { success?: boolean };
    if (json.success === true) {
      return { ok: true };
    }
    return { ok: false, reason: "invalid_token" };
  } catch (err) {
    // Cloudflare unreachable — don't take the form down over it.
    console.warn("[turnstile] siteverify failed (allowing):", err instanceof Error ? err.message : err);
    return { ok: true, degraded: true };
  }
}

export interface FormSignalsInput {
  /** Honeypot field value — a hidden input a real person never fills. */
  honeypot?: unknown;
  /** Client timestamp (epoch ms or ISO) captured when the form was first shown. */
  formStartedAt?: unknown;
  /** Minimum plausible fill time; faster than this is almost certainly a bot. */
  minMillis?: number;
  now?: number;
}

export interface FormSignalsResult {
  ok: boolean;
  reason?: "honeypot" | "too_fast";
}

/**
 * Cheap, no-network bot signals: a filled honeypot, or a submission faster than a human
 * could fill the form. Both are client-controllable so this is a filter, not a security
 * boundary — it runs alongside Turnstile and the rate limiter, never instead of them.
 * A missing/unparseable timestamp is NOT treated as a failure (we can't prove it fast).
 */
export function assessFormSignals(input: FormSignalsInput): FormSignalsResult {
  if (typeof input.honeypot === "string" && input.honeypot.trim().length > 0) {
    return { ok: false, reason: "honeypot" };
  }

  const minMillis = input.minMillis ?? 3000;
  const now = input.now ?? Date.now();
  const started =
    typeof input.formStartedAt === "number"
      ? input.formStartedAt
      : typeof input.formStartedAt === "string" && input.formStartedAt.trim().length > 0
        ? Date.parse(input.formStartedAt)
        : NaN;

  if (Number.isFinite(started)) {
    const elapsed = now - started;
    // Guard against clock skew producing a bogus negative/huge elapsed: only reject a
    // small positive elapsed under the threshold.
    if (elapsed >= 0 && elapsed < minMillis) {
      return { ok: false, reason: "too_fast" };
    }
  }

  return { ok: true };
}
