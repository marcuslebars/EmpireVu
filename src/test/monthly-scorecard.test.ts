import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyLeadSource,
  computeScorecardMetrics,
  emptyScorecardInputs,
  median,
} from "@/server/services/monthly-scorecard/metrics";
import {
  monthKeyInTimeZone,
  monthLabel,
  monthRangeForKey,
  previousMonthKey,
  shiftMonthKey,
} from "@/server/services/monthly-scorecard/months";
import { assembleScorecard, metricDelta, parseScorecardSettings } from "@/server/services/monthly-scorecard/scorecard";
import { buildSuggestions, MAX_SUGGESTIONS } from "@/server/services/monthly-scorecard/suggestions";
import { scorecardPlatformBrandName } from "@/server/services/monthly-scorecard/platform-brand";
import { deltaText, formatDuration, renderScorecardEmail, scorecardSubject } from "@/server/templates/monthly-scorecard";
import { OCT_RANGE, SEP_RANGE, TZ, octoberInputs, septemberInputs } from "./monthly-scorecard-fixtures";

const COMPANY = { id: "co-1", name: "Maple & Sons Plumbing", timezone: TZ, created_at: "2026-01-15T12:00:00.000Z", organization_id: "org-1" };
const NOV_2 = Date.parse("2026-11-02T13:00:00.000Z");

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── Month boundaries in the company's timezone ───────────────────────────────

describe("month boundaries (America/Toronto)", () => {
  it("October 2026 runs local midnight → local midnight (EDT both ends)", () => {
    expect(monthRangeForKey(TZ, "2026-10")).toEqual(OCT_RANGE);
  });

  it("a month containing the spring-forward change starts in EST and ends in EDT", () => {
    // DST starts 2026-03-08 02:00 local: Mar 1 00:00 is UTC-5, Apr 1 00:00 is UTC-4.
    expect(monthRangeForKey(TZ, "2026-03")).toEqual({ from: "2026-03-01T05:00:00.000Z", to: "2026-04-01T04:00:00.000Z" });
  });

  it("a month containing the fall-back change starts in EDT and ends in EST", () => {
    // DST ends 2026-11-01 02:00 local: Nov 1 00:00 is still UTC-4, Dec 1 00:00 is UTC-5.
    expect(monthRangeForKey(TZ, "2026-11")).toEqual({ from: "2026-11-01T04:00:00.000Z", to: "2026-12-01T05:00:00.000Z" });
  });

  it("uses the local month, not the UTC month, around midnight UTC", () => {
    // 03:30Z on Nov 1 is still Oct 31 23:30 in Toronto.
    expect(monthKeyInTimeZone(TZ, Date.parse("2026-11-01T03:30:00Z"))).toBe("2026-10");
    expect(monthKeyInTimeZone(TZ, Date.parse("2026-11-01T04:30:00Z"))).toBe("2026-11");
  });

  it("shifts across year boundaries and labels months", () => {
    expect(previousMonthKey("2026-01")).toBe("2025-12");
    expect(shiftMonthKey("2026-12", 1)).toBe("2027-01");
    expect(monthLabel("2026-10")).toBe("October");
    expect(monthLabel("2026-10", true)).toBe("October 2026");
    expect(() => monthRangeForKey(TZ, "2026-13")).toThrow(/YYYY-MM/);
  });
});

// ── Lead source classification ───────────────────────────────────────────────

describe("classifyLeadSource", () => {
  const base = { metadata: {}, consentSource: null, rawLead: null, viaPublicBooking: false, missedCallAtCreation: false };
  it("buckets by deterministic precedence", () => {
    expect(classifyLeadSource({ ...base, metadata: { formType: "phone-lead" }, missedCallAtCreation: true })).toBe("missed_call");
    expect(classifyLeadSource({ ...base, metadata: { formType: "contact", meta: { utm: { utm_source: "Referral" } } } })).toBe("referral");
    expect(classifyLeadSource({ ...base, metadata: { formType: "phone-lead" } })).toBe("phone_ai");
    expect(classifyLeadSource({ ...base, metadata: { source: "telnyx_voice_agent" } })).toBe("phone_ai");
    expect(classifyLeadSource({ ...base, metadata: { formType: "quote" } })).toBe("web_form");
    expect(classifyLeadSource({ ...base, rawLead: { source: "x", sourceSite: "y", formType: null } })).toBe("web_form");
    expect(classifyLeadSource({ ...base, viaPublicBooking: true })).toBe("web_form");
    expect(classifyLeadSource({ ...base, consentSource: "inbound_sms" })).toBe("text");
    expect(classifyLeadSource({ ...base, metadata: null })).toBe("other");
  });
});

