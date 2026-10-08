/**
 * CrankLeads setup follow-ups: the setup checklist (per tier), the reminder schedule
 * (business days, timezone, weekends, quiet hours), the follow-up pass against the in-memory
 * PostgREST fake (idempotency, stop-on-live, stop-on-cancel, opt-out, day-10 operator note),
 * and the message templates (golden).
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { createFakeDb, type FakeDb } from "./helpers/fake-supabase";
import {
  computeSetupChecklist,
  loadSetupChecklist,
  loadSetupFacts,
  optionalSetupSteps,
  requiredSetupSteps,
  type SetupFacts,
} from "@/server/services/crankleads/setup-checklist";
import {
  addBusinessDays,
  inLiveWindow,
  inReminderWindow,
  localClock,
  reminderDueDates,
  selectReminderStage,
} from "@/server/services/crankleads/followup-schedule";
import {
  renderLiveEmail,
  renderLiveSms,
  renderReminderEmail,
  renderReminderSms,
  type ReminderMessageInput,
} from "@/server/services/crankleads/followup-messages";
import {
  isStopToken,
  processSetupFollowups,
  stopSetupReminders,
  type SetupFollowupDeps,
} from "@/server/services/crankleads/setup-followups";
import type { DeliverMessageInput } from "@/server/services/workflow-engine/messaging";

type Row = Record<string, unknown>;

const ORG = "org-1";
const COMPANY = "company-1";
const PURCHASE = "purchase-1";
const APP = "https://app.crankleads.test";
const CATCHER = "+17055550000";
const TOKEN = "a".repeat(48);

const NONE: SetupFacts = {
  pricedServices: 0,
  servicesNeedingPrices: 0,
  catcherNumber: null,
  forwardingVerified: false,
  aiNumber: null,
  receptionistCallReceived: false,
  paymentsConnected: false,
  websiteLeadReceived: false,
  textBackActive: false,
};

const ALL_CATCHER: SetupFacts = {
  ...NONE,
  pricedServices: 4,
  catcherNumber: CATCHER,
  forwardingVerified: true,
  paymentsConnected: true,
  websiteLeadReceived: true,
  textBackActive: true,
};

function checklist(tier: "catch" | "close" | "front_desk", facts: SetupFacts) {
  return computeSetupChecklist({ organizationId: ORG, companyId: COMPANY, tier, facts, appBaseUrl: `${APP}/` });
}

// ── Checklist (pure) ─────────────────────────────────────────────────────────

describe("setup checklist — required steps per tier (done-for-you live rules)", () => {
  it("catch / close: text-back number + forwarding verified + text-back automation", () => {
    expect(requiredSetupSteps("catch", "missed_call_catcher")).toEqual(["phone", "forwarding", "automations"]);
    expect(requiredSetupSteps("close", "missed_call_catcher")).toEqual(["phone", "forwarding", "automations"]);
  });
  it("front desk on the AI path: AI number + forwarding (or a real call reached the AI)", () => {
    expect(requiredSetupSteps("front_desk", "ai_receptionist")).toEqual(["phone", "forwarding"]);
  });
  it("front desk that chose the catcher: same as close", () => {
    expect(requiredSetupSteps("front_desk", "missed_call_catcher")).toEqual(requiredSetupSteps("close", "missed_call_catcher"));
  });
  it("prices, payments and the website form are optional extras (payments only where deposits exist)", () => {
    expect(optionalSetupSteps("catch", "missed_call_catcher")).toEqual(["services", "website"]);
    expect(optionalSetupSteps("close", "missed_call_catcher")).toEqual(["services", "payments", "website"]);
    const c = checklist("close", { ...ALL_CATCHER, pricedServices: 0, paymentsConnected: false, websiteLeadReceived: false });
    expect(c.isLive).toBe(true);
    expect(c.extras.map((e) => [e.key, e.done, e.required])).toEqual([
      ["services", false, false],
      ["payments", false, false],
      ["website", false, false],
    ]);
  });

  it("catch with nothing done: 0 of 3, next = the number (we buy it), deep link to the in-app view for this org", () => {
    const c = checklist("catch", { ...NONE, servicesNeedingPrices: 7 });
    expect(c.doneCount).toBe(0);
    expect(c.totalCount).toBe(3);
    expect(c.isLive).toBe(false);
    expect(c.nextStep?.key).toBe("phone");
    expect(c.nextStep?.path).toBe(`/onboarding?step=phone&org=${ORG}`);
    expect(c.nextStep?.deepLink).toBe(`${APP}/onboarding?step=phone&org=${ORG}`);
    expect(c.steps.every((s) => s.required)).toBe(true);
    expect(c.extras.find((e) => e.key === "services")?.action).toBe("add prices to your 7 services");
  });

  it("forwarding counts ONLY when the catcher number's forwarding_verified_at is set; links to the one-tap page", () => {
    const forwardUrl = `${APP}/forward/tok`;
    const unverified = computeSetupChecklist({
      organizationId: ORG,
      companyId: COMPANY,
      tier: "catch",
      facts: { ...ALL_CATCHER, forwardingVerified: false },
      appBaseUrl: APP,
      forwardUrl,
    });
    expect(unverified.isLive).toBe(false);
    expect(unverified.nextStep?.key).toBe("forwarding");
    expect(unverified.nextStep?.action).toBe("turn on call forwarding (one tap from your business phone)");
    expect(unverified.nextStep?.deepLink).toBe(forwardUrl);
    expect(checklist("catch", ALL_CATCHER).isLive).toBe(true);
    // verified flag without a catcher number never counts
    expect(checklist("catch", { ...ALL_CATCHER, catcherNumber: null }).steps.find((s) => s.key === "forwarding")?.done).toBe(false);
  });

  it("catch / close are not live until the missed-call text-back automation is active", () => {
    const c = checklist("close", { ...ALL_CATCHER, textBackActive: false });
    expect(c.isLive).toBe(false);
    expect(c.nextStep?.key).toBe("automations");
    expect(c.doneCount).toBe(2);
  });

  it("front desk: AI number + (forwarding verified OR a call that shows forwarding) = live; catcher-only front desk switches to the catcher path", () => {
    const ai = checklist("front_desk", { ...NONE, aiNumber: "+17055550001" });
    expect(ai.phonePath).toBe("ai_receptionist");
    expect(ai.isLive).toBe(false);
    expect(ai.nextStep?.key).toBe("forwarding");
    // Any call reaching the AI number is not enough on its own…
    expect(checklist("front_desk", { ...NONE, aiNumber: "+17055550001", receptionistCallReceived: true }).isLive).toBe(false);
    // …it has to show forwarding from the business line (dfy/front-desk-forwarding.ts).
    expect(checklist("front_desk", { ...NONE, aiNumber: "+17055550001", receptionistCallReceived: true, receptionistForwardedCall: true }).isLive).toBe(true);
    expect(checklist("front_desk", { ...NONE, aiNumber: "+17055550001", aiForwardingVerified: true }).isLive).toBe(true);
    // a received call without an AI number never counts
    expect(checklist("front_desk", { ...NONE, receptionistCallReceived: true }).isLive).toBe(false);
    const catcherFd = checklist("front_desk", ALL_CATCHER);
    expect(catcherFd.phonePath).toBe("missed_call_catcher");
    expect(catcherFd.isLive).toBe(true);
    // Nothing chosen yet → front desk defaults to the AI path.
    expect(checklist("front_desk", NONE).nextStep?.key).toBe("phone");
    expect(checklist("front_desk", NONE).phonePath).toBe("ai_receptionist");
  });
});

// ── Checklist loader (fake DB) ───────────────────────────────────────────────

function companyRow(overrides: Row = {}): Row {
  return {
    id: COMPANY,
    organization_id: ORG,
    name: "Jane's Roofing",
    timezone: "America/Toronto",
    owner_email: "jane@roofco.example",
    owner_phone_e164: "+17055550101",
    stripe_charges_enabled: false,
    created_at: "2026-10-02T19:00:00Z",
    ...overrides,
  };
}

function baseTables(overrides: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    organizations: [{ id: ORG, crankleads_tier: "catch", subscription_status: "active" }],
    companies: [companyRow()],
    service_catalog_items: [
      { organization_id: ORG, company_id: COMPANY, rate_cents: 0, minimum_cents: 0, tiers: null, rate_bands: null, active: false },
      { organization_id: ORG, company_id: COMPANY, rate_cents: 0, minimum_cents: 0, tiers: null, rate_bands: null, active: false },
    ],
    voice_numbers: [],
    retell_calls: [],
    public_form_keys: [{ id: "form-1", organization_id: ORG, company_id: COMPANY, active: true, last_used_at: null }],
    intake_keys: [],
    workflows: [],
    crankleads_purchases: [],
    crankleads_setup_followups: [],
    message_log: [],
    ...overrides,
  };
}

/** Everything done for a catch company. */
function liveTables(): Record<string, Row[]> {
  return baseTables({
    service_catalog_items: [{ organization_id: ORG, company_id: COMPANY, rate_cents: 15000, minimum_cents: 0, tiers: null, rate_bands: null, active: true }],
    voice_numbers: [{ organization_id: ORG, company_id: COMPANY, provider: "twilio", mode: "missed_call_catcher", phone_e164: CATCHER, active: true, forwarding_verified_at: "2026-10-05T15:00:00Z" }],
    public_form_keys: [{ id: "form-1", organization_id: ORG, company_id: COMPANY, active: true, last_used_at: "2026-10-05T15:10:00Z" }],
    workflows: [{ id: "wf-1", organization_id: ORG, company_id: COMPANY, slug: "missed-call-text-back", status: "active" }],
  });
}

