/**
 * Daily operator health email (docs/operator-health.md): every flag rule (with its edge
 * cases — cancelled, business days, timezone, thresholds), ordering + "+N more" caps, the
 * all-clear decision, the renderer (golden snapshots), the loader against the in-memory
 * PostgREST fake, and the scheduled run's claim-before-send idempotency.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "./helpers/fake-supabase";
import { failingSinceFrom, loadOperatorHealthFacts, type LoadFactsInput } from "@/server/services/operator-health/load";
import { escapeHtml, operatorHealthSubject, renderOperatorHealthEmail } from "@/server/services/operator-health/render";
import {
  buildOperatorHealthReport,
  businessDaysElapsed,
  decideDelivery,
  forwardingItem,
  testCallFailureItem,
  isReportDue,
  paymentItem,
  provisioningItem,
  queueItem,
  setupBusinessDays,
  setupItem,
  silentItem,
  supportItem,
  type ForwardingFact,
  type OperatorHealthFacts,
  type PaymentFact,
  type ProvisioningFact,
  type QueueFact,
  type SetupFact,
  type SilentFact,
  type SupportFact,
} from "@/server/services/operator-health/rules";
import {
  parseOperatorHealthArgs,
  processOperatorHealth,
  readOperatorHealthConfig,
  resetOperatorHealthMemo,
  runOperatorHealthJob,
  type OperatorHealthConfig,
  type OperatorHealthDeps,
} from "@/server/services/operator-health/service";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TZ = "America/Toronto";
const APP = "https://app.empirevu.test";
const STRIPE = "https://dashboard.stripe.com";

/** Monday 2026-10-05 07:31 in Toronto (EDT, UTC-4). */
const NOW = Date.parse("2026-10-05T11:31:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const CTX = { nowMs: NOW, stripeDashboardBase: STRIPE, graceDays: 7, timeZone: TZ };

function setupFact(over: Partial<SetupFact> = {}): SetupFact {
  return {
    organizationId: "org-setup",
    businessName: "Northside Plumbing",
    tier: "close",
    stripeCustomerId: "cus_setup",
    purchaseId: "p-setup",
    // Monday Sep 28 10:00 Toronto → 5 business days by Monday Oct 5.
    provisionedAt: "2026-09-28T14:00:00.000Z",
    timeZone: TZ,
    subscriptionStatus: "active",
    remindersStopped: false,
    checklist: {
      doneCount: 2,
      totalCount: 6,
      isLive: false,
      nextStepTitle: "Turn on call forwarding",
      nextStepLink: `${APP}/onboarding?step=phone&org=org-setup`,
    },
    ownerName: "Pat Owner",
    ownerEmail: "pat@northside.test",
    ownerPhone: "+14165550101",
    ...over,
  };
}

function forwardingFact(over: Partial<ForwardingFact> = {}): ForwardingFact {
  return {
    organizationId: "org-fwd",
    businessName: "Lakeside Roofing",
    tier: "catch",
    stripeCustomerId: "cus_fwd",
    voiceNumberId: "vn-1",
    catcherNumber: "+17055550000",
    lastResult: "not_forwarded",
    lastTestAt: ago(2 * HOUR),
    failingSince: ago(26 * HOUR),
    lastTestError: null,
    everWorked: true,
    accountLive: true,
    subscriptionStatus: "active",
    activateCode: "**004*7055550000#",
    fixLink: `${APP}/onboarding?step=phone&org=org-fwd`,
    ...over,
  };
}

function paymentFact(over: Partial<PaymentFact> = {}): PaymentFact {
  return {
    organizationId: "org-pay",
    businessName: "Pine Ridge HVAC",
    tier: "front_desk",
    stripeCustomerId: "cus_pay",
    plan: "front_desk",
    subscriptionStatus: "past_due",
    since: ago(3 * DAY),
    currentPeriodEnd: ago(3 * DAY),
    stripeSubscriptionId: "sub_pay",
    ...over,
  };
}

function provisioningFact(over: Partial<ProvisioningFact> = {}): ProvisioningFact {
  return {
    purchaseId: "p-fail",
    businessName: "Harbour Electric",
    tier: "catch",
    status: "failed",
    sessionId: "cs_test_abc123",
    stripeCustomerId: "cus_fail",
    lastError: "auth user create failed: email rate limit",
    attempts: 3,
    paidAt: ago(5 * HOUR),
    failedAt: ago(4 * HOUR),
    createdAt: ago(6 * HOUR),
    updatedAt: ago(4 * HOUR),
    ...over,
  };
}

function silentFact(over: Partial<SilentFact> = {}): SilentFact {
  return {
    organizationId: "org-quiet",
    businessName: "Quiet Pools",
    tier: "catch",
    stripeCustomerId: "cus_quiet",
    liveAt: ago(30 * DAY),
    subscriptionStatus: "active",
    newContacts: 0,
    missedCalls: 0,
    aiCalls: 0,
    ...over,
  };
}

function supportFact(over: Partial<SupportFact> = {}): SupportFact {
  return {
    id: "sr-1",
    organizationId: "org-sup",
    businessName: "Maple Landscaping",
    tier: "close",
    requesterEmail: "help@maple.test",
    question: "How do I change the text that goes out after a missed call?",
    status: "open",
    createdAt: ago(30 * HOUR),
    ...over,
  };
}

function queueFact(over: Partial<QueueFact> = {}): QueueFact {
  return {
    key: "inbound_webhooks",
    label: "Inbound webhooks (calls, texts)",
    table: "inbound_webhook_jobs",
    service: "worker (npm run worker:workflow-events)",
    failedStatuses: ["failed"],
    failedRecent: 0,
    pending: 0,
    oldestReadyAt: null,
    ...over,
  };
}

function emptyFacts(over: Partial<OperatorHealthFacts> = {}): OperatorHealthFacts {
  return {
    nowMs: NOW,
    timeZone: TZ,
    appBaseUrl: APP,
    stripeDashboardBase: STRIPE,
    graceDays: 7,
    setup: [],
    forwarding: [],
    payments: [],
    provisioning: [],
    silent: [],
    support: [],
    queues: [],
    errors: [],
    ...over,
  };
}

/** One of everything — the golden fixture. */
function fullFacts(): OperatorHealthFacts {
  return emptyFacts({
    provisioning: [provisioningFact()],
    forwarding: [forwardingFact()],
    setup: [
      setupFact(),
      setupFact({
        purchaseId: "p-late",
        organizationId: "org-late",
        businessName: "Late Start Cleaning",
        tier: "catch",
        // Thursday Sep 24 → 7 business days by Monday Oct 5.
        provisionedAt: "2026-09-24T14:00:00.000Z",
        remindersStopped: true,
        stripeCustomerId: null,
        ownerName: "Jordan Lee",
        ownerEmail: "jordan@latestart.test",
        ownerPhone: "+16475550199",
        checklist: {
          doneCount: 1,
          totalCount: 5,
          isLive: false,
          nextStepTitle: "Add your prices",
          nextStepLink: `${APP}/onboarding?step=services&org=org-late`,
        },
      }),
    ],
    payments: [paymentFact()],
    support: [supportFact()],
    silent: [silentFact()],
    queues: [queueFact({ failedRecent: 2, pending: 1 })],
  });
}

// ── Business days + timezone ─────────────────────────────────────────────────

describe("businessDaysElapsed / setupBusinessDays", () => {
  it("counts Mon–Fri strictly after the start date, weekends never count", () => {
    expect(businessDaysElapsed("2026-10-05", "2026-10-05")).toBe(0);
    expect(businessDaysElapsed("2026-10-02", "2026-10-05")).toBe(1); // Fri → Mon
    expect(businessDaysElapsed("2026-10-03", "2026-10-05")).toBe(1); // Sat → Mon
    expect(businessDaysElapsed("2026-09-28", "2026-10-05")).toBe(5); // Mon → Mon
    expect(businessDaysElapsed("2026-10-05", "2026-10-01")).toBe(0); // end before start
  });

  it("counts in the company's timezone (a late-evening Toronto provisioning is the previous UTC day)", () => {
    // 2026-09-29T03:30Z = Mon Sep 28 23:30 in Toronto, Tue Sep 29 in UTC.
    const provisionedAt = "2026-09-29T03:30:00.000Z";
    expect(setupBusinessDays({ provisionedAt, timeZone: TZ }, NOW)).toBe(5);
    expect(setupBusinessDays({ provisionedAt, timeZone: "UTC" }, NOW)).toBe(4);
  });
});

// ── Rule: setup stalled ──────────────────────────────────────────────────────

describe("setup stalled rule", () => {
  it("flags at exactly 5 business days: guarantee deadline today (high)", () => {
    const item = setupItem(setupFact(), CTX);
    expect(item).not.toBeNull();
    expect(item?.severity).toBe("high");
    expect(item?.guaranteeAtRisk).toBe(true);
    expect(item?.problem).toContain("Not live after 5 business days — setup 2/6 done, next: Turn on call forwarding.");
    expect(item?.problem).toContain("deadline is today");
    expect(item?.action).toBe('Call Pat Owner (+14165550101, pat@northside.test) and walk them through "Turn on call forwarding".');
    expect(item?.links.map((l) => l.url)).toEqual([`${APP}/onboarding?step=phone&org=org-setup`, `${STRIPE}/customers/cus_setup`]);
  });

  it("is critical once past the guarantee window", () => {
    const item = setupItem(setupFact({ provisionedAt: "2026-09-24T14:00:00.000Z" }), CTX);
    expect(item?.severity).toBe("critical");
    expect(item?.problem).toContain("2 business days past the 5-business-day live deadline");
  });

  it("gives an early warning at 3–4 business days (medium, not yet at risk)", () => {
    // Tuesday Sep 29 → Fri(3) … Mon Oct 5 = 4 business days.
    const item = setupItem(setupFact({ provisionedAt: "2026-09-29T14:00:00.000Z" }), CTX);
    expect(item?.severity).toBe("medium");
    expect(item?.guaranteeAtRisk).toBe(false);
    expect(item?.problem).toContain("Early warning: the 5-business-day live deadline is in 1 business day");
  });

  it("does not flag before 3 business days (weekend does not count)", () => {
    // Thursday Oct 1 → Fri(1), Mon Oct 5(2) = 2 business days.
    expect(setupItem(setupFact({ provisionedAt: "2026-10-01T14:00:00.000Z" }), CTX)).toBeNull();
  });

  it("skips cancelled subscriptions and accounts whose checklist is already live", () => {
    expect(setupItem(setupFact({ subscriptionStatus: "canceled" }), CTX)).toBeNull();
    const live = setupFact();
    live.checklist = { doneCount: 6, totalCount: 6, isLive: true, nextStepTitle: null, nextStepLink: null };
    expect(setupItem(live, CTX)).toBeNull();
  });

  it("still flags when the checklist could not be loaded, and notes reminders turned off", () => {
    const item = setupItem(setupFact({ checklist: null, remindersStopped: true }), CTX);
    expect(item?.problem).toContain("setup checklist unavailable");
    expect(item?.problem).toContain("turned off the automatic reminders");
    expect(item?.action).toBe("Call Pat Owner (+14165550101, pat@northside.test).");
  });
});

// ── Rule: forwarding broken ──────────────────────────────────────────────────

describe("forwarding broken rule", () => {
  it("flags a live account whose forwarding stopped (critical) with the carrier code", () => {
    const item = forwardingItem(forwardingFact(), CTX);
    expect(item?.severity).toBe("critical");
    expect(item?.howLong).toBe("failing for 26h");
    expect(item?.action).toContain("**004*7055550000#");
    expect(item?.problem).toContain("(705) 555-0000");
  });

  it("flags a number that worked before even if the account is not live yet (high)", () => {
    expect(forwardingItem(forwardingFact({ accountLive: false }), CTX)?.severity).toBe("high");
  });

  it("ignores a number that never worked on a not-live account (that is a setup problem)", () => {
    expect(forwardingItem(forwardingFact({ everWorked: false, accountLive: false }), CTX)).toBeNull();
  });

  it("ignores inconclusive / passing results and cancelled accounts", () => {
    expect(forwardingItem(forwardingFact({ lastResult: "answered" }), CTX)).toBeNull();
    expect(forwardingItem(forwardingFact({ lastResult: "busy" }), CTX)).toBeNull();
    expect(forwardingItem(forwardingFact({ lastResult: "passed" }), CTX)).toBeNull();
    expect(forwardingItem(forwardingFact({ subscriptionStatus: "canceled" }), CTX)).toBeNull();
  });

  it("a 'failed' test (our side) is NEVER reported as customer forwarding broken", () => {
    expect(forwardingItem(forwardingFact({ lastResult: "failed" }), CTX)).toBeNull();
  });

  it("failingSince = first not_forwarded after the most recent pass ('answered' / 'failed' skipped)", () => {
    const t = (status: string, started_at: string) => ({ voice_number_id: "vn", status, started_at });
    expect(
      failingSinceFrom([
        t("passed", "2026-09-01T00:00:00Z"),
        t("not_forwarded", "2026-09-03T00:00:00Z"),
        t("answered", "2026-09-04T00:00:00Z"),
        t("failed", "2026-09-05T00:00:00Z"),
      ]),
    ).toBe("2026-09-03T00:00:00Z");
    expect(failingSinceFrom([t("passed", "2026-09-05T00:00:00Z")])).toBeNull();
    expect(failingSinceFrom([t("passed", "2026-09-01T00:00:00Z"), t("failed", "2026-09-02T00:00:00Z")])).toBeNull();
  });
});

describe("forwarding test-call failure rule (infrastructure)", () => {
  it("reports a 'failed' last test as OUR problem (medium), with the Twilio error, for any non-cancelled account", () => {
    const item = testCallFailureItem(
      forwardingFact({ lastResult: "failed", lastTestError: "The 'To' number is not valid.", everWorked: false, accountLive: false }),
      CTX,
    );
    expect(item?.severity).toBe("medium");
    expect(item?.problem).toContain("(705) 555-0000");
    expect(item?.problem).toContain("The 'To' number is not valid.");
    expect(item?.problem).toContain("not the customer's forwarding");
    expect(item?.action).toContain("Twilio console");
    expect(item?.howLong).toBe("last attempt 2h ago");
  });

  it("ignores not_forwarded / inconclusive results and cancelled accounts", () => {
    expect(testCallFailureItem(forwardingFact(), CTX)).toBeNull();
    expect(testCallFailureItem(forwardingFact({ lastResult: "busy" }), CTX)).toBeNull();
    expect(testCallFailureItem(forwardingFact({ lastResult: "failed", subscriptionStatus: "canceled" }), CTX)).toBeNull();
  });

  it("lands in its own section, not 'Call forwarding broken'", () => {
    const report = buildOperatorHealthReport(emptyFacts({ forwarding: [forwardingFact({ lastResult: "failed" })] }));
    expect(report.sections.map((s) => s.key)).toEqual(["test_calls"]);
    expect(report.sections[0].title).toBe("Forwarding test calls failing (our side)");
  });
});

// ── Rule: payments ───────────────────────────────────────────────────────────

describe("payment problem rule", () => {
  it("past due inside the grace window is high and says when features turn off", () => {
    const item = paymentItem(paymentFact(), CTX);
    expect(item?.severity).toBe("high");
    // period ended Fri Oct 2 + 7 grace days → Fri Oct 9 (operator timezone)
    expect(item?.problem).toBe("Payment failed — subscription past due; paid features turn off Fri, Oct 9.");
    expect(item?.links.map((l) => l.url)).toEqual([`${STRIPE}/customers/cus_pay`, `${STRIPE}/subscriptions/sub_pay`]);
  });

  it("past the grace window is critical (features are off)", () => {
    const item = paymentItem(paymentFact({ currentPeriodEnd: ago(10 * DAY) }), CTX);
    expect(item?.severity).toBe("critical");
    expect(item?.problem).toContain("paid features are OFF");
  });

  it("ignores healthy, cancelled and internal-plan orgs", () => {
    expect(paymentItem(paymentFact({ subscriptionStatus: "active" }), CTX)).toBeNull();
    expect(paymentItem(paymentFact({ subscriptionStatus: "canceled" }), CTX)).toBeNull();
    expect(paymentItem(paymentFact({ plan: "internal" }), CTX)).toBeNull();
  });
});

// ── Rule: provisioning ───────────────────────────────────────────────────────

describe("provisioning failure rule", () => {
  it("a failed purchase is critical with the exact re-run command", () => {
    const item = provisioningItem(provisioningFact(), CTX);
    expect(item?.severity).toBe("critical");
    expect(item?.action).toBe("Fix the cause, then re-run: npm run job:crankleads-provision -- --session cs_test_abc123");
    expect(item?.problem).toContain("3 attempts");
    expect(item?.howLong).toBe("5h since payment");
  });

  it("stuck in paid/provisioning only after 60 minutes", () => {
    expect(provisioningItem(provisioningFact({ status: "provisioning", updatedAt: ago(30 * 60_000) }), CTX)).toBeNull();
    const stuck = provisioningItem(provisioningFact({ status: "paid", updatedAt: ago(2 * HOUR) }), CTX);
    expect(stuck?.problem).toContain('stuck in "paid" for 2h');
  });

  it("ignores abandoned checkouts, provisioned purchases and failures older than 30 days", () => {
    expect(provisioningItem(provisioningFact({ status: "checkout_created", updatedAt: ago(5 * HOUR) }), CTX)).toBeNull();
    expect(provisioningItem(provisioningFact({ status: "provisioned" }), CTX)).toBeNull();
    expect(provisioningItem(provisioningFact({ failedAt: ago(31 * DAY), updatedAt: ago(31 * DAY) }), CTX)).toBeNull();
  });

  it("without a session id the hint says where to find it", () => {
    expect(provisioningItem(provisioningFact({ sessionId: null }), CTX)?.action).toContain("--session cs_…");
  });
});

// ── Rule: silent accounts ────────────────────────────────────────────────────

describe("silent account rule", () => {
  it("flags a paying account live ≥ 14 days with zero activity (low)", () => {
    expect(silentItem(silentFact(), CTX)?.severity).toBe("low");
  });

  it("any lead, missed call or AI call clears it", () => {
    expect(silentItem(silentFact({ newContacts: 1 }), CTX)).toBeNull();
    expect(silentItem(silentFact({ missedCalls: 1 }), CTX)).toBeNull();
    expect(silentItem(silentFact({ aiCalls: 1 }), CTX)).toBeNull();
  });

  it("skips accounts live < 14 days and non-paying (cancelled / past due) ones", () => {
    expect(silentItem(silentFact({ liveAt: ago(10 * DAY) }), CTX)).toBeNull();
    expect(silentItem(silentFact({ subscriptionStatus: "canceled" }), CTX)).toBeNull();
    expect(silentItem(silentFact({ subscriptionStatus: "past_due" }), CTX)).toBeNull();
  });
});

// ── Rule: support ────────────────────────────────────────────────────────────

describe("open support request rule", () => {
  it("flags open requests older than 24h, high after 72h", () => {
    expect(supportItem(supportFact({ createdAt: ago(23 * HOUR) }), CTX)).toBeNull();
    expect(supportItem(supportFact(), CTX)?.severity).toBe("medium");
    expect(supportItem(supportFact({ createdAt: ago(80 * HOUR) }), CTX)?.severity).toBe("high");
    expect(supportItem(supportFact({ status: "closed" }), CTX)).toBeNull();
  });

  it("the action is the reply + the exact close statement", () => {
    expect(supportItem(supportFact(), CTX)?.action).toBe(
      "Reply to help@maple.test, then close it: update support_requests set status = 'closed' where id = 'sr-1';",
    );
  });
});

// ── Rule: queues ─────────────────────────────────────────────────────────────

describe("queue health rule", () => {
  it("dead-lettered jobs in the last 24h are high", () => {
    const item = queueItem(queueFact({ failedRecent: 2 }), CTX);
    expect(item?.severity).toBe("high");
    expect(item?.action).toContain("select id, last_error from inbound_webhook_jobs where status in ('failed')");
  });

  it("a ready job unclaimed ≥ 30 min is critical (worker down)", () => {
    const item = queueItem(queueFact({ oldestReadyAt: ago(45 * 60_000), pending: 12 }), CTX);
    expect(item?.severity).toBe("critical");
    expect(item?.problem).toContain("waited 45 min (12 jobs pending)");
  });

  it("a healthy queue (recent pending, no failures) is not flagged", () => {
    expect(queueItem(queueFact({ oldestReadyAt: ago(10 * 60_000), pending: 3 }), CTX)).toBeNull();
  });
});

// ── Builder: ordering, caps, totals ──────────────────────────────────────────

describe("buildOperatorHealthReport", () => {
  it("orders sections by severity, items by severity then age, and counts guarantees", () => {
    const report = buildOperatorHealthReport(fullFacts());
    expect(report.reportDate).toBe("2026-10-05");
    expect(report.sections.map((s) => s.key)).toEqual(["provisioning", "forwarding", "setup", "queues", "payments", "support", "silent"]);
    expect(report.sections.find((s) => s.key === "setup")?.items.map((i) => i.account)).toEqual([
      "Late Start Cleaning",
      "Northside Plumbing",
    ]);
    expect(report.totalItems).toBe(8);
    expect(report.guaranteeAtRisk).toBe(2);
    expect(report.criticalCount).toBe(3);
  });

  it("a high-only section sorts below a critical one even if listed earlier", () => {
    const report = buildOperatorHealthReport(
      emptyFacts({
        forwarding: [forwardingFact({ accountLive: false })], // high
        queues: [queueFact({ oldestReadyAt: ago(2 * HOUR) })], // critical
      }),
    );
    expect(report.sections.map((s) => s.key)).toEqual(["queues", "forwarding"]);
  });

  it("caps each section with +N more, but totals count everything", () => {
    const support = Array.from({ length: 11 }, (_, i) => supportFact({ id: `sr-${i}`, createdAt: ago((30 + i) * HOUR) }));
    const report = buildOperatorHealthReport(emptyFacts({ support }));
    const section = report.sections[0];
    expect(section.items).toHaveLength(8);
    expect(section.hiddenCount).toBe(3);
    expect(section.total).toBe(11);
    expect(report.totalItems).toBe(11);
    expect(section.items[0].ageMs).toBeGreaterThan(section.items[7].ageMs);
    expect(buildOperatorHealthReport(emptyFacts({ support }), { maxItemsPerSection: Infinity }).sections[0].hiddenCount).toBe(0);
  });

  it("a section that could not be checked is reported, never mistaken for all clear", () => {
    const report = buildOperatorHealthReport(emptyFacts({ errors: [{ section: "payments", message: "timeout" }] }));
    expect(report.totalItems).toBe(1);
    expect(report.sections[0].key).toBe("checks");
    expect(report.sections[0].items[0].problem).toBe("Couldn't check payments: timeout");
  });

  it("nothing flagged → empty report", () => {
    const report = buildOperatorHealthReport(
      emptyFacts({ setup: [setupFact({ subscriptionStatus: "canceled" })], queues: [queueFact()] }),
    );
    expect(report.totalItems).toBe(0);
    expect(report.sections).toEqual([]);
  });
});

// ── Delivery decisions ───────────────────────────────────────────────────────

describe("delivery decisions", () => {
  it("report when anything is flagged, any day", () => {
    expect(decideDelivery({ totalItems: 2 }, "weekly", 3)).toBe("report");
    expect(decideDelivery({ totalItems: 2 }, "never", 3)).toBe("report");
  });

  it("all clear only on Monday in weekly mode; otherwise quiet", () => {
    expect(decideDelivery({ totalItems: 0 }, "weekly", 1)).toBe("all_clear");
    expect(decideDelivery({ totalItems: 0 }, "weekly", 2)).toBe("quiet");
    expect(decideDelivery({ totalItems: 0 }, "never", 1)).toBe("quiet");
  });

  it("report time is 07:30 operator-local", () => {
    expect(isReportDue({ hour: 7, minute: 29 })).toBe(false);
    expect(isReportDue({ hour: 7, minute: 30 })).toBe(true);
    expect(isReportDue({ hour: 23, minute: 0 })).toBe(true);
  });
});

// ── Renderer (golden) ────────────────────────────────────────────────────────

describe("renderOperatorHealthEmail", () => {
  it("subject counts items and guarantees at risk", () => {
    const report = buildOperatorHealthReport(fullFacts());
    expect(operatorHealthSubject(report)).toBe("CrankLeads health: 8 need you (2 guarantee at risk)");
    const one = buildOperatorHealthReport(emptyFacts({ support: [supportFact()] }));
    expect(operatorHealthSubject(one)).toBe("CrankLeads health: 1 needs you");
    expect(operatorHealthSubject(buildOperatorHealthReport(emptyFacts()))).toBe("CrankLeads health: all clear");
  });

  it("golden: full report (text + html)", () => {
    const email = renderOperatorHealthEmail(buildOperatorHealthReport(fullFacts()), { allClearMode: "weekly" });
    expect(email.fromName).toBe("CrankLeads ops");
    expect(email.text).toMatchSnapshot();
    expect(email.html).toMatchSnapshot();
  });

  it("golden: weekly all clear", () => {
    const email = renderOperatorHealthEmail(buildOperatorHealthReport(emptyFacts()), { allClearMode: "weekly" });
    expect(email.subject).toBe("CrankLeads health: all clear");
    expect(email.text).toMatchSnapshot();
  });

  it("renders +N more and escapes tenant-supplied text in html", () => {
    const support = Array.from({ length: 10 }, (_, i) =>
      supportFact({ id: `sr-${i}`, businessName: `<b>Evil & Co ${i}</b>`, question: `<script>alert(${i})</script>` }),
    );
    const email = renderOperatorHealthEmail(buildOperatorHealthReport(emptyFacts({ support })), { allClearMode: "never" });
    expect(email.text).toContain("+2 more — npm run job:operator-health -- --dry-run --all");
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain(escapeHtml("<b>Evil & Co 0</b>"));
    expect(email.text).not.toContain("all-clear on Mondays");
  });
});

// ── Config + CLI args ────────────────────────────────────────────────────────

describe("config", () => {
  it("defaults: on when OWNER_EMAIL is set, weekly all-clear, Toronto, live Stripe dashboard", () => {
    const config = readOperatorHealthConfig({ OWNER_EMAIL: "marcus@example.test" });
    expect(config).toMatchObject({
      enabled: true,
      recipient: "marcus@example.test",
      allClearMode: "weekly",
      timeZone: "America/Toronto",
      appBaseUrl: "http://localhost:3000",
      stripeDashboardBase: "https://dashboard.stripe.com",
    });
  });

  it("off without OWNER_EMAIL or when switched off; never mode; test-mode Stripe; bad timezone falls back", () => {
    expect(readOperatorHealthConfig({}).enabled).toBe(false);
    expect(readOperatorHealthConfig({ OWNER_EMAIL: "m@x.test", OPERATOR_HEALTH_ENABLED: "false" }).enabled).toBe(false);
    expect(readOperatorHealthConfig({ OWNER_EMAIL: "m@x.test", OPERATOR_HEALTH_ALL_CLEAR: "never" }).allClearMode).toBe("never");
    expect(readOperatorHealthConfig({ STRIPE_SECRET_KEY: "sk_test_123" }).stripeDashboardBase).toBe("https://dashboard.stripe.com/test");
    expect(readOperatorHealthConfig({ BUSINESS_TIMEZONE: "Mars/Olympus" }).timeZone).toBe("America/Toronto");
    expect(readOperatorHealthConfig({ BUSINESS_TIMEZONE: "America/Vancouver" }).timeZone).toBe("America/Vancouver");
  });

  it("CLI args: dry run by default, --send sends, --dry-run wins, --all uncaps", () => {
    expect(parseOperatorHealthArgs([])).toEqual({ dryRun: true, send: false, all: false });
    expect(parseOperatorHealthArgs(["--send"])).toEqual({ dryRun: false, send: true, all: false });
    expect(parseOperatorHealthArgs(["--send", "--dry-run", "--all"])).toEqual({ dryRun: true, send: true, all: true });
  });
});

// ── Loader (in-memory PostgREST fake) ────────────────────────────────────────

const INPUT: LoadFactsInput = { nowMs: NOW, timeZone: TZ, appBaseUrl: APP, stripeDashboardBase: STRIPE, graceDays: 7 };

function seed(): Record<string, Array<Record<string, unknown>>> {
  return {
    organizations: [
      { id: "org-a", name: "Alpha Plumbing", crankleads_tier: "catch", plan: "operate", subscription_status: "active", stripe_customer_id: "cus_a", updated_at: ago(40 * DAY) },
      { id: "org-b", name: "Beta Roofing", crankleads_tier: "close", plan: "operate", subscription_status: "past_due", stripe_customer_id: "cus_b", updated_at: ago(2 * DAY) },
      { id: "org-c", name: "Gamma (cancelled)", crankleads_tier: "catch", plan: "operate", subscription_status: "canceled", stripe_customer_id: null, updated_at: ago(2 * DAY) },
      { id: "org-house", name: "House", crankleads_tier: null, plan: "internal", subscription_status: "past_due", stripe_customer_id: null, updated_at: ago(2 * DAY) },
      { id: "org-live", name: "Live & Quiet", crankleads_tier: "catch", plan: "operate", subscription_status: "active", stripe_customer_id: "cus_l", updated_at: ago(40 * DAY) },
    ],
    companies: [
      { id: "co-a", organization_id: "org-a", name: "Alpha Plumbing", timezone: TZ, stripe_charges_enabled: false },
      { id: "co-c", organization_id: "org-c", name: "Gamma", timezone: TZ, stripe_charges_enabled: false },
      { id: "co-live", organization_id: "org-live", name: "Live & Quiet", timezone: TZ, stripe_charges_enabled: false },
    ],
    crankleads_purchases: [
      // stalled 7 business days, not live
      { id: "p-a", status: "provisioned", tier: "catch", organization_id: "org-a", company_id: "co-a", provisioned_at: "2026-09-24T14:00:00.000Z", live_at: null, business_name: "Alpha Plumbing", owner_name: "Al", owner_email: "al@alpha.test", owner_phone: "+14165550111", stripe_customer_id: "cus_a", setup_reminders_stopped_at: null, created_at: ago(12 * DAY), updated_at: ago(12 * DAY) },
      // cancelled → never flagged
      { id: "p-c", status: "provisioned", tier: "catch", organization_id: "org-c", company_id: "co-c", provisioned_at: "2026-09-10T14:00:00.000Z", live_at: null, business_name: "Gamma", owner_name: "G", owner_email: "g@g.test", owner_phone: "+14165550112", stripe_customer_id: null, setup_reminders_stopped_at: null, created_at: ago(25 * DAY), updated_at: ago(25 * DAY) },
      // live for 30 days, no activity
      { id: "p-live", status: "provisioned", tier: "catch", organization_id: "org-live", company_id: "co-live", provisioned_at: ago(40 * DAY), live_at: ago(30 * DAY), business_name: "Live & Quiet", owner_name: "L", owner_email: "l@l.test", owner_phone: "+14165550113", stripe_customer_id: "cus_l", setup_reminders_stopped_at: null, created_at: ago(40 * DAY), updated_at: ago(30 * DAY) },
      // failed provisioning
      { id: "p-fail", status: "failed", tier: "close", organization_id: null, company_id: null, provisioned_at: null, live_at: null, business_name: "Delta Decks", owner_name: "D", owner_email: "d@d.test", owner_phone: "+14165550114", stripe_checkout_session_id: "cs_test_delta", stripe_customer_id: "cus_d", last_error: "boom", provision_attempts: 2, paid_at: ago(3 * HOUR), failed_at: ago(2 * HOUR), created_at: ago(3 * HOUR), updated_at: ago(2 * HOUR) },
      // abandoned checkout → ignored
      { id: "p-abandon", status: "checkout_created", tier: "catch", organization_id: null, company_id: null, provisioned_at: null, live_at: null, business_name: "Never Paid", owner_name: "N", owner_email: "n@n.test", owner_phone: "+1", created_at: ago(5 * HOUR), updated_at: ago(5 * HOUR) },
    ],
    voice_numbers: [
      { id: "vn-live", organization_id: "org-live", company_id: "co-live", phone_e164: "+17055550001", provider: "twilio", mode: "missed_call_catcher", active: true, forwarding_verified_at: null, forwarding_last_test_result: "not_forwarded", forwarding_last_test_at: ago(2 * HOUR) },
      { id: "vn-a", organization_id: "org-a", company_id: "co-a", phone_e164: "+17055550002", provider: "twilio", mode: "missed_call_catcher", active: true, forwarding_verified_at: null, forwarding_last_test_result: "not_forwarded", forwarding_last_test_at: ago(2 * HOUR) },
    ],
    forwarding_tests: [
      { voice_number_id: "vn-live", status: "passed", started_at: ago(20 * DAY) },
      { voice_number_id: "vn-live", status: "not_forwarded", started_at: ago(2 * DAY) },
      { voice_number_id: "vn-a", status: "not_forwarded", started_at: ago(2 * HOUR) },
    ],
    subscriptions: [
      { organization_id: "org-b", stripe_subscription_id: "sub_old", current_period_end: ago(40 * DAY), updated_at: ago(40 * DAY) },
      { organization_id: "org-b", stripe_subscription_id: "sub_b", current_period_end: ago(2 * DAY), updated_at: ago(2 * DAY) },
    ],
    support_requests: [
      { id: "sr-old", organization_id: "org-a", requester_email: "al@alpha.test", question: "Where is my number?", status: "open", created_at: ago(30 * HOUR) },
      { id: "sr-new", organization_id: "org-a", requester_email: "al@alpha.test", question: "New one", status: "open", created_at: ago(2 * HOUR) },
      { id: "sr-closed", organization_id: "org-a", requester_email: "al@alpha.test", question: "Done", status: "closed", created_at: ago(90 * HOUR) },
    ],
    inbound_webhook_jobs: [
      { id: "j1", status: "failed", updated_at: ago(3 * HOUR), run_at: ago(4 * HOUR) },
      { id: "j2", status: "failed", updated_at: ago(3 * DAY), run_at: ago(3 * DAY) },
      { id: "j3", status: "pending", updated_at: ago(60 * 60_000), run_at: ago(50 * 60_000) },
      { id: "j4", status: "pending", updated_at: ago(1 * 60_000), run_at: new Date(NOW + HOUR).toISOString() },
    ],
    workflow_event_jobs: [{ id: "w1", status: "completed", updated_at: ago(HOUR), available_at: ago(HOUR) }],
    contacts: [],
    missed_calls: [],
    retell_calls: [],
  };
}

describe("loadOperatorHealthFacts (fake DB) → report", () => {
  it("finds exactly the accounts that need a human", async () => {
    const db = createFakeDb(seed());
    const facts = await loadOperatorHealthFacts(db.client, INPUT);
    expect(facts.errors).toEqual([]);
    const report = buildOperatorHealthReport(facts);
    const flagged = Object.fromEntries(report.sections.map((s) => [s.key, s.items.map((i) => i.account)]));
    expect(flagged).toEqual({
      provisioning: ["Delta Decks"],
      forwarding: ["Live & Quiet"], // vn-a never worked and org-a is not live → setup problem, not here
      setup: ["Alpha Plumbing"], // Gamma is cancelled
      queues: ["Inbound webhooks (calls, texts)"],
      payments: ["Beta Roofing"], // House is internal
      support: ["Alpha Plumbing"],
      silent: ["Live & Quiet"],
    });
    // setup reuses loadSetupChecklist (catch: services · phone · forwarding · website · automations)
    const setup = facts.setup.find((f) => f.purchaseId === "p-a");
    expect(setup?.checklist).toMatchObject({ doneCount: 1, totalCount: 5, isLive: false, nextStepTitle: "Add your prices" });
    // payments use the latest subscription row
    expect(facts.payments.find((p) => p.organizationId === "org-b")?.stripeSubscriptionId).toBe("sub_b");
    // queue: 1 failed in 24h, a ready job waiting 50 min (the future job doesn't count)
    const inbound = facts.queues.find((q) => q.key === "inbound_webhooks");
    expect(inbound).toMatchObject({ failedRecent: 1, pending: 2, oldestReadyAt: ago(50 * 60_000) });
    expect(report.sections.find((s) => s.key === "forwarding")?.items[0].howLong).toBe("failing for 2 days");
  });

  it("every per-account read is filtered by the row's own organization_id", async () => {
    const db = createFakeDb(seed());
    await loadOperatorHealthFacts(db.client, INPUT);
    const tenantTables = ["contacts", "missed_calls", "retell_calls", "service_catalog_items", "workflows", "public_form_keys"];
    const reads = db.queries.filter((q) => tenantTables.includes(q.table));
    expect(reads.length).toBeGreaterThan(0);
    for (const q of reads) expect(q.filters.some((f) => f.kind === "eq" && f.column === "organization_id")).toBe(true);
  });

  it("a failed section becomes a 'could not check' item and the rest still load", async () => {
    const db = createFakeDb(seed());
    db.failNext("support_requests", "select", { message: "statement timeout" });
    const facts = await loadOperatorHealthFacts(db.client, INPUT);
    expect(facts.errors).toEqual([{ section: "support requests", message: "support request scan failed: statement timeout" }]);
    expect(facts.payments).toHaveLength(1);
    const report = buildOperatorHealthReport(facts);
    expect(report.sections.find((s) => s.key === "checks")?.items[0].problem).toBe(
      "Couldn't check support requests: support request scan failed: statement timeout",
    );
    expect(report.sections.some((s) => s.key === "support")).toBe(false);
  });

  it("a 'failed' (our side) number loads with its Twilio error and is reported under test calls, not forwarding broken", async () => {
    const tables = seed();
    tables.voice_numbers.push({ id: "vn-f", organization_id: "org-a", company_id: "co-a", phone_e164: "+17055550003", provider: "twilio", mode: "missed_call_catcher", active: true, forwarding_verified_at: ago(9 * DAY), forwarding_last_test_result: "failed", forwarding_last_test_at: ago(3 * HOUR) });
    tables.forwarding_tests.push(
      { voice_number_id: "vn-f", status: "passed", started_at: ago(9 * DAY) },
      { voice_number_id: "vn-f", status: "failed", started_at: ago(3 * HOUR), error_message: "No final call status from Twilio." },
    );
    const facts = await loadOperatorHealthFacts(createFakeDb(tables).client, INPUT);
    expect(facts.forwarding.find((f) => f.voiceNumberId === "vn-f")).toMatchObject({ lastResult: "failed", lastTestError: "No final call status from Twilio.", failingSince: null });
    const report = buildOperatorHealthReport(facts);
    expect(report.sections.find((s) => s.key === "forwarding")?.items.map((i) => i.account)).toEqual(["Live & Quiet"]);
    expect(report.sections.find((s) => s.key === "test_calls")?.items).toHaveLength(1);
  });

  it("a passive forwarded call counts as 'worked before'", async () => {
    const tables = seed();
    tables.forwarding_tests = [];
    tables.missed_calls = [{ id: "mc", organization_id: "org-a", company_id: "co-a", to_number: "+17055550002", forwarded_from: "+14165550111", created_at: ago(20 * DAY) }];
    const facts = await loadOperatorHealthFacts(createFakeDb(tables).client, INPUT);
    expect(facts.forwarding.find((f) => f.voiceNumberId === "vn-a")?.everWorked).toBe(true);
    expect(facts.forwarding.find((f) => f.voiceNumberId === "vn-live")?.everWorked).toBe(false);
    expect(facts.forwarding.find((f) => f.voiceNumberId === "vn-live")?.accountLive).toBe(true);
  });
});

// ── Scheduled run: idempotency ───────────────────────────────────────────────

const CONFIG: OperatorHealthConfig = {
  enabled: true,
  recipient: "marcus@example.test",
  allClearMode: "weekly",
  timeZone: TZ,
  appBaseUrl: APP,
  stripeDashboardBase: STRIPE,
  graceDays: 7,
};

describe("processOperatorHealth (scheduled daily send)", () => {
  let db: FakeDb;
  let sendEmail: ReturnType<typeof vi.fn>;
  let deps: Partial<OperatorHealthDeps>;
  let facts: OperatorHealthFacts;

  beforeEach(() => {
    resetOperatorHealthMemo();
    db = createFakeDb({ operator_health_reports: [] }, { operator_health_reports: [["report_date"]] });
    sendEmail = vi.fn().mockResolvedValue({ id: "re_1" });
    facts = fullFacts();
    deps = { sendEmail, isEmailConfigured: () => true, loadFacts: vi.fn(async () => facts) };
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("does nothing when disabled or before 07:30 operator time", async () => {
    expect((await processOperatorHealth(db.client, NOW, deps, { ...CONFIG, enabled: false })).action).toBe("disabled");
    const sevenAm = Date.parse("2026-10-05T11:00:00.000Z");
    expect((await processOperatorHealth(db.client, sevenAm, deps, CONFIG)).action).toBe("not_yet");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(db.tables.operator_health_reports).toHaveLength(0);
  });

  it("claims the day, sends once, and never again that day (restart / second worker)", async () => {
    const first = await processOperatorHealth(db.client, NOW, deps, CONFIG);
    expect(first).toMatchObject({ action: "sent", reportDate: "2026-10-05", itemCount: 8 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ to: "marcus@example.test", subject: "CrankLeads health: 8 need you (2 guarantee at risk)" });
    expect(db.tables.operator_health_reports[0]).toMatchObject({ report_date: "2026-10-05", status: "sent", item_count: 8, guarantee_at_risk: 2, all_clear: false });
    expect(db.tables.operator_health_reports[0].summary).toEqual({ provisioning: 1, forwarding: 1, setup: 2, queues: 1, payments: 1, support: 1, silent: 1 });

    // Same process, later pass → memo.
    expect((await processOperatorHealth(db.client, NOW + HOUR, deps, CONFIG)).action).toBe("already_done");
    // A restarted worker (no memo) → the DB row.
    resetOperatorHealthMemo();
    expect((await processOperatorHealth(db.client, NOW + 2 * HOUR, deps, CONFIG)).action).toBe("already_done");
    expect(sendEmail).toHaveBeenCalledTimes(1);

    // Next day → a new report.
    resetOperatorHealthMemo();
    expect((await processOperatorHealth(db.client, NOW + DAY, deps, CONFIG)).action).toBe("sent");
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it("losing the claim race (unique report_date) sends nothing", async () => {
    db.failNext("operator_health_reports", "insert", { code: "23505", message: "duplicate key" });
    expect((await processOperatorHealth(db.client, NOW, deps, CONFIG)).action).toBe("claimed_elsewhere");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("claims BEFORE sending: a failed send is recorded and not retried that day", async () => {
    sendEmail.mockImplementation(async () => {
      expect(db.tables.operator_health_reports[0]).toMatchObject({ status: "sending" });
      throw new Error("resend 500");
    });
    expect((await processOperatorHealth(db.client, NOW, deps, CONFIG)).action).toBe("failed");
    expect(db.tables.operator_health_reports[0]).toMatchObject({ status: "failed", error: "resend 500" });
    resetOperatorHealthMemo();
    expect((await processOperatorHealth(db.client, NOW + HOUR, deps, CONFIG)).action).toBe("already_done");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("nothing flagged on a Tuesday → quiet (recorded, no email)", async () => {
    facts = emptyFacts();
    const tuesday = NOW + DAY;
    const outcome = await processOperatorHealth(db.client, tuesday, deps, CONFIG);
    expect(outcome.action).toBe("quiet");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(db.tables.operator_health_reports[0]).toMatchObject({ report_date: "2026-10-06", status: "quiet", subject: null });
  });

  it("nothing flagged on a Monday → weekly all clear (unless 'never')", async () => {
    facts = emptyFacts();
    const outcome = await processOperatorHealth(db.client, NOW, deps, CONFIG);
    expect(outcome).toMatchObject({ action: "sent", delivery: "all_clear" });
    expect(sendEmail.mock.calls[0][0].subject).toBe("CrankLeads health: all clear");
    expect(db.tables.operator_health_reports[0]).toMatchObject({ all_clear: true, status: "sent" });

    resetOperatorHealthMemo();
    const quietDb = createFakeDb({ operator_health_reports: [] }, { operator_health_reports: [["report_date"]] });
    expect((await processOperatorHealth(quietDb.client, NOW, deps, { ...CONFIG, allClearMode: "never" })).action).toBe("quiet");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("email not configured → no claim (so it sends once configured), logged once per day", async () => {
    deps.isEmailConfigured = () => false;
    expect((await processOperatorHealth(db.client, NOW, deps, CONFIG)).action).toBe("email_not_configured");
    await processOperatorHealth(db.client, NOW + 5 * 60_000, deps, CONFIG);
    expect(db.tables.operator_health_reports).toHaveLength(0);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("uses the operator timezone for the report date (late evening UTC is still 'today' in Toronto)", async () => {
    // 2026-10-06T02:00Z = Mon Oct 5 22:00 in Toronto.
    const outcome = await processOperatorHealth(db.client, Date.parse("2026-10-06T02:00:00.000Z"), deps, CONFIG);
    expect(outcome.reportDate).toBe("2026-10-05");
  });

  it("never throws: a DB error becomes a failed outcome", async () => {
    db.failNext("operator_health_reports", "select", { message: "db down" });
    expect(await processOperatorHealth(db.client, NOW, deps, CONFIG)).toMatchObject({ action: "failed", reason: "report lookup failed: db down" });
  });
});

describe("runOperatorHealthJob (CLI)", () => {
  it("--dry-run renders without sending or claiming", async () => {
    const db = createFakeDb({ operator_health_reports: [] });
    const sendEmail = vi.fn();
    const result = await runOperatorHealthJob(db.client, parseOperatorHealthArgs(["--dry-run"]), {
      nowMs: NOW,
      config: CONFIG,
      deps: { sendEmail, loadFacts: async () => fullFacts() },
    });
    expect(result.sentTo).toBeNull();
    expect(result.email.subject).toBe("CrankLeads health: 8 need you (2 guarantee at risk)");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(db.tables.operator_health_reports).toHaveLength(0);
  });

  it("--send force-sends now (even an all clear on a Tuesday) without claiming the day", async () => {
    const db = createFakeDb({ operator_health_reports: [] });
    const sendEmail = vi.fn().mockResolvedValue({ id: null });
    const result = await runOperatorHealthJob(db.client, parseOperatorHealthArgs(["--send"]), {
      nowMs: NOW + DAY,
      config: CONFIG,
      deps: { sendEmail, loadFacts: async () => emptyFacts({ nowMs: NOW + DAY }) },
    });
    expect(result.delivery).toBe("quiet");
    expect(result.sentTo).toBe("marcus@example.test");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(db.tables.operator_health_reports).toHaveLength(0);
  });

  it("--send without OWNER_EMAIL fails loudly", async () => {
    await expect(
      runOperatorHealthJob(createFakeDb().client, { dryRun: false, send: true, all: false }, {
        nowMs: NOW,
        config: { ...CONFIG, recipient: null, enabled: false },
        deps: { loadFacts: async () => emptyFacts() },
      }),
    ).rejects.toThrow("OWNER_EMAIL is not set");
  });
});