// ── Metrics (golden) ─────────────────────────────────────────────────────────

describe("computeScorecardMetrics — October fixture (golden)", () => {
  const metrics = computeScorecardMetrics(octoberInputs(), OCT_RANGE);

  it("counts leads by source, honouring the local-midnight boundary", () => {
    expect(metrics.leads).toEqual({
      total: 8,
      bySource: { web_form: 2, phone_ai: 1, missed_call: 1, text: 1, referral: 1, other: 2 },
    });
  });

  it("counts missed calls caught and texted back within 60 minutes", () => {
    expect(metrics.missedCalls).toEqual({ caught: 3, textedBack: 1 });
  });

  it("counts replies sent (to contacts) and the automated share", () => {
    expect(metrics.messages).toEqual({ sent: 4, automated: 2, sms: 3, email: 1 });
    expect(metrics.automationsRun).toBe(3); // two text-back runs + the Oct 20 review run (failed + Sept-started runs excluded)
  });

  it("computes the median first response from messages AND outbound calls", () => {
    // 60, 180, 1200, 3600 → (180 + 1200) / 2
    expect(metrics.firstResponse).toEqual({ medianSeconds: 690, responded: 4, within5Min: 2 });
  });

  it("counts quotes, approvals and deposits with Stripe-backed amounts", () => {
    expect(metrics.quotes).toEqual({
      sent: 4,
      approved: 2,
      approvedCents: 350_000,
      depositsCollected: 1,
      depositCents: 50_000,
      sentThenApproved: 1,
      currency: "CAD",
    });
  });

  it("counts jobs booked (not cancelled), completed jobs, review asks, receptionist + attribution", () => {
    expect(metrics.jobsBooked).toBe(2);
    expect(metrics.jobsCompleted).toBe(2);
    expect(metrics.reviewsRequested).toBe(2);
    expect(metrics.receptionist).toEqual({ callsHandled: 3, minutes: 42 });
    expect(metrics.attributedRevenue).toEqual({ approvedCents: 350_000, paidCents: 50_000 });
    expect(metrics.recipeStatus["quote-follow-up"]).toBe("draft");
  });
});

describe("empty month", () => {
  it("computes zeros and null medians without dividing by zero", () => {
    const metrics = computeScorecardMetrics(emptyScorecardInputs(), OCT_RANGE);
    expect(metrics.leads.total).toBe(0);
    expect(metrics.firstResponse.medianSeconds).toBeNull();
    expect(metrics.quotes.currency).toBe("CAD");
    expect(median([])).toBeNull();
    // Rules must not fire on 0/0 ratios; only the "no leads" rule applies.
    expect(buildSuggestions(metrics).map((s) => s.id)).toEqual(["check_lead_sources"]);
  });

  it("renders a quiet first-month email", () => {
    const card = assembleScorecard({
      company: { ...COMPANY, created_at: "2026-10-03T12:00:00.000Z" },
      month: "2026-10",
      timeZone: TZ,
      nowMs: NOV_2,
      metrics: computeScorecardMetrics(emptyScorecardInputs(), OCT_RANGE),
      previous: computeScorecardMetrics(emptyScorecardInputs(), SEP_RANGE),
      operatorNote: null,
    });
    expect(card.firstMonth).toBe(true);
    expect(card.deltas).toBeNull();
    const email = renderScorecardEmail(card, { platformBrand: "CrankLeads", reportUrl: "https://app.test/reports/monthly" });
    expect(email.subject).toBe("Your October results: a quiet month");
    expect(email.text).toContain("This is your first month on the scorecard");
    expect(email.text).toContain("Median first response: —");
    expect(email.html).not.toContain("NaN");
    expect(email.text).not.toContain("NaN");
  });
});

// ── Deltas ───────────────────────────────────────────────────────────────────