describe("setup checklist — loader", () => {
  it("reads every fact filtered by organization_id + company_id", async () => {
    const db = createFakeDb(
      baseTables({
        voice_numbers: [
          { organization_id: ORG, company_id: COMPANY, provider: "twilio", mode: "missed_call_catcher", phone_e164: CATCHER, active: true, forwarding_verified_at: null },
          // another tenant's verified number must not count
          { organization_id: "org-x", company_id: "company-x", provider: "twilio", mode: "missed_call_catcher", phone_e164: "+17055559999", active: true, forwarding_verified_at: "2026-10-01T00:00:00Z" },
        ],
      }),
    );
    const facts = await loadSetupFacts({ organizationId: ORG, actorProfileId: null, supabase: db.client }, COMPANY);
    expect(facts).toMatchObject({ pricedServices: 0, servicesNeedingPrices: 2, catcherNumber: CATCHER, forwardingVerified: false, websiteLeadReceived: false });
    for (const q of db.queries.filter((x) => x.table !== "companies")) {
      expect(q.filters).toEqual(expect.arrayContaining([expect.objectContaining({ column: "organization_id", value: ORG })]));
      expect(q.filters).toEqual(expect.arrayContaining([expect.objectContaining({ column: "company_id", value: COMPANY })]));
    }
  });

  it("returns null for a non-CrankLeads org, a checklist for a CrankLeads one", async () => {
    const plain = createFakeDb(baseTables({ organizations: [{ id: ORG, crankleads_tier: null }] }));
    expect(await loadSetupChecklist({ organizationId: ORG, actorProfileId: null, supabase: plain.client }, { appBaseUrl: APP })).toBeNull();
    const live = createFakeDb(liveTables());
    const c = await loadSetupChecklist({ organizationId: ORG, actorProfileId: null, supabase: live.client }, { appBaseUrl: APP });
    expect(c?.isLive).toBe(true);
    expect(c?.doneCount).toBe(3);
  });
});

