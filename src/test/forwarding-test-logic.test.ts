/**
 * Forwarding verification — pure logic (docs/missed-call-catcher.md → Forwarding
 * verification): outcome state machine, forwarded-leg detection, owner rate limits, calling
 * hours, scheduled-retest selection (timezone / quiet hours / weekends), business-line
 * guards, owner messages and TwiML (golden).
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  businessLineProblem,
  buildForwardingResultMessage,
  checkOwnerTestRateLimit,
  localClock,
  matchForwardingTest,
  nextTestStatus,
  outcomeFromCall,
  phoneStepLink,
  retestDecision,
  retestSlotMinute,
  shouldNotifyOwner,
  verificationPatch,
  withinCallingHours,
  type RetestCandidate,
  type TestCandidate,
} from "@/server/services/twilio/forwarding-test-logic";
import { buildForwardingTestAnsweredTwiml, buildForwardingTestLegTwiml } from "@/server/services/twilio/voice-twiml";

const CATCHER = "+17055550100";
const BUSINESS = "+17055559999";
const VERIFIER = "+14165550111";
const T0 = Date.parse("2026-10-06T14:00:00Z"); // Tue 10:00 America/Toronto (EDT)

describe("outcomeFromCall (state machine input)", () => {
  it("a forwarded leg is a pass whatever the outbound leg says", () => {
    for (const callStatus of ["completed", "busy", "no-answer", "failed", null]) {
      expect(outcomeFromCall({ callStatus, answeredBy: null, forwardedLegSeen: true })).toBe("passed");
    }
  });
  it("maps final statuses without a forwarded leg", () => {
    expect(outcomeFromCall({ callStatus: "completed", answeredBy: "human", forwardedLegSeen: false })).toBe("answered");
    expect(outcomeFromCall({ callStatus: "completed", answeredBy: null, forwardedLegSeen: false })).toBe("answered");
    expect(outcomeFromCall({ callStatus: "completed", answeredBy: "unknown", forwardedLegSeen: false })).toBe("answered");
    expect(outcomeFromCall({ callStatus: "completed", answeredBy: "machine_end_beep", forwardedLegSeen: false })).toBe("not_forwarded");
    expect(outcomeFromCall({ callStatus: "completed", answeredBy: "fax", forwardedLegSeen: false })).toBe("not_forwarded");
    expect(outcomeFromCall({ callStatus: "no-answer", answeredBy: null, forwardedLegSeen: false })).toBe("not_forwarded");
    expect(outcomeFromCall({ callStatus: "busy", answeredBy: null, forwardedLegSeen: false })).toBe("not_forwarded");
    expect(outcomeFromCall({ callStatus: "failed", answeredBy: null, forwardedLegSeen: false })).toBe("failed");
    expect(outcomeFromCall({ callStatus: "canceled", answeredBy: null, forwardedLegSeen: false })).toBe("failed");
  });
  it("non-final statuses decide nothing", () => {
    for (const callStatus of ["queued", "initiated", "ringing", "in-progress", null, undefined]) {
      expect(outcomeFromCall({ callStatus, answeredBy: null, forwardedLegSeen: false })).toBeNull();
    }
  });
});

describe("nextTestStatus", () => {
  it("an in-flight test takes the first outcome", () => {
    expect(nextTestStatus("calling", "not_forwarded")).toBe("not_forwarded");
    expect(nextTestStatus("calling", "passed")).toBe("passed");
  });
  it("passed is sticky and upgrades any earlier failure", () => {
    expect(nextTestStatus("passed", "failed")).toBeNull();
    expect(nextTestStatus("passed", "passed")).toBeNull();
    expect(nextTestStatus("not_forwarded", "passed")).toBe("passed");
    expect(nextTestStatus("answered", "passed")).toBe("passed");
  });
  it("a decided test does not flip between failures", () => {
    expect(nextTestStatus("answered", "not_forwarded")).toBeNull();
    expect(nextTestStatus("failed", "answered")).toBeNull();
  });
});

describe("verificationPatch (voice_numbers column contract)", () => {
  const now = "2026-10-06T14:00:00.000Z";
  it("passed sets forwarding_verified_at", () => {
    expect(verificationPatch("passed", now)).toEqual({
      forwarding_last_test_at: now,
      forwarding_last_test_result: "passed",
      forwarding_verified_at: now,
    });
  });
  it("not_forwarded and failed CLEAR forwarding_verified_at", () => {
    expect(verificationPatch("not_forwarded", now)).toMatchObject({ forwarding_verified_at: null, forwarding_last_test_result: "not_forwarded" });
    expect(verificationPatch("failed", now)).toMatchObject({ forwarding_verified_at: null, forwarding_last_test_result: "failed" });
  });
  it("answered is inconclusive — verification untouched", () => {
    const patch = verificationPatch("answered", now);
    expect(patch).toEqual({ forwarding_last_test_at: now, forwarding_last_test_result: "answered" });
    expect("forwarding_verified_at" in patch).toBe(false);
  });
});

describe("matchForwardingTest (detection)", () => {
  const test = (over: Partial<TestCandidate> = {}): TestCandidate => ({
    id: "t1",
    status: "calling",
    started_at: new Date(T0 - 30_000).toISOString(),
    caller_id: CATCHER,
    business_line: BUSINESS,
    catcher_number: CATCHER,
    ...over,
  });
  const live = { windowMs: 3 * 60_000, inFlightOnly: true };

  it("matches From == test caller ID (carrier keeps the original caller)", () => {
    expect(matchForwardingTest([test()], { from: CATCHER, to: CATCHER, forwardedFrom: null }, T0, live)?.id).toBe("t1");
    const verifier = test({ caller_id: VERIFIER });
    expect(matchForwardingTest([verifier], { from: VERIFIER, to: CATCHER, forwardedFrom: null }, T0, live)?.id).toBe("t1");
  });
  it("matches From == business line (carrier rewrites caller ID) and ForwardedFrom == business line", () => {
    expect(matchForwardingTest([test()], { from: "7055559999", to: CATCHER, forwardedFrom: null }, T0, live)).not.toBeNull();
    expect(matchForwardingTest([test()], { from: "+16475550123", to: CATCHER, forwardedFrom: BUSINESS }, T0, live)).not.toBeNull();
  });
  it("a real customer during a test is NOT the test", () => {
    expect(matchForwardingTest([test()], { from: "+16475550123", to: CATCHER, forwardedFrom: null }, T0, live)).toBeNull();
    expect(matchForwardingTest([test()], { from: "+16475550123", to: CATCHER, forwardedFrom: "+16475550000" }, T0, live)).toBeNull();
  });
  it("must reach the test's own catcher number, inside the window", () => {
    expect(matchForwardingTest([test()], { from: CATCHER, to: "+17055550199", forwardedFrom: null }, T0, live)).toBeNull();
    const old = test({ started_at: new Date(T0 - 4 * 60_000).toISOString() });
    expect(matchForwardingTest([old], { from: CATCHER, to: CATCHER, forwardedFrom: null }, T0, live)).toBeNull();
    const future = test({ started_at: new Date(T0 + 60_000).toISOString() });
    expect(matchForwardingTest([future], { from: CATCHER, to: CATCHER, forwardedFrom: null }, T0, live)).toBeNull();
  });
  it("the live check needs an in-flight test; the worker also matches finished ones", () => {
    const done = test({ status: "not_forwarded" });
    expect(matchForwardingTest([done], { from: CATCHER, to: CATCHER, forwardedFrom: null }, T0, live)).toBeNull();
    expect(
      matchForwardingTest([done], { from: CATCHER, to: CATCHER, forwardedFrom: null }, T0, { windowMs: 30 * 60_000, inFlightOnly: false })?.id,
    ).toBe("t1");
  });
  it("picks the most recently started match", () => {
    const a = test({ id: "a", started_at: new Date(T0 - 90_000).toISOString() });
    const b = test({ id: "b", started_at: new Date(T0 - 10_000).toISOString() });
    expect(matchForwardingTest([a, b], { from: CATCHER, to: CATCHER, forwardedFrom: null }, T0, live)?.id).toBe("b");
  });
});

describe("checkOwnerTestRateLimit (1 per 2 min, 10 per 24 h)", () => {
  const at = (msAgo: number) => ({ created_at: new Date(T0 - msAgo).toISOString() });
  it("allows the first test", () => {
    expect(checkOwnerTestRateLimit([], T0)).toEqual({ ok: true });
  });
  it("refuses a second test inside 2 minutes, with a retry-after", () => {
    const decision = checkOwnerTestRateLimit([at(60_000)], T0);
    expect(decision.ok).toBe(false);
    expect("retryAfterSeconds" in decision && decision.retryAfterSeconds).toBe(60);
  });
  it("allows after 2 minutes", () => {
    expect(checkOwnerTestRateLimit([at(121_000)], T0).ok).toBe(true);
  });
  it("refuses the 11th test in 24 h", () => {
    const ten = Array.from({ length: 10 }, (_, i) => at((i + 1) * 3_600_000));
    expect(checkOwnerTestRateLimit(ten, T0).ok).toBe(false);
    expect(checkOwnerTestRateLimit(ten.slice(0, 9), T0).ok).toBe(true);
    // Older than 24 h no longer counts.
    const stale = Array.from({ length: 10 }, (_, i) => at(25 * 3_600_000 + i));
    expect(checkOwnerTestRateLimit(stale, T0).ok).toBe(true);
  });
});

describe("calling hours (company timezone; never at night)", () => {
  it("reads the local wall clock", () => {
    expect(localClock("America/Toronto", T0)).toEqual({ hour: 10, minute: 0, weekday: 2 });
    expect(localClock("America/Vancouver", T0)).toMatchObject({ hour: 7 });
    expect(localClock("Not/AZone", T0)).toMatchObject({ hour: 10 }); // falls back to Toronto
  });
  it("08:00–20:59 local only", () => {
    expect(withinCallingHours("America/Toronto", T0)).toBe(true);
    expect(withinCallingHours("America/Vancouver", T0)).toBe(false); // 07:00
    expect(withinCallingHours("America/Toronto", Date.parse("2026-10-07T00:59:00Z"))).toBe(true); // 20:59
    expect(withinCallingHours("America/Toronto", Date.parse("2026-10-07T01:00:00Z"))).toBe(false); // 21:00
    expect(withinCallingHours("America/Toronto", Date.parse("2026-10-06T11:59:00Z"))).toBe(false); // 07:59
  });
});

describe("retestDecision (scheduler selection)", () => {
  // Tue 15:59 Toronto — after every number's slot minute inside the 10:00–16:00 window.
  const LATE = Date.parse("2026-10-06T19:59:00Z");
  const day = 24 * 3_600_000;
  const candidate = (over: Partial<RetestCandidate> = {}): RetestCandidate => ({
    voiceNumberId: "vn-1",
    createdAt: new Date(LATE - 60 * day).toISOString(),
    verifiedAt: new Date(LATE - 8 * day).toISOString(),
    lastTestAt: new Date(LATE - 8 * day).toISOString(),
    timeZone: "America/Toronto",
    scheduledAttempts: 0,
    inFlight: false,
    hasBusinessLine: true,
    ...over,
  });

  it("re-tests a verified number weekly", () => {
    expect(retestDecision(candidate(), LATE)).toEqual({ due: true, kind: "verified_weekly" });
    expect(retestDecision(candidate({ lastTestAt: new Date(LATE - 3 * day).toISOString() }), LATE).due).toBe(false);
  });
  it("a recent real forwarded call (passive proof) postpones the weekly retest", () => {
    expect(retestDecision(candidate({ verifiedAt: new Date(LATE - 1 * day).toISOString() }), LATE).due).toBe(false);
  });
  it("only weekdays, 10:00–16:00 company-local, at/after the number's slot", () => {
    expect(retestDecision(candidate(), Date.parse("2026-10-10T19:59:00Z"))).toMatchObject({ due: false, reason: "weekend" }); // Sat
    expect(retestDecision(candidate(), Date.parse("2026-10-06T20:00:00Z"))).toMatchObject({ due: false, reason: "outside_window" }); // 16:00
    expect(retestDecision(candidate(), Date.parse("2026-10-07T02:00:00Z"))).toMatchObject({ due: false, reason: "outside_window" }); // 22:00
    // Same instant, a Vancouver company is at 12:59 — inside its window.
    expect(retestDecision(candidate({ timeZone: "America/Vancouver" }), LATE).due).toBe(true);
    // Before the slot minute → not yet.
    const slot = retestSlotMinute("vn-1");
    const beforeSlot = Date.parse("2026-10-06T14:00:00Z") + Math.max(0, slot - 1) * 60_000;
    if (slot > 0) expect(retestDecision(candidate(), beforeSlot)).toMatchObject({ due: false, reason: "before_slot" });
  });
  it("slot minutes are stable and inside the window", () => {
    for (const id of ["a", "vn-1", "00000000-0000-4000-8000-000000000001"]) {
      expect(retestSlotMinute(id)).toBe(retestSlotMinute(id));
      expect(retestSlotMinute(id)).toBeGreaterThanOrEqual(0);
      expect(retestSlotMinute(id)).toBeLessThan(360);
    }
  });
  it("re-tests an unverified number daily for its first 14 days, max 5 attempts", () => {
    const fresh = { verifiedAt: null, lastTestAt: null };
    expect(retestDecision(candidate({ ...fresh, createdAt: new Date(LATE - 3 * day).toISOString() }), LATE)).toEqual({
      due: true,
      kind: "unverified_daily",
    });
    expect(retestDecision(candidate({ ...fresh, createdAt: new Date(LATE - 3_600_000).toISOString() }), LATE)).toMatchObject({ reason: "too_new" });
    expect(retestDecision(candidate({ ...fresh, createdAt: new Date(LATE - 15 * day).toISOString() }), LATE)).toMatchObject({ reason: "past_first_14_days" });
    expect(
      retestDecision(candidate({ ...fresh, createdAt: new Date(LATE - 3 * day).toISOString(), scheduledAttempts: 5 }), LATE),
    ).toMatchObject({ reason: "max_attempts" });
    expect(
      retestDecision(
        candidate({ verifiedAt: null, createdAt: new Date(LATE - 3 * day).toISOString(), lastTestAt: new Date(LATE - 5 * 3_600_000).toISOString() }),
        LATE,
      ),
    ).toMatchObject({ reason: "tested_today" });
  });
  it("never while a test is in flight or without a business line", () => {
    expect(retestDecision(candidate({ inFlight: true }), LATE)).toMatchObject({ reason: "in_flight" });
    expect(retestDecision(candidate({ hasBusinessLine: false }), LATE)).toMatchObject({ reason: "no_business_line" });
  });
});

describe("businessLineProblem (only the company's own callable number)", () => {
  const ours = { catcher: CATCHER, callerId: CATCHER, sharedSender: "+17055550001" };
  it("accepts a normal NANP line", () => {
    expect(businessLineProblem(BUSINESS, ours)).toBeNull();
  });
  it("refuses missing, non-NANP, premium and our own numbers", () => {
    expect(businessLineProblem(null, ours)).toMatch(/business phone/);
    expect(businessLineProblem("+447700900123", ours)).toMatch(/North American/);
    expect(businessLineProblem("+19005551234", ours)).toMatch(/can't be test-called/);
    expect(businessLineProblem(CATCHER, ours)).toMatch(/EmpireVu number/);
    expect(businessLineProblem("+17055550001", ours)).toMatch(/EmpireVu number/);
    expect(businessLineProblem(VERIFIER, { ...ours, callerId: VERIFIER })).toMatch(/EmpireVu number/);
  });
});

describe("shouldNotifyOwner", () => {
  it("owner-triggered: always", () => {
    for (const outcome of ["passed", "answered", "not_forwarded", "failed"] as const) {
      expect(shouldNotifyOwner({ trigger: "owner", outcome, wasVerified: true })).toBe(true);
    }
  });
  it("scheduled: newly live, or broken — never weekly 'still fine' spam", () => {
    expect(shouldNotifyOwner({ trigger: "scheduled", outcome: "passed", wasVerified: true })).toBe(false);
    expect(shouldNotifyOwner({ trigger: "scheduled", outcome: "passed", wasVerified: false })).toBe(true);
    expect(shouldNotifyOwner({ trigger: "scheduled", outcome: "not_forwarded", wasVerified: true })).toBe(true);
    expect(shouldNotifyOwner({ trigger: "scheduled", outcome: "answered", wasVerified: true })).toBe(false);
    expect(shouldNotifyOwner({ trigger: "scheduled", outcome: "failed", wasVerified: true })).toBe(false);
  });
});

describe("owner messages (golden)", () => {
  const base = {
    trigger: "owner" as const,
    companyName: "Muskoka Plumbing",
    businessLine: BUSINESS,
    catcherNumber: CATCHER,
    answeredBy: null,
    link: phoneStepLink("https://app.example.test/"),
  };
  it("phoneStepLink", () => {
    expect(phoneStepLink("https://app.example.test/")).toBe("https://app.example.test/onboarding?step=phone");
    expect(phoneStepLink(undefined)).toBeNull();
  });
  it("passed", () => {
    expect(buildForwardingResultMessage({ ...base, outcome: "passed" }).sms).toBe("✅ Missed-call text-back is live for Muskoka Plumbing.");
  });
  it("not_forwarded (rang out) carries the carrier code and the link", () => {
    expect(buildForwardingResultMessage({ ...base, outcome: "not_forwarded" }).sms).toBe(
      "Missed-call text-back for Muskoka Plumbing isn't working: our test call to (705) 555-9999 rang out instead of forwarding. " +
        "From that phone dial **004*+17055550100# and press Call. Test again: https://app.example.test/onboarding?step=phone",
    );
  });
  it("not_forwarded (voicemail) on a scheduled retest says heads up", () => {
    expect(
      buildForwardingResultMessage({ ...base, trigger: "scheduled", outcome: "not_forwarded", answeredBy: "machine_start" }).sms,
    ).toBe(
      "Heads up: missed-call text-back for Muskoka Plumbing isn't working: our test call to (705) 555-9999 went to voicemail instead of forwarding. " +
        "From that phone dial **004*+17055550100# and press Call. Test again: https://app.example.test/onboarding?step=phone",
    );
  });
  it("answered / failed", () => {
    expect(buildForwardingResultMessage({ ...base, outcome: "answered" }).sms).toBe(
      "Our forwarding test call to (705) 555-9999 was answered, so we couldn't check forwarding for Muskoka Plumbing. Let it ring next time. " +
        "Test again: https://app.example.test/onboarding?step=phone",
    );
    expect(buildForwardingResultMessage({ ...base, outcome: "failed", link: null }).sms).toBe(
      "We couldn't complete the forwarding test call to (705) 555-9999 for Muskoka Plumbing. Check your business number in the app. " +
        "Then run the test again in the app.",
    );
  });
  it("SMS stays within two segments' worth of characters", () => {
    for (const outcome of ["passed", "answered", "not_forwarded", "failed"] as const) {
      expect(buildForwardingResultMessage({ ...base, outcome, companyName: "A Very Long Business Name Plumbing & Heating Ltd" }).sms.length).toBeLessThanOrEqual(320);
    }
  });
  it("the email fallback for not_forwarded includes the landline instructions", () => {
    const email = buildForwardingResultMessage({ ...base, outcome: "not_forwarded" });
    expect(email.subject).toBe("Fix your call forwarding for Muskoka Plumbing");
    expect(email.emailBody).toContain("##004#");
    expect(email.emailBody).toContain("Landline or VoIP");
  });
});

describe("TwiML (golden)", () => {
  it("the forwarded test leg just hangs up", () => {
    expect(buildForwardingTestLegTwiml()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  });
  it("the business line answering hears a short neutral notice", () => {
    const golden = fs.readFileSync(path.join(__dirname, "__fixtures__", "forwarding-test-answered.twiml.xml"), "utf8").trim();
    expect(buildForwardingTestAnsweredTwiml()).toBe(golden);
    expect(golden).not.toMatch(/CrankLeads/);
  });
});