describe("deltas", () => {
  it("returns a null percent when the previous value was 0", () => {
    expect(metricDelta(5, 0)).toEqual({ current: 5, previous: 0, change: 5, pct: null });
    expect(metricDelta(8, 5)).toEqual({ current: 8, previous: 5, change: 3, pct: 60 });
    expect(metricDelta(0, 4)).toEqual({ current: 0, previous: 4, change: -4, pct: -100 });
  });

  it("compares October with September", () => {
    const card = assembleScorecard({
      company: COMPANY,
      month: "2026-10",
      timeZone: TZ,
      nowMs: NOV_2,
      metrics: computeScorecardMetrics(octoberInputs(), OCT_RANGE),
      previous: computeScorecardMetrics(septemberInputs(), SEP_RANGE),
      operatorNote: null,
    });
    expect(card.firstMonth).toBe(false);
    expect(card.partial).toBe(false);
    expect(card.deltas?.leads).toEqual({ current: 8, previous: 5, change: 3, pct: 60 });
    expect(card.deltas?.jobsBooked).toEqual({ current: 2, previous: 1, change: 1, pct: 100 });
    expect(card.deltas?.medianResponseSeconds).toEqual({ current: 690, previous: 1500, change: -810, pct: -54 });
    expect(deltaText(card.deltas?.leads ?? null, "2026-09")).toBe("▲ 3 vs Sep");
    expect(deltaText(metricDelta(2, 2), "2026-09")).toBe("same as Sep");
    expect(deltaText(metricDelta(10_000, 30_000), "2026-09", "CAD")).toBe("▼ $200.00 vs Sep");
  });

  it("marks the current month as partial", () => {
    const card = assembleScorecard({
      company: COMPANY,
      month: "2026-11",
      timeZone: TZ,
      nowMs: NOV_2,
      metrics: computeScorecardMetrics(emptyScorecardInputs(), OCT_RANGE),
      previous: computeScorecardMetrics(octoberInputs(), OCT_RANGE),
      operatorNote: "  ",
    });
    expect(card.partial).toBe(true);
    expect(card.operatorNote).toBeNull();
  });
});

// ── Suggestions ──────────────────────────────────────────────────────────────

describe("buildSuggestions", () => {
  it("fires the October rules in priority order (golden)", () => {
    const suggestions = buildSuggestions(computeScorecardMetrics(octoberInputs(), OCT_RANGE));
    expect(suggestions.map((s) => [s.id, s.recipeSlug])).toEqual([
      ["missed_call_text_back_gaps", null], // recipe is active → tune it, don't "turn it on"
      ["enable_quote_follow_up", "quote-follow-up"], // 1 of 4 approved, recipe is a draft
    ]);
    expect(suggestions[1].detail).toBe(
      "3 of 4 quotes sent are still waiting on approval. An automatic text-then-email nudge recovers quotes that would otherwise go cold.",
    );
  });

  it("suggests enabling recipes that are off, and caps at three", () => {
    const inputs = octoberInputs();
    inputs.workflows = []; // nothing installed
    inputs.workflowRuns = []; // no review asks
    // Slow responses: push every touch 2 h after creation.
    inputs.outboundMessages = inputs.outboundMessages.map((m) => ({ ...m, at: new Date(Date.parse(m.at) + 2 * 3_600_000).toISOString() }));
    inputs.outboundCalls = [];
    const ids = buildSuggestions(computeScorecardMetrics(inputs, OCT_RANGE)).map((s) => s.id);
    expect(ids).toEqual(["enable_missed_call_text_back", "enable_new_lead_alert", "enable_quote_follow_up"]);
    expect(ids.length).toBe(MAX_SUGGESTIONS);
  });

  it("asks for reviews when completed jobs outnumber review requests", () => {
    const inputs = octoberInputs();
    inputs.missedCalls = [];
    inputs.quotes = [];
    inputs.workflowRuns = [];
    const ids = buildSuggestions(computeScorecardMetrics(inputs, OCT_RANGE)).map((s) => s.id);
    expect(ids).toEqual(["more_review_asks"]);
  });
});

// ── Email rendering (golden) ─────────────────────────────────────────────────