// ── Schedule (pure) ──────────────────────────────────────────────────────────

const TORONTO = "America/Toronto";
// Friday 2026-10-02 15:00 Toronto (EDT, UTC-4).
const PROVISIONED = Date.parse("2026-10-02T19:00:00Z");
const at = (iso: string) => Date.parse(iso);

describe("follow-up schedule", () => {
  it("counts business days (weekends skipped)", () => {
    expect(addBusinessDays("2026-10-02", 1)).toBe("2026-10-05"); // Fri → Mon
    expect(addBusinessDays("2026-10-02", 3)).toBe("2026-10-07");
    expect(addBusinessDays("2026-10-02", 5)).toBe("2026-10-09");
    expect(addBusinessDays("2026-10-02", 10)).toBe("2026-10-16");
    expect(addBusinessDays("2026-10-03", 1)).toBe("2026-10-05"); // Sat → Mon
    expect(reminderDueDates(PROVISIONED, TORONTO)).toEqual({ day1: "2026-10-05", day3: "2026-10-07", day5: "2026-10-09", day10: "2026-10-16" });
  });

  it("uses the company's timezone for the local date and window", () => {
    // 2026-10-06 03:30Z = Mon 23:30 Toronto, Mon 20:30 Vancouver.
    expect(localClock(TORONTO, at("2026-10-06T03:30:00Z"))).toMatchObject({ date: "2026-10-05", weekday: 1, hour: 23 });
    expect(localClock("America/Vancouver", at("2026-10-06T03:30:00Z")).hour).toBe(20);
    // 13:30Z Monday = 09:30 Toronto (in window), 06:30 Vancouver (too early).
    expect(inReminderWindow(TORONTO, at("2026-10-05T13:30:00Z"))).toBe(true);
    expect(inReminderWindow("America/Vancouver", at("2026-10-05T13:30:00Z"))).toBe(false);
    // 18:00 local is outside; 17:59 inside.
    expect(inReminderWindow(TORONTO, at("2026-10-05T22:00:00Z"))).toBe(false);
    expect(inReminderWindow(TORONTO, at("2026-10-05T21:59:00Z"))).toBe(true);
    // Saturday noon: never.
    expect(inReminderWindow(TORONTO, at("2026-10-03T16:00:00Z"))).toBe(false);
    // Live window: any day 08–21, Saturday noon ok, 22:00 not.
    expect(inLiveWindow(TORONTO, at("2026-10-03T16:00:00Z"))).toBe(true);
    expect(inLiveWindow(TORONTO, at("2026-10-04T02:00:00Z"))).toBe(false);
  });

  const none = new Set<string>();
  const decide = (nowIso: string, sentStages: Set<string> = none, sentDates: Set<string> = none, tz = TORONTO) =>
    selectReminderStage({ provisionedAtMs: PROVISIONED, nowMs: at(nowIso), timeZone: tz, sentStages, sentLocalDates: sentDates });

  it("day1 on the next business day inside 09–18 local; nothing on the weekend or at night", () => {
    expect(decide("2026-10-03T16:00:00Z")).toMatchObject({ send: false, reason: "outside_window" }); // Saturday
    expect(decide("2026-10-05T12:00:00Z")).toMatchObject({ send: false, reason: "outside_window" }); // Mon 08:00
    expect(decide("2026-10-05T13:05:00Z")).toEqual({ send: true, stage: "day1", localDate: "2026-10-05", reason: null });
    expect(decide("2026-10-06T00:30:00Z")).toMatchObject({ send: false, reason: "outside_window" }); // Mon 20:30
  });

  it("never twice in one local day, never the same stage twice", () => {
    expect(decide("2026-10-05T18:00:00Z", new Set(["day1"]), new Set(["2026-10-05"]))).toMatchObject({ reason: "already_sent_today" });
    expect(decide("2026-10-06T14:00:00Z", new Set(["day1"]), new Set(["2026-10-05"]))).toMatchObject({ send: false, reason: "nothing_due" });
    expect(decide("2026-10-07T14:00:00Z", new Set(["day1"]), new Set(["2026-10-05"]))).toMatchObject({ send: true, stage: "day3" });
  });

  it("only the latest due stage is sent when several are due (earlier ones superseded)", () => {
    expect(decide("2026-10-09T14:00:00Z")).toMatchObject({ send: true, stage: "day5" });
    expect(decide("2026-10-16T14:00:00Z", new Set(["day1", "day3", "day5"]), new Set(["2026-10-05", "2026-10-07", "2026-10-09"]))).toMatchObject({ send: true, stage: "day10" });
    expect(decide("2026-10-19T14:00:00Z", new Set(["day1", "day3", "day5", "day10"]))).toMatchObject({ reason: "all_sent" });
    expect(decide("2026-11-20T15:00:00Z")).toMatchObject({ reason: "past_horizon" });
  });
});

