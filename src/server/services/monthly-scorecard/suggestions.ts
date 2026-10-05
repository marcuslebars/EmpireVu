import type { ScorecardMetrics } from "@/server/services/monthly-scorecard/metrics";

/**
 * "What we're tuning next" — DETERMINISTIC rules over the month's numbers (no AI). Each rule
 * is evaluated in priority order; the first three that fire are shown. Pure + golden-tested.
 * Thresholds are product judgement, documented in docs/monthly-scorecard.md.
 */

export interface ScorecardSuggestion {
  id: string;
  title: string;
  detail: string;
  /** The recipe this suggestion would switch on, when there is one. */
  recipeSlug: string | null;
}

export const MAX_SUGGESTIONS = 3;

/** Median first response above this is "slow" (15 minutes). */
export const SLOW_RESPONSE_SECONDS = 15 * 60;
/** Texted back fewer than this share of missed calls → the catcher isn't doing its job. */
export const MIN_TEXT_BACK_RATE = 0.8;
/** Below this approval rate (with at least MIN_QUOTES_FOR_RATE quotes sent) → chase quotes. */
export const LOW_APPROVAL_RATE = 0.4;
export const MIN_QUOTES_FOR_RATE = 3;
/** Review asks below this share of completed jobs → ask for more reviews. */
export const MIN_REVIEW_ASK_RATE = 0.5;

function isActive(metrics: ScorecardMetrics, slug: string): boolean {
  return metrics.recipeStatus[slug] === "active";
}

function minutes(seconds: number): number {
  return Math.round(seconds / 60);
}

type Rule = (metrics: ScorecardMetrics) => ScorecardSuggestion | null;

const RULES: Rule[] = [
  // 1. Missed calls not being texted back.
  (m) => {
    if (m.missedCalls.caught === 0) return null;
    const rate = m.missedCalls.textedBack / m.missedCalls.caught;
    if (rate >= MIN_TEXT_BACK_RATE) return null;
    return isActive(m, "missed-call-text-back")
      ? {
          id: "missed_call_text_back_gaps",
          title: "Close the gaps on missed-call text-backs",
          detail: `Only ${m.missedCalls.textedBack} of ${m.missedCalls.caught} missed calls got a text back. We'll check caller numbers and the SMS setup so every missed caller hears from you.`,
          recipeSlug: null,
        }
      : {
          id: "enable_missed_call_text_back",
          title: "Turn on missed-call text-back",
          detail: `${m.missedCalls.caught} call${m.missedCalls.caught === 1 ? " was" : "s were"} missed and only ${m.missedCalls.textedBack} got a text back. Switching on the instant text-back gives every missed caller a booking link within seconds.`,
          recipeSlug: "missed-call-text-back",
        };
  },
  // 2. Slow first response.
  (m) => {
    const median = m.firstResponse.medianSeconds;
    if (median === null || median <= SLOW_RESPONSE_SECONDS) return null;
    return isActive(m, "new-lead-owner-alert")
      ? {
          id: "speed_up_first_response",
          title: "Speed up first response",
          detail: `Leads waited a median of ${minutes(median)} minutes for a first reply. We'll add an instant auto-reply so every new lead hears back in under 5 minutes.`,
          recipeSlug: null,
        }
      : {
          id: "enable_new_lead_alert",
          title: "Turn on instant new-lead alerts",
          detail: `Leads waited a median of ${minutes(median)} minutes for a first reply. An instant alert the moment a lead lands is the fastest way to bring that under 5 minutes.`,
          recipeSlug: "new-lead-owner-alert",
        };
  },
  // 3. Quotes going unapproved.
  (m) => {
    if (m.quotes.sent < MIN_QUOTES_FOR_RATE) return null;
    const rate = m.quotes.sentThenApproved / m.quotes.sent;
    if (rate >= LOW_APPROVAL_RATE) return null;
    const waiting = m.quotes.sent - m.quotes.sentThenApproved;
    return isActive(m, "quote-follow-up")
      ? {
          id: "tune_quote_follow_up",
          title: "Tune the quote follow-up",
          detail: `${waiting} of ${m.quotes.sent} quotes sent are still waiting on approval. We'll tighten the follow-up timing and wording.`,
          recipeSlug: null,
        }
      : {
          id: "enable_quote_follow_up",
          title: "Turn on quote follow-ups",
          detail: `${waiting} of ${m.quotes.sent} quotes sent are still waiting on approval. An automatic text-then-email nudge recovers quotes that would otherwise go cold.`,
          recipeSlug: "quote-follow-up",
        };
  },
  // 4. Not asking for reviews.
  (m) => {
    if (m.jobsCompleted === 0) return null;
    if (m.reviewsRequested / m.jobsCompleted >= MIN_REVIEW_ASK_RATE) return null;
    return isActive(m, "review-request") || m.reviewRequestsOn
      ? {
          id: "more_review_asks",
          title: "Ask more customers for reviews",
          detail: `${m.jobsCompleted} job${m.jobsCompleted === 1 ? " was" : "s were"} completed but only ${m.reviewsRequested} review request${m.reviewsRequested === 1 ? " went" : "s went"} out. We'll make sure finished jobs are marked complete so the ask goes out.`,
          recipeSlug: null,
        }
      : {
          id: "enable_review_requests",
          title: "Turn on review requests",
          detail: `${m.jobsCompleted} job${m.jobsCompleted === 1 ? " was" : "s were"} completed and only ${m.reviewsRequested} review request${m.reviewsRequested === 1 ? " went" : "s went"} out. Turn on review requests in Settings → Reviews and every finished job gets a friendly ask, with clicks tracked.`,
          recipeSlug: null,
        };
  },
  // 5. No leads at all.
  (m) => {
    if (m.leads.total > 0) return null;
    return {
      id: "check_lead_sources",
      title: "Check your lead sources",
      detail: "No new leads came in this month. We'll confirm your website form, phone number and listings are all connected and sending leads through.",
      recipeSlug: null,
    };
  },
  // 6. Quotes approved but deposits not collected.
  (m) => {
    if (m.quotes.approved < 2 || m.quotes.depositsCollected >= m.quotes.approved / 2) return null;
    return {
      id: "collect_deposits",
      title: "Collect more deposits up front",
      detail: `${m.quotes.approved} quotes were approved but only ${m.quotes.depositsCollected} deposit${m.quotes.depositsCollected === 1 ? " was" : "s were"} paid. We'll review the deposit step so approved jobs are locked in.`,
      recipeSlug: null,
    };
  },
];

export function buildSuggestions(metrics: ScorecardMetrics): ScorecardSuggestion[] {
  const out: ScorecardSuggestion[] = [];
  for (const rule of RULES) {
    const suggestion = rule(metrics);
    if (suggestion) out.push(suggestion);
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}
