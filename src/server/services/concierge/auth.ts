// ─────────────────────────────────────────────────────────────────────────────
// Concierge console — operator identity (docs/done-for-you.md → "Concierge console").
//
// An operator is a signed-in Supabase user whose CONFIRMED email is in OPERATOR_EMAILS
// (comma-separated, case-insensitive). The session is verified exactly like every other
// authenticated route: createSupabaseServerClient() (auth cookie, or `Authorization: Bearer`
// from the mobile app) → auth.getUser(), which validates the JWT against Supabase Auth.
//
// Anyone else — signed out, unconfirmed email, not on the list, or the list unset — gets a
// plain 404, so the console's existence is never revealed. OPS_ADMIN_TOKEN routes are
// separate and unchanged.
// ─────────────────────────────────────────────────────────────────────────────
import type { User } from "@supabase/supabase-js";

import { UserFacingError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

/** 404 with no hint that anything lives at this path. */
export class ConciergeNotFoundError extends UserFacingError {
  constructor() {
    super("Not found.", { status: 404 });
  }
}

export interface OperatorIdentity {
  /** Lower-cased, confirmed email — what operator_actions.operator_email records. */
  email: string;
  userId: string;
}

/** OPERATOR_EMAILS → a set of lower-cased addresses (blank entries dropped). */
export function parseOperatorEmails(raw: string | null | undefined = process.env.OPERATOR_EMAILS): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0 && e.includes("@")),
  );
}

type UserLike = Pick<User, "id" | "email"> & { email_confirmed_at?: string | null; confirmed_at?: string | null };

/** The operator identity for a verified user, or null. Requires a confirmed email on the list. */
export function operatorIdentityFor(user: UserLike | null | undefined, allowlist: Set<string> = parseOperatorEmails()): OperatorIdentity | null {
  if (!user?.email || allowlist.size === 0) return null;
  if (!user.email_confirmed_at) return null;
  const email = user.email.trim().toLowerCase();
  return allowlist.has(email) ? { email, userId: user.id } : null;
}

export function isOperatorUser(user: UserLike | null | undefined): boolean {
  return operatorIdentityFor(user) !== null;
}

type ServerClient = ReturnType<typeof createSupabaseServerClient>;

/**
 * Gate for every /api/concierge route. `request` is accepted for symmetry with other
 * guards (the server client reads the same request's cookie / bearer header).
 * Throws ConciergeNotFoundError (→ 404) for anyone who isn't an operator.
 */
export async function requireOperator(_request?: Request, supabase?: ServerClient): Promise<OperatorIdentity> {
  let user: UserLike | null = null;
  try {
    const client = supabase ?? createSupabaseServerClient();
    const { data, error } = await client.auth.getUser();
    user = error ? null : (data.user as UserLike | null);
  } catch {
    user = null;
  }
  const identity = operatorIdentityFor(user);
  if (!identity) throw new ConciergeNotFoundError();
  return identity;
}

/**
 * CSRF guard for concierge writes (cookie-authenticated from the browser): the request must be
 * JSON, and must come from our own origin. Browsers send Sec-Fetch-Site and Origin on every
 * POST; when present they must say same-origin / our host. A request with neither (a script
 * using a Bearer token — not CSRF-able) passes. Throws 415 / 403.
 */
export function assertSameOriginJson(request: Request): void {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(contentType.trim())) {
    throw new UserFacingError("Send JSON (Content-Type: application/json).", { status: 415, code: "unsupported_media_type" });
  }
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") {
    throw new UserFacingError("Cross-site request refused.", { status: 403, code: "cross_site" });
  }
  const origin = request.headers.get("origin");
  if (origin) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      originHost = null;
    }
    const host = request.headers.get("host")?.toLowerCase() ?? null;
    if (!originHost || !host || originHost !== host) {
      throw new UserFacingError("Cross-site request refused.", { status: 403, code: "cross_site" });
    }
  }
}