// ── Templates (golden) ───────────────────────────────────────────────────────

const FORWARD_URL = `${APP}/forward/AbCdEfGhIjKlMnOpQrStUvWxYz012345`;
const SETUP_URL = `${APP}/setup/intake-token-1`;

const REMINDER: ReminderMessageInput = {
  stage: "day3",
  ownerName: "Jane Roofer",
  businessName: "Jane's Roofing",
  action: "forwarding",
  actionUrl: FORWARD_URL,
  phonePath: "missed_call_catcher",
  remaining: [{ title: "Turn on call forwarding", action: "turn on call forwarding (one tap from your business phone)" }],
  appUrl: APP,
  stopUrl: `${APP}/api/public/crankleads/setup-reminders?token=${TOKEN}`,
};

describe("follow-up templates (done-for-you: one action, one no-login link)", () => {
  it("forwarding reminder SMS (golden)", () => {
    expect(renderReminderSms(REMINDER)).toBe(
      `CrankLeads: Hi Jane, Jane's Roofing is one tap from live. Turn on call forwarding so every call you miss gets a text back: ${FORWARD_URL}\nReply STOP to stop these texts.`,
    );
    expect(renderReminderSms({ ...REMINDER, phonePath: "ai_receptionist" })).toContain("so your AI receptionist picks up the calls you miss");
  });

  it("quick-setup reminder SMS (golden) and the day-10 variant", () => {
    const quick = { ...REMINDER, action: "quick_setup" as const, actionUrl: SETUP_URL };
    expect(renderReminderSms(quick)).toBe(
      `CrankLeads: Hi Jane, finish your 60-second setup and we'll switch Jane's Roofing on for you: ${SETUP_URL}\nReply STOP to stop these texts.`,
    );
    expect(renderReminderSms({ ...REMINDER, stage: "day10" })).toBe(
      `CrankLeads: Hi Jane, last nudge — Jane's Roofing is one tap from live. Turn on call forwarding so every call you miss gets a text back: ${FORWARD_URL}\nReply STOP to stop these texts.`,
    );
  });

  it("reminder email (golden) — never asks for Stripe, prices or wizard steps", () => {
    const email = renderReminderEmail(REMINDER);
    expect(email.fromName).toBe("CrankLeads");
    expect(email.subject).toBe("Jane's Roofing is one tap from live");
    expect(email.body).toMatchSnapshot();
    expect(email.html).toMatchSnapshot();
    expect(email.body).not.toMatch(/\$\s?\d/);
    for (const stage of ["day1", "day3", "day5", "day10"] as const) {
      for (const action of ["quick_setup", "forwarding"] as const) {
        const rendered = renderReminderEmail({ ...REMINDER, stage, action });
        expect(`${rendered.subject}\n${rendered.body}\n${renderReminderSms({ ...REMINDER, stage, action })}`).not.toMatch(/stripe|payments|onboarding\?step|wizard|EmpireVu/i);
      }
    }
  });

  it("reminder email subjects per action / stage, HTML escaping", () => {
    expect(renderReminderEmail({ ...REMINDER, action: "quick_setup", actionUrl: SETUP_URL }).subject).toBe("60 seconds to finish setting up Jane's Roofing");
    expect(renderReminderEmail({ ...REMINDER, stage: "day10" }).subject).toBe("Want us to finish Jane's Roofing's setup with you?");
    expect(renderReminderEmail({ ...REMINDER, action: "quick_setup", actionUrl: SETUP_URL }).body).toMatchSnapshot();
    expect(renderReminderEmail({ ...REMINDER, businessName: "<b>x</b>" }).html).not.toContain("<b>x</b>");
  });

  it("live templates (golden): what works, the number, the page, a login link", () => {
    const live = {
      ownerName: "Jane Roofer",
      businessName: "Jane's Roofing",
      phonePath: "missed_call_catcher" as const,
      appUrl: APP,
      number: CATCHER,
      siteUrl: `${APP}/s/janes-roofing`,
      setPasswordUrl: null,
    };
    expect(renderLiveSms(live)).toBe(
      `CrankLeads: 🎉 You're live! Jane's Roofing: missed callers now get a text back from (705) 555-0000. Your new page: ${APP}/s/janes-roofing Log in: ${APP}`,
    );
    expect(renderLiveSms({ ...live, phonePath: "ai_receptionist", siteUrl: null })).toBe(
      `CrankLeads: 🎉 You're live! Jane's Roofing: calls you miss now go to your AI receptionist (705) 555-0000. Log in: ${APP}`,
    );
    const email = renderLiveEmail(live);
    expect(email.subject).toBe("🎉 You're live — Jane's Roofing is catching leads");
    expect(email.body).toMatchSnapshot();
    const withPassword = renderLiveEmail({ ...live, setPasswordUrl: `${APP}/update-password?token_hash=t&type=recovery&next=%2F` });
    expect(withPassword.body).toContain("Set your password and log in (works once)");
    expect(withPassword.html).toContain("Set your password and log in");
    expect(renderLiveSms({ ...live, setPasswordUrl: "x-token" })).not.toContain("x-token");
  });
});

