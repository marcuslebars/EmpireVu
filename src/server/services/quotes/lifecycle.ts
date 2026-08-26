/**
 * Quote lifecycle — the single place that says which status may follow which.
 *
 *   draft ─▶ sent ─▶ viewed ─▶ approved ─▶ deposit_paid ─▶ completed
 *              │        │          │
 *              ├────────┴──────────┴──▶ expired      (valid_until passed, unapproved)
 *              └───────────────────────▶ cancelled   (we pulled it, or refunded)
 *
 * Rules the diagram encodes, and why:
 *   • 'viewed' is reachable only from 'sent' — it is set once, on first open, so a
 *     customer reopening an approved quote cannot walk it backwards.
 *   • 'approved' is reachable from both 'sent' and 'viewed': the page marks viewed
 *     on open, but a customer can approve from a link that skipped the view write
 *     (e.g. a failed beacon), and we must not lose the approval over bookkeeping.
 *   • Only an APPROVED quote can reach 'deposit_paid'. The Stripe webhook is the
 *     sole writer of that edge; it must never resurrect an expired or cancelled
 *     quote, so those are terminal against it.
 *   • 'completed' follows 'deposit_paid' only — the balance invoice cannot be paid
 *     on a quote whose deposit never was.
 *   • 'expired' cannot follow 'approved' or later. Once a customer has committed,
 *     a cron must not quietly retract the quote out from under them; that is the
 *     bug this table exists to make impossible.
 *   • 'cancelled' is reachable from anything not already terminal — refunds and
 *     manual pulls both land here — but never from 'completed'.
 *
 * Phase 3/4 write through assertTransition() rather than setting status directly.
 */

export const QUOTE_STATUSES = [
  "draft",
  "sent",
  "viewed",
  "approved",
  "deposit_paid",
  "completed",
  "expired",
  "cancelled",
] as const;

export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/** Terminal states — nothing may follow them. */
export const TERMINAL_STATUSES: readonly QuoteStatus[] = ["completed", "expired", "cancelled"];

const TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
  draft: ["sent", "cancelled"],
  sent: ["viewed", "approved", "expired", "cancelled"],
  viewed: ["approved", "expired", "cancelled"],
  approved: ["deposit_paid", "cancelled"],
  deposit_paid: ["completed", "cancelled"],
  completed: [],
  expired: ["cancelled"],
  cancelled: [],
};

export function isQuoteStatus(value: unknown): value is QuoteStatus {
  return typeof value === "string" && (QUOTE_STATUSES as readonly string[]).includes(value);
}

/** True when `to` may follow `from`. A no-op (from === to) is not a transition. */
export function canTransition(from: QuoteStatus, to: QuoteStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: QuoteStatus): readonly QuoteStatus[] {
  return TRANSITIONS[from];
}

export class QuoteTransitionError extends Error {
  constructor(
    readonly from: QuoteStatus,
    readonly to: QuoteStatus,
  ) {
    super(`Quote cannot move from "${from}" to "${to}".`);
    this.name = "QuoteTransitionError";
  }
}

/** Throws unless the move is legal. Callers persist only after this returns. */
export function assertTransition(from: QuoteStatus, to: QuoteStatus): void {
  if (!canTransition(from, to)) throw new QuoteTransitionError(from, to);
}

/**
 * Idempotent guard for webhook-driven edges. Stripe redelivers, so
 * `checkout.session.completed` can arrive twice for one quote: the second must be
 * a no-op, not an error. Returns 'apply' | 'noop' | 'illegal'.
 */
export function evaluateTransition(from: QuoteStatus, to: QuoteStatus): "apply" | "noop" | "illegal" {
  if (from === to) return "noop";
  return canTransition(from, to) ? "apply" : "illegal";
}
