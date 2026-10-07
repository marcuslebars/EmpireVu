/**
 * The one error type whose message is allowed to reach a user.
 *
 * handleRoute (src/server/api/route.ts) sends `message` — plus `code` and any
 * `details` — to the client ONLY for errors of this class (and its subclasses:
 * ValidationError, AuthorizationError, the invoice / quote domain errors…).
 * Anything else is logged server-side and the client gets a generic apology with
 * an error id, so a database message, a stack-ish string or an internal id can
 * never end up on an owner's screen or a customer's pay page.
 *
 * So: write the message for the person reading it. No ids, no column names, no
 * status enums — say what happened and what to do next.
 */
export interface UserFacingErrorOptions {
  /** HTTP status handleRoute answers with. Default 400. */
  status?: number;
  /** Stable machine-readable code the UI can branch on (e.g. "total_changed"). */
  code?: string;
  /** Extra JSON-safe fields merged into the response body. Must be safe to show. */
  details?: Record<string, unknown>;
}

export class UserFacingError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, opts: UserFacingErrorOptions = {}) {
    super(message);
    this.name = "UserFacingError";
    this.status = opts.status ?? 400;
    this.code = opts.code;
    this.details = opts.details;
  }
}

/** The text a user sees for any error we did not write for them. */
export const GENERIC_ERROR_MESSAGE =
  "Something went wrong on our end. Please try again — if it keeps happening, contact support.";