// ── The follow-up pass (fake DB) ─────────────────────────────────────────────

function purchaseRow(overrides: Row = {}): Row {
  return {
    id: PURCHASE,
    status: "provisioned",
    tier: "catch",
    organization_id: ORG,
    company_id: COMPANY,
    owner_profile_id: "profile-1",
    existing_user: false,
    owner_name: "Jane Roofer",
    owner_email: "jane@roofco.example",
    owner_phone: "(705) 555-0101",
    business_name: "Jane's Roofing",
    provisioned_at: "2026-10-02T19:00:00Z",
    live_at: null,
    setup_reminders_stopped_at: null,
    setup_reminders_stop_token: null,
    setup_followups_exempt_at: null,
    ...overrides,
  };
}

let db: FakeDb;
let deliver: Mock<SetupFollowupDeps["deliver"]>;
let sendEmail: Mock<SetupFollowupDeps["sendEmail"]>;
let createSetPasswordUrl: Mock<SetupFollowupDeps["createSetPasswordUrl"]>;
let signedIn: boolean;

function deps(): Partial<SetupFollowupDeps> {
  return {
    deliver,
    sendEmail,
    createSetPasswordUrl,
    ownerHasSignedIn: async () => signedIn,
    newStopToken: () => TOKEN,
  };
}

