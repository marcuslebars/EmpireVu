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
  renderOperatorStuckEmail,
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
const APP = "https://app.empirevu.test";
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

describe("setup checklist — required steps per tier", () => {
  it("catch: services, phone, forwarding, website, automations (no payments)", () => {
    expect(requiredSetupSteps("catch", "missed_call_catcher")).toEqual(["services", "phone", "forwarding", "website", "automations"]);
  });
  it("close: adds payments", () => {
    expect(requiredSetupSteps("close", "missed_call_catcher")).toEqual(["services", "phone", "forwarding", "payments", "website", "automations"]);
  });
  it("front desk on the AI path: test call instead of forwarding, no text-back automation", () => {
    expect(requiredSetupSteps("front_desk", "ai_receptionist")).toEqual(["services", "phone", "test_call", "payments", "website"]);
  });
  it("front desk that chose the catcher: same as close", () => {
    expect(requiredSetupSteps("front_desk", "missed_call_catcher")).toEqual(requiredSetupSteps("close", "missed_call_catcher"));
  });

  it("catch with nothing done: 0 of 5, next = prices, deep link straight to the wizard step for this org", () => {
    const c = checklist("catch", { ...NONE, servicesNeedingPrices: 7 });
    expect(c.doneCount).toBe(0);
    expect(c.totalCount).toBe(5);
    expect(c.isLive).toBe(false);
    expect(c.nextStep?.key).toBe("services");
    expect(c.nextStep?.action).toBe("add prices to your 7 services");
    expect(c.nextStep?.path).toBe(`/onboarding?step=services&org=${ORG}`);
    expect(c.nextStep?.deepLink).toBe(`${APP}/onboarding?step=services&org=${ORG}`);
    expect(c.steps.map((s) => s.wizardStep)).toEqual(["services", "phone", "phone", "website", "recipes"]);
  });

  it("forwarding counts ONLY when the catcher number's forwarding_verified_at is set", () => {
    const unverified = checklist("catch", { ...ALL_CATCHER, forwardingVerified: false });
    expect(unverified.isLive).toBe(false);
    expect(unverified.nextStep?.key).toBe("forwarding");
    expect(unverified.nextStep?.action).toBe(`set call forwarding (dial **004*${CATCHER}# from your business phone)`);
    expect(checklist("catch", ALL_CATCHER).isLive).toBe(true);
    // verified flag without a catcher number never counts
    expect(checklist("catch", { ...ALL_CATCHER, catcherNumber: null }).steps.find((s) => s.key === "forwarding")?.done).toBe(false);
  });

  it("close needs payments; catch doesn't", () => {
    const facts = { ...ALL_CATCHER, paymentsConnected: false };
    expect(checklist("catch", facts).isLive).toBe(true);
    const close = checklist("close", facts);
    expect(close.isLive).toBe(false);
    expect(close.nextStep?.key).toBe("payments");
    expect(close.doneCount).toBe(5);
    expect(close.totalCount).toBe(6);
  });

  it("front desk: AI number + a received call = test done; catcher-only front desk switches to the catcher path", () => {
    const ai = checklist("front_desk", { ...NONE, pricedServices: 1, aiNumber: "+17055550001", paymentsConnected: true, websiteLeadReceived: true });
    expect(ai.phonePath).toBe("ai_receptionist");
    expect(ai.nextStep?.key).toBe("test_call");
    expect(ai.nextStep?.action).toBe("call your AI receptionist at (705) 555-0001 to test it");
    expect(checklist("front_desk", { ...NONE, pricedServices: 1, aiNumber: "+17055550001", receptionistCallReceived: true, paymentsConnected: true, websiteLeadReceived: true }).isLive).toBe(true);
    const catcherFd = checklist("front_desk", ALL_CATCHER);
    expect(catcherFd.phonePath).toBe("missed_call_catcher");
    expect(catcherFd.isLive).toBe(true);
    // Nothing chosen yet → front desk defaults to the AI path.
    expect(checklist("front_desk", NONE).nextStep?.key).toBe("services");
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
    expect(c?.doneCount).toBe(5);
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

const REMINDER: ReminderMessageInput = {
  stage: "day3",
  ownerName: "Jane Roofer",
  businessName: "Jane's Roofing",
  remaining: [
    { title: "Turn on call forwarding", action: `set call forwarding (dial **004*${CATCHER}# from your business phone)` },
    { title: "Add your website form", action: "add your website form and send a test lead" },
  ],
  nextStepUrl: `${APP}/onboarding?step=phone&org=${ORG}`,
  setPasswordUrl: null,
  appUrl: APP,
  stopUrl: `${APP}/api/public/crankleads/setup-reminders?token=${TOKEN}`,
};

describe("follow-up templates", () => {
  it("reminder SMS (golden): names both steps, deep link, STOP line", () => {
    expect(renderReminderSms(REMINDER)).toBe(
      `CrankLeads: Hi Jane, 2 steps left to get Jane's Roofing live: set call forwarding (dial **004*+17055550000# from your business phone) and add your website form and send a test lead. ${APP}/onboarding?step=phone&org=${ORG}\nReply STOP to stop these texts.`,
    );
  });

  it("reminder SMS collapses 3+ steps and has a day-10 variant", () => {
    const three = { ...REMINDER, remaining: [...REMINDER.remaining, { title: "Connect payments", action: "connect Stripe so you can take deposits" }] };
    expect(renderReminderSms(three)).toContain("3 steps left to get Jane's Roofing live: set call forwarding (dial **004*+17055550000# from your business phone) (+2 more).");
    expect(renderReminderSms({ ...REMINDER, stage: "day10", remaining: [REMINDER.remaining[1]] })).toBe(
      `CrankLeads: Hi Jane, last nudge — Jane's Roofing still has 1 step left: add your website form and send a test lead. Reply to our email if you want a hand. ${APP}/onboarding?step=phone&org=${ORG}\nReply STOP to stop these texts.`,
    );
  });

  it("reminder email (golden)", () => {
    const email = renderReminderEmail(REMINDER);
    expect(email.fromName).toBe("CrankLeads");
    expect(email.subject).toBe("Jane's Roofing: 2 steps left — next, set call forwarding (dial **004*+17055550000# from your business phone)");
    expect(email.body).toMatchSnapshot();
    expect(email.html).toMatchSnapshot();
    expect(email.body).not.toMatch(/\$\s?\d/);
  });

  it("reminder email subjects per stage, set-password variant, HTML escaping", () => {
    expect(renderReminderEmail({ ...REMINDER, stage: "day1" }).subject).toBe("2 steps left to get Jane's Roofing live");
    expect(renderReminderEmail({ ...REMINDER, stage: "day5" }).subject).toBe("Your CrankLeads system isn't live yet (2 steps left)");
    expect(renderReminderEmail({ ...REMINDER, stage: "day10" }).subject).toBe("Need a hand finishing setup? (2 steps left)");
    const withPassword = renderReminderEmail({ ...REMINDER, setPasswordUrl: `${APP}/update-password?token_hash=t&type=recovery&next=x` });
    expect(withPassword.body).toContain("You haven't set your EmpireVu password yet");
    expect(withPassword.html).toContain("Set your password and turn on call forwarding");
    expect(renderReminderEmail({ ...REMINDER, businessName: "<b>x</b>" }).html).not.toContain("<b>x</b>");
  });

  it("live + operator templates (golden)", () => {
    const live = { ownerName: "Jane Roofer", businessName: "Jane's Roofing", phonePath: "missed_call_catcher" as const, appUrl: APP };
    expect(renderLiveSms(live)).toBe(
      `CrankLeads: 🎉 You're live! Jane's Roofing is set up — missed callers get a text back in seconds, and website leads land in your inbox. ${APP}`,
    );
    expect(renderLiveSms({ ...live, phonePath: "ai_receptionist" })).toContain("your AI receptionist answers every call");
    const email = renderLiveEmail(live);
    expect(email.subject).toBe("🎉 You're live — Jane's Roofing is catching leads");
    expect(email.body).toMatchSnapshot();
    const op = renderOperatorStuckEmail({
      businessName: "Jane's Roofing",
      tier: "close",
      ownerName: "Jane Roofer",
      ownerEmail: "jane@roofco.example",
      ownerPhone: "(705) 555-0101",
      organizationId: ORG,
      provisionedAt: "2026-10-02T19:00:00Z",
      steps: [
        { title: "Add your prices", done: true },
        { title: "Turn on call forwarding", done: false },
      ],
      appUrl: APP,
    });
    expect(op.subject).toBe("CrankLeads buyer stuck: Jane's Roofing (Close) — 1 step left after 10 business days");
    expect(op.body).toMatchSnapshot();
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
  vi.stubEnv("APP_BASE_URL", APP);
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
  it("day 1 (Mon 09:30 local): one email + one SMS naming the next step, platform SMS sender, stop link, set-password link", async () => {
    setup(baseTables());
    const outcomes = await run("2026-10-05T13:30:00Z");
    expect(outcomes).toEqual([{ purchaseId: PURCHASE, action: "reminder_sent", stage: "day1" }]);
    expect(sends()).toEqual([
      expect.objectContaining({ organization_id: ORG, company_id: COMPANY, purchase_id: PURCHASE, stage: "day1", local_date: "2026-10-05", next_step: "services", steps_left: 5, email_status: "sent", sms_status: "sent", operator_status: null }),
    ]);
    const [email] = delivered("email");
    const [sms] = delivered("sms");
    expect(email.to).toBe("jane@roofco.example");
    expect(email.fromName).toBe("CrankLeads");
    expect(email.body).toContain(`${APP}/onboarding?step=services&org=${ORG}`);
    expect(email.body).toContain(`${APP}/api/public/crankleads/setup-reminders?token=${TOKEN}`);
    expect(email.body).toContain("update-password?token_hash=h");
    expect(createSetPasswordUrl).toHaveBeenCalledWith(db.client, "jane@roofco.example", `/onboarding?step=services&org=${ORG}`);
    expect(sms.to).toBe("+17055550101");
    expect(sms.smsFrom).toBe("platform");
    expect(sms.consentContact).toBeNull();
    expect(sms.body).toContain("5 steps left to get Jane's Roofing live: add prices to your 2 services (+4 more).");
    expect(db.tables.crankleads_purchases[0].setup_reminders_stop_token).toBe(TOKEN);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("owner who already signed in gets no set-password link", async () => {
    setup(baseTables());
    signedIn = true;
    await run("2026-10-05T13:30:00Z");
    expect(createSetPasswordUrl).not.toHaveBeenCalled();
    expect(delivered("email")[0].body).not.toContain("update-password");
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

  it("day 10: reminder + operator 'stuck' note (once)", async () => {
    setup(baseTables({
      crankleads_setup_followups: ["day1", "day3", "day5"].map((stage, i) => ({ id: `s${i}`, organization_id: ORG, company_id: COMPANY, purchase_id: PURCHASE, stage, local_date: ["2026-10-05", "2026-10-07", "2026-10-09"][i] })),
    }));
    await run("2026-10-16T14:00:00Z");
    await run("2026-10-16T15:00:00Z");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ to: "ops@empirevu.test", subject: "CrankLeads buyer stuck: Jane's Roofing (Catch) — 5 steps left after 10 business days" });
    expect(sends().find((s) => s.stage === "day10")).toMatchObject({ operator_status: "sent", email_status: "sent", sms_status: "sent" });
    expect(delivered("sms")[0].body).toContain("last nudge");
  });

  it("stops immediately once live: stamps live_at, sends ONE 'you're live' email + SMS, no reminders", async () => {
    setup(liveTables());
    const first = await run("2026-10-05T13:30:00Z");
    expect(first.map((o) => o.action)).toEqual(["live_marked", "live_sent"]);
    expect(db.tables.crankleads_purchases[0].live_at).toBe("2026-10-05T13:30:00.000Z");
    expect(delivered("email")[0].subject).toBe("🎉 You're live — Jane's Roofing is catching leads");
    expect(delivered("sms")[0].body).toContain("You're live!");
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
