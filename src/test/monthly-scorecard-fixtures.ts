/**
 * Golden fixture month for the monthly scorecard tests: October 2026 for a company in
 * America/Toronto. Expected numbers are listed next to each row so the golden assertions in
 * monthly-scorecard.test.ts can be audited by reading this file.
 */
import { emptyScorecardInputs, type ScorecardInputs } from "@/server/services/monthly-scorecard/metrics";

export const TZ = "America/Toronto";
/** October 2026 in Toronto: EDT (UTC-4) both ends — DST ends Nov 1 at 02:00 local. */
export const OCT_RANGE = { from: "2026-10-01T04:00:00.000Z", to: "2026-11-01T04:00:00.000Z" };
export const SEP_RANGE = { from: "2026-09-01T04:00:00.000Z", to: "2026-10-01T04:00:00.000Z" };

export function octoberInputs(): ScorecardInputs {
  return {
    ...emptyScorecardInputs(),
    newContacts: [
      // web form (intake metadata) — answered by an automated SMS in 3 min
      { id: "c1", createdAt: "2026-10-02T14:00:00.000Z", metadata: { source: "acme-contact", sourceSite: "acme", formType: "contact" }, consentSource: "implied_inquiry" },
      // phone / AI receptionist — answered by an outbound call in 20 min
      { id: "c2", createdAt: "2026-10-05T15:00:00.000Z", metadata: { source: "retell", formType: "phone-lead" }, consentSource: "implied_inquiry" },
      // missed-call catcher — the call that created it was missed; texted back in 60 s
      { id: "c3", createdAt: "2026-10-06T16:00:00.000Z", metadata: { source: "retell", formType: "phone-lead" }, consentSource: "implied_inquiry" },
      // referral tag — never answered
      { id: "c4", createdAt: "2026-10-10T12:00:00.000Z", metadata: { source: "referral", formType: "contact" }, consentSource: null },
      // inbound text — answered by a manual email in 1 h
      { id: "c5", createdAt: "2026-10-12T12:00:00.000Z", metadata: {}, consentSource: "inbound_sms" },
      // public booking page (no metadata) → web form
      { id: "c6", createdAt: "2026-10-20T12:00:00.000Z", metadata: {}, consentSource: "implied_inquiry" },
      // manual entry → other
      { id: "c7", createdAt: "2026-10-25T12:00:00.000Z", metadata: {}, consentSource: null },
      // exactly local midnight Oct 1 → INCLUDED (other)
      { id: "c8", createdAt: "2026-10-01T04:00:00.000Z", metadata: {}, consentSource: null },
      // 23:59:59.999 Sep 30 local → EXCLUDED
      { id: "c9", createdAt: "2026-10-01T03:59:59.999Z", metadata: { formType: "contact" }, consentSource: null },
    ],
    rawLeads: [{ contactId: "c1", source: "acme-contact", sourceSite: "acme", formType: "contact" }],
    publicBookingContactIds: ["c6"],
    missedCalls: [
      { contactId: "c3", at: "2026-10-06T16:00:30.000Z" }, // texted back at 16:01
      { contactId: null, at: "2026-10-15T18:00:00.000Z" }, // unknown caller — can't be texted
      { contactId: "cX", at: "2026-10-18T10:00:00.000Z" }, // texted 2 h later → NOT a text-back
    ],
    outboundMessages: [
      { contactId: "c1", channel: "sms", at: "2026-10-02T14:03:00.000Z", workflowRunId: "r1" },
      { contactId: "c3", channel: "sms", at: "2026-10-06T16:01:00.000Z", workflowRunId: "r2" },
      { contactId: "c5", channel: "email", at: "2026-10-12T13:00:00.000Z", workflowRunId: null },
      { contactId: "cX", channel: "sms", at: "2026-10-18T12:00:00.000Z", workflowRunId: null },
    ],
    outboundCalls: [{ contactId: "c2", at: "2026-10-05T15:20:00.000Z" }],
    workflows: [
      { id: "wf-review", slug: "review-request", status: "active" },
      { id: "wf-mctb", slug: "missed-call-text-back", status: "active" },
      { id: "wf-quote", slug: "quote-follow-up", status: "draft" },
      { id: "wf-alert", slug: "new-lead-owner-alert", status: "active" },
    ],
    workflowRuns: [
      { workflowId: "wf-mctb", status: "completed", createdAt: "2026-10-02T14:00:01.000Z", completedAt: "2026-10-02T14:03:00.000Z" },
      { workflowId: "wf-mctb", status: "completed", createdAt: "2026-10-06T16:00:31.000Z", completedAt: "2026-10-06T16:01:00.000Z" },
      { workflowId: "wf-alert", status: "failed", createdAt: "2026-10-07T10:00:00.000Z", completedAt: null },
      // started in September, review sent Oct 1 → counts as a review ask, NOT an October run
      { workflowId: "wf-review", status: "completed", createdAt: "2026-09-30T20:00:00.000Z", completedAt: "2026-10-01T20:00:00.000Z" },
      { workflowId: "wf-review", status: "completed", createdAt: "2026-10-20T10:00:00.000Z", completedAt: "2026-10-21T10:00:00.000Z" },
    ],
    quotes: [
      { sentAt: "2026-10-03T12:00:00.000Z", approvedAt: "2026-10-05T12:00:00.000Z", depositPaidAt: "2026-10-05T12:05:00.000Z", approvedTotalCents: 250_000, totalCents: 240_000, approvedDepositCents: 50_000, depositCents: 48_000, currency: "cad" },
      { sentAt: "2026-10-04T12:00:00.000Z", approvedAt: null, depositPaidAt: null, approvedTotalCents: null, totalCents: 90_000, approvedDepositCents: null, depositCents: 18_000, currency: "cad" },
      { sentAt: "2026-10-08T12:00:00.000Z", approvedAt: null, depositPaidAt: null, approvedTotalCents: null, totalCents: 70_000, approvedDepositCents: null, depositCents: 14_000, currency: "cad" },
      { sentAt: "2026-10-09T12:00:00.000Z", approvedAt: null, depositPaidAt: null, approvedTotalCents: null, totalCents: 60_000, approvedDepositCents: null, depositCents: 12_000, currency: "cad" },
      // sent in September, approved in October (no approved_total snapshot → total_cents)
      { sentAt: "2026-09-20T12:00:00.000Z", approvedAt: "2026-10-02T12:00:00.000Z", depositPaidAt: null, approvedTotalCents: null, totalCents: 100_000, approvedDepositCents: null, depositCents: 20_000, currency: "cad" },
    ],
    bookings: [
      { createdAt: "2026-10-05T13:00:00.000Z", scheduledFor: "2026-10-12T13:00:00.000Z", status: "confirmed" },
      { createdAt: "2026-10-10T13:00:00.000Z", scheduledFor: "2026-10-14T13:00:00.000Z", status: "cancelled" },
      { createdAt: "2026-10-11T13:00:00.000Z", scheduledFor: "2026-10-15T13:00:00.000Z", status: "completed" },
      { createdAt: "2026-09-25T13:00:00.000Z", scheduledFor: "2026-10-03T13:00:00.000Z", status: "completed" },
    ],
    inboundCalls: [
      { at: "2026-10-05T14:58:00.000Z" },
      { at: "2026-10-06T15:59:00.000Z" },
      { at: "2026-10-22T15:00:00.000Z" },
    ],
    voiceMinutes: 42.4,
    attribution: { approvedCents: 350_000, paidCents: 50_000 },
  };
}

/** A smaller September: 5 leads (all web form), 1 job, 2 replies, $200 collected. */
export function septemberInputs(): ScorecardInputs {
  return {
    ...emptyScorecardInputs(),
    newContacts: [1, 2, 3, 4, 5].map((n) => ({
      id: `s${n}`,
      createdAt: `2026-09-0${n}T15:00:00.000Z`,
      metadata: { formType: "quote" },
      consentSource: "implied_inquiry",
    })),
    outboundMessages: [
      { contactId: "s1", channel: "sms", at: "2026-09-01T15:30:00.000Z", workflowRunId: null },
      { contactId: "s2", channel: "sms", at: "2026-09-02T15:20:00.000Z", workflowRunId: null },
    ],
    bookings: [{ createdAt: "2026-09-10T13:00:00.000Z", scheduledFor: "2026-09-20T13:00:00.000Z", status: "confirmed" }],
    attribution: { approvedCents: 80_000, paidCents: 20_000 },
  };
}