function setup(tables: Record<string, Row[]>, purchase: Row = purchaseRow()) {
  db = createFakeDb({ ...tables, crankleads_purchases: [purchase] }, { crankleads_setup_followups: [["purchase_id", "stage"]] });
}

const run = (iso: string) => processSetupFollowups(db.client, at(iso), deps());
const sends = () => db.tables.crankleads_setup_followups ?? [];
const delivered = (channel: "email" | "sms") => deliver.mock.calls.map(([m]) => m).filter((m) => m.channel === channel);

beforeEach(() => {
  vi.stubEnv("APP_BASE_URL", "https://app.house.test");
  vi.stubEnv("CRANKLEADS_APP_BASE_URL", APP);
  vi.stubEnv("OWNER_EMAIL", "ops@empirevu.test");
  deliver = vi.fn<SetupFollowupDeps["deliver"]>(async (input) => ({ status: "sent", body: input.body, providerRef: "ref" }));
  sendEmail = vi.fn<SetupFollowupDeps["sendEmail"]>(async () => ({ id: "op_1" }));
  createSetPasswordUrl = vi.fn<SetupFollowupDeps["createSetPasswordUrl"]>(
    async (_admin, _email, next) => `${APP}/update-password?token_hash=h&type=recovery&next=${encodeURIComponent(next)}`,
  );
  signedIn = false;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("setup follow-up pass", () => {
  it("day 1 (Mon 09:30 local): one email + one SMS with the one-tap forwarding link, platform SMS sender, stop link", async () => {
    setup(baseTables({ voice_numbers: [{ organization_id: ORG, company_id: COMPANY, provider: "twilio", mode: "missed_call_catcher", phone_e164: CATCHER, active: true, forwarding_verified_at: null }] }));
    const outcomes = await run("2026-10-05T13:30:00Z");
    expect(outcomes).toEqual([{ purchaseId: PURCHASE, action: "reminder_sent", stage: "day1" }]);
    expect(sends()).toEqual([
      expect.objectContaining({ organization_id: ORG, company_id: COMPANY, purchase_id: PURCHASE, stage: "day1", local_date: "2026-10-05", next_step: "forwarding", steps_left: 2, email_status: "sent", sms_status: "sent", operator_status: null }),
    ]);
    const [email] = delivered("email");
    const [sms] = delivered("sms");
    const token = db.tables.dfy_progress[0].forward_token as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(email.to).toBe("jane@roofco.example");
    expect(email.fromName).toBe("CrankLeads");
    expect(email.body).toContain(`${APP}/forward/${token}`);
    expect(email.body).toContain(`${APP}/api/public/crankleads/setup-reminders?token=${TOKEN}`);
    expect(email.body).not.toContain("update-password");
    expect(sms.to).toBe("+17055550101");
    expect(sms.smsFrom).toBe("platform");
    expect(sms.consentContact).toBeNull();
    expect(sms.body).toContain(`Jane's Roofing is one tap from live. Turn on call forwarding so every call you miss gets a text back: ${APP}/forward/${token}`);
    expect(db.tables.crankleads_purchases[0].setup_reminders_stop_token).toBe(TOKEN);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("while the 60-second quick setup is unanswered, the reminder links to it (not forwarding)", async () => {
    setup(baseTables({ setup_intakes: [{ organization_id: ORG, company_id: COMPANY, token: "intake-token-1", status: "sent" }] }));
    await run("2026-10-05T13:30:00Z");
    expect(sends()[0]).toMatchObject({ next_step: "quick_setup" });
    expect(delivered("sms")[0].body).toContain(`finish your 60-second setup and we'll switch Jane's Roofing on for you: ${APP}/setup/intake-token-1`);
    expect(delivered("email")[0].subject).toBe("60 seconds to finish setting up Jane's Roofing");
  });

  it("an answered quick setup (enriched) → back to the forwarding link", async () => {
    setup(baseTables({ setup_intakes: [{ organization_id: ORG, company_id: COMPANY, token: "intake-token-1", status: "enriched" }] }));
    await run("2026-10-05T13:30:00Z");
    expect(delivered("sms")[0].body).toContain(`${APP}/forward/`);
    expect(delivered("sms")[0].body).not.toContain("/setup/");
  });

  it("reminders go to the resolved owner email (they carry no login link)", async () => {
    setup(baseTables({ companies: [companyRow({ owner_email: "office@roofco.example" })] }));
    await run("2026-10-05T13:30:00Z");
    expect(delivered("email")[0].to).toBe("office@roofco.example");
    expect(createSetPasswordUrl).not.toHaveBeenCalled();
  });

  it("is idempotent: a second pass (retry / double run) the same day sends nothing", async () => {
    setup(baseTables());
    await run("2026-10-05T13:30:00Z");
    await run("2026-10-05T13:35:00Z");
    await run("2026-10-05T19:00:00Z");
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(sends()).toHaveLength(1);
  });

  it("a stage another worker claims between our read and our claim is never sent (unique violation → skip)", async () => {
    setup(baseTables());
    db.failNext("crankleads_setup_followups", "insert", { message: "duplicate key", code: "23505" });
    const outcomes = await run("2026-10-05T13:30:00Z");
    expect(outcomes).toEqual([{ purchaseId: PURCHASE, action: "skipped", stage: "day1", reason: "already_claimed" }]);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("weekend / night: nothing", async () => {
    setup(baseTables());
    await run("2026-10-03T16:00:00Z"); // Saturday
    await run("2026-10-06T02:00:00Z"); // Mon 22:00
    expect(deliver).not.toHaveBeenCalled();
    expect(sends()).toHaveLength(0);
  });

  it("day 10: last-nudge reminder only — the operator was already alerted by the 24h escalation", async () => {
    setup(baseTables({
      crankleads_setup_followups: ["day1", "day3", "day5"].map((stage, i) => ({ id: `s${i}`, organization_id: ORG, company_id: COMPANY, purchase_id: PURCHASE, stage, local_date: ["2026-10-05", "2026-10-07", "2026-10-09"][i] })),
    }));
    await run("2026-10-16T14:00:00Z");
    await run("2026-10-16T15:00:00Z");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sends().find((s) => s.stage === "day10")).toMatchObject({ operator_status: null, email_status: "sent", sms_status: "sent" });
    expect(delivered("sms")[0].body).toContain("last nudge");
  });

  it("stops immediately once live: stamps live_at, sends ONE 'you're live' email + SMS, no reminders", async () => {
    setup(liveTables());
    const first = await run("2026-10-05T13:30:00Z");
    expect(first.map((o) => o.action)).toEqual(["live_marked", "live_sent"]);
    expect(db.tables.crankleads_purchases[0].live_at).toBe("2026-10-05T13:30:00.000Z");
    expect(delivered("email")[0].subject).toBe("🎉 You're live — Jane's Roofing is catching leads");
    // never signed in → the live EMAIL (buyer's own address only) carries the set-password link; the text never does
    expect(delivered("email")[0].to).toBe("jane@roofco.example");
    expect(delivered("email")[0].body).toContain("update-password?token_hash=h");
    expect(delivered("sms")[0].body).toBe(`CrankLeads: 🎉 You're live! Jane's Roofing: missed callers now get a text back from (705) 555-0000. Log in: ${APP}`);
    await run("2026-10-07T14:00:00Z");
    await run("2026-10-16T14:00:00Z");
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(sends().map((s) => s.stage)).toEqual(["live"]);
  });

  it("went live at night: live_at stamped now, the confirmation waits for 08:00", async () => {
    setup(liveTables());
    await run("2026-10-06T03:00:00Z"); // Mon 23:00 Toronto
    expect(db.tables.crankleads_purchases[0].live_at).toBe("2026-10-06T03:00:00.000Z");
    expect(deliver).not.toHaveBeenCalled();
    await run("2026-10-06T12:30:00Z"); // Tue 08:30
    expect(delivered("email")).toHaveLength(1);
    expect(db.tables.crankleads_purchases[0].live_at).toBe("2026-10-06T03:00:00.000Z");
  });

  it("stops when the subscription is cancelled (no reminders, no live message)", async () => {
    setup(baseTables({ organizations: [{ id: ORG, crankleads_tier: "catch", subscription_status: "canceled" }] }));
    const outcomes = await run("2026-10-05T13:30:00Z");
    expect(outcomes).toEqual([{ purchaseId: PURCHASE, action: "skipped", reason: "subscription_canceled" }]);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("stops when the owner clicked 'stop these reminders' (live still recorded, nothing sent)", async () => {
    setup(baseTables(), purchaseRow({ setup_reminders_stopped_at: "2026-10-05T10:00:00Z" }));
    expect(await run("2026-10-07T14:00:00Z")).toEqual([{ purchaseId: PURCHASE, action: "skipped", reason: "reminders_stopped" }]);
    setup(liveTables(), purchaseRow({ setup_reminders_stopped_at: "2026-10-05T10:00:00Z" }));
    await run("2026-10-07T14:00:00Z");
    expect(db.tables.crankleads_purchases[0].live_at).toBeTruthy();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("buyers provisioned before the migration (exempt) get no reminders and no late 'you're live' — live_at still stamped", async () => {
    setup(baseTables(), purchaseRow({ setup_followups_exempt_at: "2026-10-04T12:00:00Z" }));
    expect(await run("2026-10-07T14:00:00Z")).toEqual([{ purchaseId: PURCHASE, action: "skipped", reason: "followups_exempt" }]);
    expect(deliver).not.toHaveBeenCalled();
    expect(sends()).toHaveLength(0);
    setup(liveTables(), purchaseRow({ setup_followups_exempt_at: "2026-10-04T12:00:00Z" }));
    const outcomes = await run("2026-10-07T14:00:00Z");
    expect(outcomes).toEqual([
      { purchaseId: PURCHASE, action: "live_marked" },
      { purchaseId: PURCHASE, action: "skipped", reason: "followups_exempt" },
    ]);
    expect(db.tables.crankleads_purchases[0].live_at).toBe("2026-10-07T14:00:00.000Z");
    expect(deliver).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a failed send is recorded and never retried as a duplicate", async () => {
    setup(baseTables());
    deliver.mockImplementation(async (input: DeliverMessageInput) =>
      input.channel === "sms" ? { status: "failed" as const, reason: "twilio down", body: input.body } : { status: "sent" as const, body: input.body },
    );
    await run("2026-10-05T13:30:00Z");
    await run("2026-10-05T14:30:00Z");
    expect(sends()[0]).toMatchObject({ email_status: "sent", sms_status: "failed:twilio down" });
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("a per-purchase failure doesn't stop the pass", async () => {
    setup(baseTables());
    db.failNext("organizations", "select");
    const outcomes = await run("2026-10-05T13:30:00Z");
    expect(outcomes[0]).toMatchObject({ action: "failed" });
  });
});

describe("stop-reminders link", () => {
  it("stops by token only; bad / unknown tokens do nothing", async () => {
    setup(baseTables(), purchaseRow({ setup_reminders_stop_token: TOKEN }));
    expect(isStopToken("nope")).toBe(false);
    expect(await stopSetupReminders(db.client, "b".repeat(48))).toBe("not_found");
    expect(await stopSetupReminders(db.client, "not-a-token")).toBe("not_found");
    expect(await stopSetupReminders(db.client, TOKEN, at("2026-10-05T13:30:00Z"))).toBe("stopped");
    expect(db.tables.crankleads_purchases[0].setup_reminders_stopped_at).toBe("2026-10-05T13:30:00.000Z");
    expect(await stopSetupReminders(db.client, TOKEN)).toBe("already_stopped");
  });
});