describe("renderScorecardEmail", () => {
  const card = assembleScorecard({
    company: COMPANY,
    month: "2026-10",
    timeZone: TZ,
    nowMs: NOV_2,
    metrics: computeScorecardMetrics(octoberInputs(), OCT_RANGE),
    previous: computeScorecardMetrics(septemberInputs(), SEP_RANGE),
    operatorNote: "We're rewriting your quote follow-up <script>.",
  });

  it("builds the subject from leads caught + jobs booked", () => {
    expect(scorecardSubject(card)).toBe("Your October results: 8 leads caught, 2 jobs booked");
    expect(scorecardSubject({ ...card, metrics: { ...card.metrics, leads: { ...card.metrics.leads, total: 1 }, jobsBooked: 1 } })).toBe(
      "Your October results: 1 lead caught, 1 job booked",
    );
  });

  it("renders the key lines in the text part (golden)", () => {
    const email = renderScorecardEmail(card, { platformBrand: "CrankLeads", reportUrl: "https://app.test/reports/monthly" });
    const lines = email.text.split("\n");
    expect(lines[0]).toBe("Maple & Sons Plumbing — October 2026 results");
    expect(lines).toContain("Here's how October went, compared with September.");
    expect(lines).toContain("Leads caught: 8 · Replies sent: 4 · Jobs booked: 2");
    expect(lines).toContain("- New leads: 8 (▲ 3 vs Sep)");
    expect(lines).toContain("    Missed-call catcher: 1");
    expect(lines).toContain("- Missed calls caught: 3 (1 texted back)");
    expect(lines).toContain("- Replies sent: 4 (2 automatic)");
    expect(lines).toContain("- Median first response: 12 min (was 25 min in Sep)");
    expect(lines).toContain("- Quotes approved: 2 ($3,500.00)");
    expect(lines).toContain("- Deposits collected: 1 ($500.00)");
    expect(lines).toContain("- Jobs booked: 2 (▲ 1 vs Sep)");
    expect(lines).toContain("- AI receptionist calls: 3 (42 min on the phone)");
    expect(lines).toContain("- Revenue we helped win: $500.00 (collected · $3,500.00 approved)");
    expect(lines).toContain("1. Close the gaps on missed-call text-backs. Only 1 of 3 missed calls got a text back. We'll check caller numbers and the SMS setup so every missed caller hears from you.");
    expect(lines).toContain("A note from your account team:");
    expect(lines).toContain("See your full results: https://app.test/reports/monthly");
    expect(lines[lines.length - 1]).toBe("Sent by CrankLeads for Maple & Sons Plumbing. Questions? Just reply to this email.");
  });

  it("renders mobile-friendly, escaped HTML with the company name prominent", () => {
    const email = renderScorecardEmail(card, { platformBrand: "CrankLeads", reportUrl: "https://app.test/reports/monthly", primaryColor: "#0a7" });
    expect(email.html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
    expect(email.html).toContain("max-width:560px");
    expect(email.html).toContain("<h1 style=\"margin:6px 0 0;font-size:26px;line-height:1.2;color:#111827\">Maple &amp; Sons Plumbing</h1>");
    expect(email.html).toContain("Monthly results · October 2026");
    expect(email.html).toContain("What we're tuning next");
    expect(email.html).toContain("rewriting your quote follow-up &lt;script&gt;.");
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain('href="https://app.test/reports/monthly"');
  });

  it("formats durations for humans", () => {
    expect(formatDuration(30)).toBe("under a minute");
    expect(formatDuration(690)).toBe("12 min");
    expect(formatDuration(5400)).toBe("1.5 hours");
    expect(formatDuration(null)).toBe("—");
  });
});

// ── Settings + branding ──────────────────────────────────────────────────────

describe("settings and branding", () => {
  it("is opt-out: only an explicit enabled:false turns the scorecard off", () => {
    expect(parseScorecardSettings(null)).toEqual({ enabled: true });
    expect(parseScorecardSettings({})).toEqual({ enabled: true });
    expect(parseScorecardSettings({ enabled: false })).toEqual({ enabled: false });
    expect(parseScorecardSettings([])).toEqual({ enabled: true });
  });

  it("reads the platform brand from ONE env var with a CrankLeads default", () => {
    vi.stubEnv("PLATFORM_BRAND_NAME", "");
    expect(scorecardPlatformBrandName()).toBe("CrankLeads");
    vi.stubEnv("PLATFORM_BRAND_NAME", "  Acme Leads ");
    expect(scorecardPlatformBrandName()).toBe("Acme Leads");
  });
});
