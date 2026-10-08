/**
 * Done-for-you automatic switch-on (docs/done-for-you.md → "Automatic switch-on"):
 * forwarding codes per carrier / kind, the number purchase at provisioning (right type per
 * tier, never throws, bounded retries), the orchestrator's transitions + idempotency, the
 * one-tap forwarding page, booking hours parsing, the 24h escalation, and message goldens.
 * All external APIs are fakes; the DB is the in-memory PostgREST fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "./helpers/fake-supabase";
import {
  CELL_CARRIERS,
  forwardingPlan,
  normalizeCarrier,
  telHrefForCode,
} from "@/lib/carrier-forwarding";
import { isIOSDevice } from "@/lib/dfy-api";
import { bookingHoursFromCompanyHours, parseTime } from "@/server/services/dfy/hours";
import {
  areaCodeForAttempt,
  areaCodeFromPhone,
  ensureDfyNumber,
  NUMBER_MAX_ATTEMPTS,
  numberKindForTier,
} from "@/server/services/dfy/numbers";
import {
  advanceDoneForYou,
  escalationDueAt,
  intakeReadiness,
  processDoneForYou,
  provisionDoneForYouNumber,
  type DoneForYouDeps,
} from "@/server/services/dfy/orchestrator";
import {
  AUTO_TEST_DELAY_MS,
  forwardStatusFor,
  pollForwardPage,
  recordForwardAction,
} from "@/server/services/dfy/forwarding";
import {
  renderForwardingEmail,
  renderForwardingSms,
  renderOperatorEscalationEmail,
} from "@/server/services/dfy/messages";
import { dfyRecipeSlugs, switchOnAutomations } from "@/server/services/dfy/switch-on";
import { buildSetupProgressView } from "@/server/services/dfy/progress-view";
import { computeSetupChecklist } from "@/server/services/crankleads/setup-checklist";
import { conciergeItem } from "@/server/services/operator-health/rules";
import type { RetellClient } from "@/server/services/retell/provision";
import type { TwilioNumbersClient } from "@/server/services/twilio/provision";
import type { DeliverMessageInput } from "@/server/services/workflow-engine/messaging";

type Row = Record<string, unknown>;

const ORG = "org-1";
const COMPANY = "company-1";
const APP = "https://app.crankleads.test";
const CATCHER = "+17055550000";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

// ── Forwarding codes ─────────────────────────────────────────────────────────

describe("forwarding plan per carrier / kind (fixtures)", () => {
  const cell = (carrier: string | null) => forwardingPlan({ forwardTo: "(705) 555-0000", kind: "cell", carrier });

  it("every Canadian cell carrier gets the GSM all-conditional code, # encoded in the tel: link", () => {
    for (const key of ["rogers", "fido", "chatr", "freedom", "bell", "virgin", "lucky", "telus", "koodo", "public", "videotron"]) {
      const plan = cell(key);
      expect(plan.method).toBe("dial_code");
      expect(plan.code).toBe("**004*+17055550000#");
      expect(plan.deactivate).toBe("##004#");
      expect(plan.telHref).toBe("tel:**004*+17055550000%23");
      expect(plan.carrierLabel).toBe(CELL_CARRIERS[key].label);
      expect(plan.fallbackCodes.map((c) => c.activate)).toEqual(["**61*+17055550000#", "**67*+17055550000#", "**62*+17055550000#"]);
    }
  });

  it("confidence: Rogers-network brands + Freedom are confident; the rest need a real-phone check", () => {
    expect(["rogers", "fido", "chatr", "freedom"].map((k) => cell(k).confidence)).toEqual(["confident", "confident", "confident", "confident"]);
    expect(["bell", "virgin", "lucky", "telus", "koodo", "public", "videotron"].every((k) => cell(k).confidence === "verify")).toBe(true);
    // unknown / other carrier → still the standard code, flagged verify
    expect(cell("Shaw Mobile")).toMatchObject({ method: "dial_code", carrierLabel: null, confidence: "verify" });
    expect(cell(null)).toMatchObject({ method: "dial_code", confidence: "verify" });
  });

  it("normalises how the intake might store the carrier", () => {
    expect(normalizeCarrier("Virgin Plus")).toBe("virgin");
    expect(normalizeCarrier("FREEDOM_MOBILE")).toBe("freedom");
    expect(normalizeCarrier("Vidéotron")).toBe("videotron");
    expect(normalizeCarrier("Bell Mobility")).toBe("bell");
    expect(normalizeCarrier("other")).toBeNull();
    expect(normalizeCarrier("  ")).toBeNull();
  });

  it("unknown kind → the cell path (most small trades run on a cell)", () => {
    expect(forwardingPlan({ forwardTo: CATCHER, kind: null, carrier: "rogers" })).toMatchObject({ kind: "unknown", method: "dial_code", confidence: "confident" });
  });

  it("landline / VoIP: no codes — provider steps that name the provider, plus the script", () => {
    const landline = forwardingPlan({ forwardTo: CATCHER, kind: "landline", carrier: "bell" });
    expect(landline).toMatchObject({ method: "provider", code: null, telHref: null, carrierLabel: "Bell" });
    expect(landline.steps).toEqual([
      "Call Bell from any phone.",
      'Ask them to turn on "call forward no answer" and "call forward busy" to (705) 555-0000, after 4–5 rings.',
      "Don't let them forward ALL calls — your phone should still ring first.",
    ]);
    const voip = forwardingPlan({ forwardTo: CATCHER, kind: "voip", carrier: "RingCentral" });
    expect(voip.carrierLabel).toBe("RingCentral");
    expect(voip.steps[0]).toBe('Log in to your RingCentral account and find "call forwarding" (sometimes "call handling" or "find me / follow me").');
    const unknownVoip = forwardingPlan({ forwardTo: CATCHER, kind: "voip", carrier: null });
    expect(unknownVoip.steps[2]).toContain("Call your phone provider");
    expect(landline.providerScript).toBe(
      'Call your phone provider and ask them to forward unanswered and busy calls to (705) 555-0000 ("call forward no answer" and "call forward busy", after about 4–5 rings). Don\'t forward ALL calls.',
    );
  });

  it("tel: hrefs encode # (the fragment character) and iOS is detected (it refuses * and # in tel: links)", () => {
    expect(telHrefForCode("##004#")).toBe("tel:%23%23004%23");
    expect(isIOSDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15")).toBe(true);
    expect(isIOSDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", 5)).toBe(true); // iPadOS
    expect(isIOSDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", 0)).toBe(false);
    expect(isIOSDevice("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36")).toBe(false);
  });
});

// ── Area codes ───────────────────────────────────────────────────────────────

describe("area code for the number", () => {
  it("takes the checkout phone's NPA, falls back to 705 for junk / toll-free", () => {
    expect(areaCodeFromPhone("(416) 555-0100")).toBe(416);
    expect(areaCodeFromPhone("+1 613 555 0100")).toBe(613);
    expect(areaCodeFromPhone("1-800-555-0100")).toBe(705);
    expect(areaCodeFromPhone("555-0100")).toBe(705);
    expect(areaCodeFromPhone(null)).toBe(705);
  });
  it("retries: own area code twice, then 705, then any", () => {
    expect([1, 2, 3, 4, 5].map((n) => areaCodeForAttempt(416, n))).toEqual([416, 416, 705, 705, null]);
    expect(areaCodeForAttempt(705, 3)).toBe(705);
  });
  it("number type per tier", () => {
    expect(numberKindForTier("catch")).toBe("catcher");
    expect(numberKindForTier("close")).toBe("catcher");
    expect(numberKindForTier("front_desk")).toBe("ai");
  });
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

function tables(overrides: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    organizations: [{ id: ORG, crankleads_tier: "catch", subscription_status: "active", platform_brand: "crankleads" }],
    companies: [
      {
        id: COMPANY,
        organization_id: ORG,
        name: "Jane's Roofing",
        timezone: "America/Toronto",
        owner_email: "jane@roofco.example",
        owner_phone_e164: "+14165550101",
        brand_reply_phone: null,
        business_phone_kind: "cell",
        business_phone_carrier: "rogers",
        hours: null,
        online_booking_settings: {},
        review_settings: {},
        brand_review_url: null,
        industry_pack: null,
        service_area: null,
      },
    ],
    crankleads_purchases: [
      {
        id: "purchase-1",
        status: "provisioned",
        tier: "catch",
        organization_id: ORG,
        company_id: COMPANY,
        owner_name: "Jane Roofer",
        owner_email: "jane@roofco.example",
        owner_phone: "(416) 555-0101",
        business_name: "Jane's Roofing",
        provisioned_at: "2026-10-05T13:00:00Z", // Mon 09:00 Toronto
        live_at: null,
        created_at: "2026-10-05T12:59:00Z",
      },
    ],
    voice_numbers: [],
    onboarding_progress: [],
    workflows: [],
    setup_intakes: [],
    dfy_progress: [],
    retell_calls: [],
    forwarding_tests: [],
    service_catalog_items: [],
    public_form_keys: [],
    intake_keys: [],
    company_voice_profiles: [],
    ...overrides,
  };
}

let db: FakeDb;
const at = (iso: string) => Date.parse(iso);

beforeEach(() => {
  vi.stubEnv("APP_BASE_URL", "https://app.house.test");
  vi.stubEnv("CRANKLEADS_APP_BASE_URL", APP);
  vi.stubEnv("OWNER_EMAIL", "ops@crankleads.test");
  vi.stubEnv("BUSINESS_TIMEZONE", "America/Toronto");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ── Number purchase ──────────────────────────────────────────────────────────

function fakeTwilio(log: string[], opts: { fail?: boolean } = {}): TwilioNumbersClient {
  return {
    async searchAvailableLocal(country, areaCode) {
      log.push(`search ${country} ${areaCode ?? "any"}`);
      if (opts.fail) throw new Error("twilio down");
      return [{ phone_number: `+1${areaCode ?? 705}5550000` }];
    },
    async listIncoming() {
      return [];
    },
    async purchase(input) {
      log.push(`buy ${input.phoneNumber}`);
      return { sid: "PN1", phone_number: input.phoneNumber, friendly_name: input.friendlyName, voice_url: input.voiceUrl, sms_url: input.smsUrl };
    },
    async updateWebhooks(sid) {
      return { sid, phone_number: "+14165550000" };
    },
  };
}

function fakeRetell(log: string[]): RetellClient {
  return {
    createLlm: async () => (log.push("createLlm"), { llm_id: "llm_1" }),
    updateLlm: async (id) => (log.push(`updateLlm ${id}`), { llm_id: id }),
    createAgent: async () => (log.push("createAgent"), { agent_id: "agent_1" }),
    updateAgent: async (id) => (log.push(`updateAgent ${id}`), { agent_id: id }),
    createPhoneNumber: async (body) => (log.push(`buy ${String(body.area_code)}`), { phone_number: "+14165550123", phone_number_pretty: "(416) 555-0123" }),
    updatePhoneNumber: async (n) => (log.push(`rebind ${n}`), { phone_number: n }),
    listPhoneNumbers: async () => [],
  };
}

describe("number at purchase (ensureDfyNumber)", () => {
  const input = { organizationId: ORG, companyId: COMPANY, tier: "catch" as const, ownerPhone: "(416) 555-0101" };

  it("Catch / Close: buys the missed-call catcher number in the checkout phone's area code and records the Phone step", async () => {
    db = createFakeDb(tables());
    const log: string[] = [];
    const out = await ensureDfyNumber(db.client, input, { twilio: fakeTwilio(log), lookupOwner: async () => null, now: () => at("2026-10-05T13:00:00Z") });
    expect(out).toEqual({ status: "ready", phoneNumber: "+14165550000", purchasedNow: true, kind: "catcher" });
    expect(log).toEqual(["search CA 416", "buy +14165550000"]);
    expect(db.tables.voice_numbers[0]).toMatchObject({ organization_id: ORG, company_id: COMPANY, provider: "twilio", mode: "missed_call_catcher", phone_e164: "+14165550000", active: true });
    expect(db.tables.onboarding_progress.find((p) => p.step === "phone")?.data).toMatchObject({ mode: "missed_call_catcher", catcherNumber: "+14165550000", source: "done_for_you" });
    expect(db.tables.dfy_progress[0]).toMatchObject({ number_attempts: 1, number_last_error: null, number_ready_at: "2026-10-05T13:00:00.000Z" });
    // idempotent: a second call records ready, buys nothing
    const again = await ensureDfyNumber(db.client, input, { twilio: fakeTwilio(log), lookupOwner: async () => null });
    expect(again).toEqual({ status: "ready", phoneNumber: "+14165550000", purchasedNow: false, kind: "catcher" });
    expect(log.filter((l) => l.startsWith("buy"))).toHaveLength(1);
  });

  it("Front Desk: buys the AI receptionist's number (Retell), never a catcher", async () => {
    db = createFakeDb(tables({ organizations: [{ id: ORG, crankleads_tier: "front_desk", subscription_status: "active" }] }));
    const log: string[] = [];
    const twilioLog: string[] = [];
    const out = await ensureDfyNumber(db.client, { ...input, tier: "front_desk" }, { retell: fakeRetell(log), twilio: fakeTwilio(twilioLog) });
    expect(out).toMatchObject({ status: "ready", phoneNumber: "+14165550123", purchasedNow: true });
    expect(log).toEqual(["createLlm", "createAgent", "buy 416"]);
    expect(twilioLog).toEqual([]);
    expect(db.tables.voice_numbers[0]).toMatchObject({ provider: "retell", provider_agent_id: "agent_1", phone_e164: "+14165550123" });
    expect(db.tables.onboarding_progress.find((p) => p.step === "phone")?.data).toMatchObject({ llmId: "llm_1", agentId: "agent_1", phoneNumber: "+14165550123" });
  });

  it("Front Desk already on the catcher path: the text-back number counts as ready, no AI number is bought", async () => {
    db = createFakeDb(
      tables({
        organizations: [{ id: ORG, crankleads_tier: "front_desk", subscription_status: "active" }],
        voice_numbers: [{ id: "vn-c", organization_id: ORG, company_id: COMPANY, provider: "twilio", mode: "missed_call_catcher", phone_e164: "+17055550000", active: true }],
      }),
    );
    const log: string[] = [];
    const out = await ensureDfyNumber(db.client, { ...input, tier: "front_desk" }, { retell: fakeRetell(log) });
    expect(out).toEqual({ status: "ready", phoneNumber: "+17055550000", purchasedNow: false, kind: "catcher" });
    expect(log).toEqual([]);
    expect(db.tables.voice_numbers).toHaveLength(1);
    expect(db.tables.dfy_progress[0]).toMatchObject({ number_attempts: 0 });
  });

  it("an inactive catcher number doesn't count: Front Desk with no active number buys the AI number", async () => {
    db = createFakeDb(
      tables({
        organizations: [{ id: ORG, crankleads_tier: "front_desk", subscription_status: "active" }],
        voice_numbers: [{ id: "vn-c", organization_id: ORG, company_id: COMPANY, provider: "twilio", mode: "missed_call_catcher", phone_e164: "+17055550000", active: false }],
      }),
    );
    const log: string[] = [];
    const out = await ensureDfyNumber(db.client, { ...input, tier: "front_desk" }, { retell: fakeRetell(log) });
    expect(out).toMatchObject({ status: "ready", purchasedNow: true, kind: "ai" });
    expect(log).toContain("buy 416");
  });

  it("never throws: a failure is recorded, retried with backoff, then flagged for an operator ONCE", async () => {
    db = createFakeDb(tables());
    const alert = vi.fn(async () => undefined);
    const log: string[] = [];
    let t = at("2026-10-05T13:00:00Z");
    const deps = { twilio: fakeTwilio(log, { fail: true }), lookupOwner: async () => null, alertOperator: alert, now: () => t };
    const first = await ensureDfyNumber(db.client, input, deps);
    expect(first).toMatchObject({ status: "failed", attempts: 1 });
    expect(db.tables.dfy_progress[0].number_last_error).toContain("twilio down");
    // too soon → waits (backoff), no new attempt
    t += 30_000;
    expect(await ensureDfyNumber(db.client, input, deps)).toEqual({ status: "waiting", attempts: 1 });
    for (let i = 2; i <= NUMBER_MAX_ATTEMPTS; i++) {
      t += 2 * 3_600_000;
      expect(await ensureDfyNumber(db.client, input, deps)).toMatchObject({ status: "failed", attempts: i });
    }
    expect(log.filter((l) => l.startsWith("search"))).toEqual(["search CA 416", "search CA 416", "search CA 705", "search CA 705", "search CA any"]);
    expect(db.tables.dfy_progress[0].number_flagged_at).toBeTruthy();
    expect(alert).toHaveBeenCalledTimes(1);
    t += 2 * 3_600_000;
    expect(await ensureDfyNumber(db.client, input, deps)).toMatchObject({ status: "flagged" });
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("provisionDoneForYouNumber swallows even an unexpected throw (purchase provisioning never fails over the number)", async () => {
    db = createFakeDb(tables());
    const out = await provisionDoneForYouNumber(db.client, input, {
      ensureNumber: async () => {
        throw new Error("kaboom");
      },
    });
    expect(out).toBeNull();
  });

  it("with no Twilio configured it records the error instead of throwing", async () => {
    db = createFakeDb(tables());
    const out = await ensureDfyNumber(db.client, input, { lookupOwner: async () => null });
    expect(out).toMatchObject({ status: "failed" });
    expect(String(db.tables.dfy_progress[0].number_last_error)).toMatch(/Twilio is not configured/);
  });
});

// ── Orchestrator ─────────────────────────────────────────────────────────────

const catcherRow = (overrides: Row = {}): Row => ({
  id: "vn-1",
  organization_id: ORG,
  company_id: COMPANY,
  provider: "twilio",
  mode: "missed_call_catcher",
  phone_e164: CATCHER,
  active: true,
  forwarding_verified_at: null,
  created_at: "2026-10-05T13:00:00Z",
  ...overrides,
});

interface Harness {
  deps: Partial<DoneForYouDeps>;
  delivered: DeliverMessageInput[];
  operatorEmails: Array<{ subject: string; body: string }>;
  switchOn: ReturnType<typeof vi.fn>;
  startTest: ReturnType<typeof vi.fn>;
}

function harness(nowIso: string): Harness {
  const delivered: DeliverMessageInput[] = [];
  const operatorEmails: Array<{ subject: string; body: string }> = [];
  const switchOn = vi.fn(async () => ({
    automations: { activated: ["missed-call-text-back"], alreadyActive: [], keptDraft: [] },
    reviews: "no_review_url" as const,
    booking: "no_hours" as const,
    receptionist: "not_front_desk" as const,
  }));
  const startTest = vi.fn(async () => ({}));
  return {
    delivered,
    operatorEmails,
    switchOn,
    startTest,
    deps: {
      now: () => at(nowIso),
      deliver: async (input) => {
        delivered.push(input);
        return { status: "sent", body: input.body };
      },
      sendEmail: async (input) => {
        operatorEmails.push({ subject: input.subject, body: input.body });
        return { id: "e1" };
      },
      ensureNumber: async () => ({ status: "ready", phoneNumber: CATCHER, purchasedNow: false }),
      switchOn,
      startTest,
      generateSite: async () => undefined,
    },
  };
}

describe("intake readiness + escalation timing (pure)", () => {
  const P = at("2026-10-05T13:00:00Z");
  it("enriched → go; unanswered waits 2h then proceeds; stuck enrichment proceeds after 6h; no intake → 2h after purchase", () => {
    const intake = (status: string, extra: Row = {}) =>
      ({ status, created_at: "2026-10-05T13:00:00Z", submitted_at: null, enriched_at: null, token: "t", ...extra }) as never;
    expect(intakeReadiness(intake("enriched"), P, P + 60_000)).toBe("enriched");
    expect(intakeReadiness(intake("sent"), P, P + 3_600_000)).toBe("waiting");
    expect(intakeReadiness(intake("opened"), P, P + 2 * 3_600_000)).toBe("waited");
    expect(intakeReadiness(intake("failed"), P, P + 2 * 3_600_000)).toBe("waited");
    expect(intakeReadiness(intake("enriching", { submitted_at: "2026-10-05T13:05:00Z" }), P, P + 3 * 3_600_000)).toBe("waiting");
    expect(intakeReadiness(intake("enriching", { submitted_at: "2026-10-05T13:05:00Z" }), P, P + 7 * 3_600_000)).toBe("waited");
    expect(intakeReadiness(null, P, P + 3_600_000)).toBe("waiting");
    expect(intakeReadiness(null, P, P + 2 * 3_600_000)).toBe("no_intake");
  });
  it("escalation: purchase + 24h, moved into operator hours (Mon–Fri 08–18 Toronto)", () => {
    const tz = "America/Toronto";
    // Mon 09:00 → Tue 09:00
    expect(new Date(escalationDueAt(at("2026-10-05T13:00:00Z"), tz)).toISOString()).toBe("2026-10-06T13:00:00.000Z");
    // Tue 22:00 → Wed 22:00 → Thu 08:00
    expect(new Date(escalationDueAt(at("2026-10-07T02:00:00Z"), tz)).toISOString()).toBe("2026-10-08T12:00:00.000Z");
    // Fri 15:00 → Sat 15:00 → Mon 08:00
    expect(new Date(escalationDueAt(at("2026-10-09T19:00:00Z"), tz)).toISOString()).toBe("2026-10-12T12:00:00.000Z");
  });
});

describe("advanceDoneForYou — transitions + idempotency", () => {
  it("waits for the intake: number checked, nothing switched on, no forwarding text", async () => {
    db = createFakeDb(tables({ setup_intakes: [{ organization_id: ORG, company_id: COMPANY, token: "it", status: "sent", created_at: "2026-10-05T13:00:00Z" }], voice_numbers: [catcherRow()] }));
    const h = harness("2026-10-05T13:30:00Z");
    const out = await advanceDoneForYou(db.client, COMPANY, h.deps);
    expect(out.steps).toEqual(["number_ready", "waiting_for_intake"]);
    expect(h.switchOn).not.toHaveBeenCalled();
    expect(h.delivered).toHaveLength(0);
  });

  it("intake enriched → switch on ONCE, then the forwarding link ONCE (text + email, platform sender)", async () => {
    db = createFakeDb(tables({ setup_intakes: [{ organization_id: ORG, company_id: COMPANY, token: "it", status: "enriched", created_at: "2026-10-05T13:00:00Z" }], voice_numbers: [catcherRow()] }));
    const h = harness("2026-10-05T14:00:00Z");
    const first = await advanceDoneForYou(db.client, COMPANY, h.deps);
    expect(first.steps).toEqual(["number_ready", "switched_on", "site_built", "forwarding_text_sent"]);
    expect(h.switchOn).toHaveBeenCalledTimes(1);
    expect(h.switchOn.mock.calls[0].slice(1)).toEqual([COMPANY, "catch"]);
    const progress = db.tables.dfy_progress[0];
    expect(progress.switch_on_detail).toMatchObject({ readiness: "enriched", automations: { activated: ["missed-call-text-back"] } });
    const sms = h.delivered.find((m) => m.channel === "sms");
    const email = h.delivered.find((m) => m.channel === "email");
    expect(sms).toMatchObject({ to: "+14165550101", smsFrom: "platform", contactId: null, consentContact: null });
    expect(sms?.body).toContain(`${APP}/forward/${progress.forward_token}`);
    expect(email).toMatchObject({ to: "jane@roofco.example", subject: "Last step for Jane's Roofing: turn on call forwarding" });
    // second + third pass: nothing new
    await advanceDoneForYou(db.client, COMPANY, h.deps);
    const third = await advanceDoneForYou(db.client, COMPANY, h.deps);
    expect(third.steps).toEqual(["number_ready"]);
    expect(h.switchOn).toHaveBeenCalledTimes(1);
    expect(h.delivered).toHaveLength(2);
  });

  it("an unanswered intake ≥2h old → proceeds with what we have", async () => {
    db = createFakeDb(tables({ setup_intakes: [{ organization_id: ORG, company_id: COMPANY, token: "it", status: "opened", created_at: "2026-10-05T13:00:00Z" }], voice_numbers: [catcherRow()] }));
    const h = harness("2026-10-05T15:01:00Z");
    expect((await advanceDoneForYou(db.client, COMPANY, h.deps)).steps).toContain("switched_on");
    expect(db.tables.dfy_progress[0].switch_on_detail).toMatchObject({ readiness: "waited" });
  });

  it("forwarding text waits for the number and for daytime (08–21 local)", async () => {
    db = createFakeDb(tables({ setup_intakes: [{ organization_id: ORG, company_id: COMPANY, token: "it", status: "enriched", created_at: "2026-10-05T13:00:00Z" }] }));
    const h = harness("2026-10-05T14:00:00Z");
    h.deps.ensureNumber = async () => ({ status: "failed", error: "x", attempts: 1 });
    expect((await advanceDoneForYou(db.client, COMPANY, h.deps)).steps).toEqual(["number_failed", "switched_on", "site_built"]);
    expect(h.delivered).toHaveLength(0);
    db.tables.voice_numbers.push(catcherRow());
    const night = harness("2026-10-06T02:30:00Z"); // 22:30 Toronto
    night.deps.switchOn = h.switchOn as never;
    expect((await advanceDoneForYou(db.client, COMPANY, night.deps)).steps).not.toContain("forwarding_text_sent");
    const morning = harness("2026-10-06T12:30:00Z"); // 08:30
    expect((await advanceDoneForYou(db.client, COMPANY, morning.deps)).steps).toContain("forwarding_text_sent");
  });

  it("after the owner taps: one automatic forwarding test once the carrier has had a moment", async () => {
    db = createFakeDb(
      tables({
        setup_intakes: [{ organization_id: ORG, company_id: COMPANY, token: "it", status: "enriched", created_at: "2026-10-05T13:00:00Z" }],
        voice_numbers: [catcherRow()],
        dfy_progress: [
          { organization_id: ORG, company_id: COMPANY, number_attempts: 0, forward_tests_started: 0, switched_on_at: "2026-10-05T14:00:00Z", forward_text_sent_at: "2026-10-05T14:00:00Z", forward_token: TOKEN, forward_tapped_at: "2026-10-05T15:00:00Z", forward_last_test_at: null },
        ],
      }),
    );
    const early = harness(new Date(at("2026-10-05T15:00:00Z") + AUTO_TEST_DELAY_MS - 5_000).toISOString());
    expect((await advanceDoneForYou(db.client, COMPANY, early.deps)).steps).not.toContain("forwarding_test_started");
    const h = harness("2026-10-05T15:01:00Z");
    expect((await advanceDoneForYou(db.client, COMPANY, h.deps)).steps).toContain("forwarding_test_started");
    expect(h.startTest).toHaveBeenCalledTimes(1);
    expect(h.startTest.mock.calls[0][1]).toBe(COMPANY);
    expect(h.startTest.mock.calls[0][0]).toMatchObject({ organizationId: ORG });
    await advanceDoneForYou(db.client, COMPANY, h.deps);
    expect(h.startTest).toHaveBeenCalledTimes(1);
    // a new tap allows another test
    db.tables.dfy_progress[0].forward_tapped_at = "2026-10-05T15:10:00Z";
    const later = harness("2026-10-05T15:11:00Z");
    await advanceDoneForYou(db.client, COMPANY, later.deps);
    expect(later.startTest).toHaveBeenCalledTimes(1);
  });

  it("not live 24h after purchase (operator hours) → ONE operator escalation with the concierge link", async () => {
    db = createFakeDb(tables({ setup_intakes: [{ organization_id: ORG, company_id: COMPANY, token: "it", status: "enriched", created_at: "2026-10-05T13:00:00Z" }], voice_numbers: [catcherRow()] }));
    const before = harness("2026-10-06T12:59:00Z");
    expect((await advanceDoneForYou(db.client, COMPANY, before.deps)).steps).not.toContain("escalated");
    const h = harness("2026-10-06T13:00:00Z");
    expect((await advanceDoneForYou(db.client, COMPANY, h.deps)).steps).toContain("escalated");
    expect(h.operatorEmails).toHaveLength(1);
    expect(h.operatorEmails[0].subject).toBe("Call Jane Roofer (416) 555-0101 to finish setup — Jane's Roofing");
    expect(h.operatorEmails[0].body).toContain(`https://app.house.test/concierge/${ORG}`);
    expect(h.operatorEmails[0].body).toContain("[x] Text-back number");
    expect(h.operatorEmails[0].body).toContain("[ ] Turn on call forwarding");
    await advanceDoneForYou(db.client, COMPANY, harness("2026-10-06T15:00:00Z").deps);
    expect(db.tables.dfy_progress[0].escalated_at).toBe("2026-10-06T13:00:00.000Z");
    expect(h.operatorEmails).toHaveLength(1);
  });

  it("no escalation once the checklist is live; skips live / cancelled / non-CrankLeads companies", async () => {
    db = createFakeDb(
      tables({
        voice_numbers: [catcherRow({ forwarding_verified_at: "2026-10-05T16:00:00Z" })],
        workflows: [{ id: "wf", organization_id: ORG, company_id: COMPANY, slug: "missed-call-text-back", status: "active" }],
      }),
    );
    const h = harness("2026-10-06T14:00:00Z");
    const out = await advanceDoneForYou(db.client, COMPANY, h.deps);
    expect(out.steps).toContain("live");
    expect(h.operatorEmails).toHaveLength(0);

    db.tables.crankleads_purchases[0].live_at = "2026-10-06T14:00:00Z";
    expect(await advanceDoneForYou(db.client, COMPANY, h.deps)).toMatchObject({ skipped: "live" });
    db.tables.organizations[0].subscription_status = "canceled";
    expect(await advanceDoneForYou(db.client, COMPANY, h.deps)).toMatchObject({ skipped: "subscription_canceled" });
    db.tables.organizations[0].crankleads_tier = null;
    expect(await advanceDoneForYou(db.client, COMPANY, h.deps)).toMatchObject({ skipped: "not_crankleads" });
  });

  it("never throws: an unexpected failure is recorded on dfy_progress.last_error", async () => {
    db = createFakeDb(tables({ voice_numbers: [catcherRow()] }));
    const h = harness("2026-10-05T14:00:00Z");
    h.deps.ensureNumber = async () => {
      throw new Error("db hiccup");
    };
    const out = await advanceDoneForYou(db.client, COMPANY, h.deps);
    expect(out.error).toBe("db hiccup");
    expect(db.tables.dfy_progress[0].last_error).toBe("db hiccup");
  });

  it("processDoneForYou sweeps provisioned, not-live purchases (bounded) and survives per-company failures", async () => {
    db = createFakeDb(tables({ voice_numbers: [catcherRow()] }));
    const h = harness("2026-10-05T14:00:00Z");
    const results = await processDoneForYou(db.client, at("2026-10-05T14:00:00Z"), h.deps);
    expect(results.map((r) => r.companyId)).toEqual([COMPANY]);
    db.failNext("crankleads_purchases", "select");
    expect(await processDoneForYou(db.client, at("2026-10-05T14:05:00Z"), h.deps)).toEqual([]);
  });
});

// ── Forwarding page ──────────────────────────────────────────────────────────

describe("one-tap forwarding page", () => {
  function pageTables(overrides: Record<string, Row[]> = {}) {
    return tables({
      voice_numbers: [catcherRow()],
      dfy_progress: [{ organization_id: ORG, company_id: COMPANY, number_attempts: 0, forward_tests_started: 0, forward_token: TOKEN, forward_tapped_at: null, forward_last_test_at: null, forward_help_requested_at: null, forward_opened_at: null }],
      ...overrides,
    });
  }

  it("view: the code for this carrier, the business line, nothing private", async () => {
    db = createFakeDb(pageTables());
    const view = await pollForwardPage(db.client, TOKEN);
    expect(view).toMatchObject({
      businessName: "Jane's Roofing",
      brandName: "CrankLeads",
      phonePath: "missed_call_catcher",
      status: "ready",
      businessLinePretty: "(416) 555-0101",
      plan: { method: "dial_code", code: "**004*+17055550000#", carrierLabel: "Rogers", confidence: "confident" },
    });
    expect(JSON.stringify(view)).not.toContain("jane@roofco.example");
    expect(await pollForwardPage(db.client, "not-a-token")).toBeNull();
    expect(await pollForwardPage(db.client, "ZZ" + TOKEN.slice(2))).toBeNull();
  });

  it("tap → the poll starts ONE automatic forwarding test after the delay", async () => {
    db = createFakeDb(pageTables());
    const startTest = vi.fn(async () => ({}));
    const t0 = at("2026-10-05T15:00:00Z");
    await recordForwardAction(db.client, TOKEN, "tapped", { now: () => t0 });
    expect(db.tables.dfy_progress[0].forward_tapped_at).toBe("2026-10-05T15:00:00.000Z");
    await pollForwardPage(db.client, TOKEN, { startTest, now: () => t0 + 10_000 });
    expect(startTest).not.toHaveBeenCalled();
    await pollForwardPage(db.client, TOKEN, { startTest, now: () => t0 + AUTO_TEST_DELAY_MS + 1 });
    await pollForwardPage(db.client, TOKEN, { startTest, now: () => t0 + AUTO_TEST_DELAY_MS + 5_000 });
    expect(startTest).toHaveBeenCalledTimes(1);
    expect(db.tables.dfy_progress[0].forward_tests_started).toBe(1);
  });

  it("tapped after 9pm: the test isn't claimed (or burned) at night; it goes after 8am", async () => {
    db = createFakeDb(pageTables());
    const startTest = vi.fn(async () => ({}));
    const t0 = at("2026-10-06T01:30:00Z"); // 21:30 Toronto
    await recordForwardAction(db.client, TOKEN, "tapped", { now: () => t0 });
    await pollForwardPage(db.client, TOKEN, { startTest, now: () => t0 + 3_600_000 });
    expect(startTest).not.toHaveBeenCalled();
    expect(db.tables.dfy_progress[0].forward_tests_started).toBe(0);
    expect(db.tables.dfy_progress[0].forward_last_test_at ?? null).toBeNull();
    await pollForwardPage(db.client, TOKEN, { startTest, now: () => at("2026-10-06T12:05:00Z") }); // 08:05
    expect(startTest).toHaveBeenCalledTimes(1);
    expect(forwardStatusFor({ hasNumber: true, verified: false, phonePath: "missed_call_catcher", latestTest: null, tapped: true, canCallNow: false }).message).toContain(
      "after 8am",
    );
  });

  it("'Have us set it up' notifies the operator once", async () => {
    db = createFakeDb(pageTables());
    const onHelpRequested = vi.fn(async () => undefined);
    const view = await recordForwardAction(db.client, TOKEN, "help", { onHelpRequested });
    await recordForwardAction(db.client, TOKEN, "help", { onHelpRequested });
    expect(onHelpRequested).toHaveBeenCalledTimes(1);
    expect(view?.helpRequested).toBe(true);
  });

  it("Front Desk: forwards to the AI number; verified only by a call that shows forwarding; never auto-test-called", async () => {
    db = createFakeDb(
      pageTables({
        organizations: [{ id: ORG, crankleads_tier: "front_desk", subscription_status: "active" }],
        voice_numbers: [{ id: "vn-ai", organization_id: ORG, company_id: COMPANY, provider: "retell", mode: "ai_receptionist", phone_e164: "+14165550123", active: true, forwarding_verified_at: null }],
      }),
    );
    const startTest = vi.fn(async () => ({}));
    await recordForwardAction(db.client, TOKEN, "tapped", { now: () => at("2026-10-05T15:00:00Z") });
    const view = await pollForwardPage(db.client, TOKEN, { startTest, now: () => at("2026-10-05T15:05:00Z") });
    expect(view?.plan?.code).toBe("**004*+14165550123#");
    expect(view?.statusMessage).toContain("your AI receptionist should pick up");
    expect(startTest).not.toHaveBeenCalled();
    const call = (id: string, overrides: Row) => ({ id, organization_id: ORG, company_id: COMPANY, direction: "inbound", to_number: "+14165550123", raw_payload: {}, ...overrides });
    // Before the tap: a customer call straight to the AI number proves nothing.
    db.tables.retell_calls.push(call("call-0", { from_number: "+16475550199", created_at: "2026-10-05T14:00:00Z" }));
    expect((await pollForwardPage(db.client, TOKEN))?.status).not.toBe("verified");
    // After the tap, but FROM the business line itself (owner dialled the AI number directly): no.
    db.tables.retell_calls.push(call("call-1", { from_number: "+14165550101", created_at: "2026-10-05T15:10:00Z" }));
    expect((await pollForwardPage(db.client, TOKEN))?.status).not.toBe("verified");
    // After the tap, from another phone → the business line forwarded it.
    db.tables.retell_calls.push(call("call-2", { from_number: "+16475550199", created_at: "2026-10-05T15:12:00Z" }));
    expect((await pollForwardPage(db.client, TOKEN))?.status).toBe("verified");
  });

  it("Front Desk evidence rule (pure): diversion header from the business line counts without a tap", async () => {
    const { isForwardedReceptionistCall, diversionNumbers } = await import("@/server/services/dfy/front-desk-forwarding");
    const ctx = { businessLine: "+14165550101", aiNumber: "+14165550123", forwardTappedAt: null };
    const base = { from_number: "+16475550199", to_number: "+14165550123", direction: "inbound", created_at: "2026-10-05T15:00:00Z" };
    expect(diversionNumbers({ call: { sip_headers: { Diversion: "<sip:+14165550101@carrier.ca>;reason=no-answer" } } })).toEqual(["+14165550101"]);
    expect(isForwardedReceptionistCall({ ...base, raw_payload: { forwarded_from: "+1 (416) 555-0101" } }, ctx)).toBe(true);
    expect(isForwardedReceptionistCall({ ...base, raw_payload: { forwarded_from: "+19055550000" } }, ctx)).toBe(false);
    expect(isForwardedReceptionistCall({ ...base, raw_payload: {} }, ctx)).toBe(false);
    expect(isForwardedReceptionistCall({ ...base, direction: "outbound", raw_payload: {} }, { ...ctx, forwardTappedAt: "2026-10-05T14:00:00Z" })).toBe(false);
    expect(isForwardedReceptionistCall({ ...base, to_number: "+19995550000", raw_payload: {} }, { ...ctx, forwardTappedAt: "2026-10-05T14:00:00Z" })).toBe(false);
    expect(isForwardedReceptionistCall({ ...base, raw_payload: {} }, { ...ctx, forwardTappedAt: "2026-10-05T14:00:00Z" })).toBe(true);
  });

  it("status lines", () => {
    const base = { hasNumber: true, verified: false, phonePath: "missed_call_catcher" as const, latestTest: null, tapped: false };
    expect(forwardStatusFor({ ...base, hasNumber: false }).status).toBe("number_pending");
    expect(forwardStatusFor(base)).toEqual({ status: "ready", message: null });
    expect(forwardStatusFor({ ...base, tapped: true }).message).toContain("We'll call your business line in about a minute");
    expect(forwardStatusFor({ ...base, tapped: true, latestTest: "calling" }).status).toBe("testing");
    expect(forwardStatusFor({ ...base, tapped: true, latestTest: "not_forwarded" }).status).toBe("not_forwarded");
    expect(forwardStatusFor({ ...base, verified: true }).message).toBe("Forwarding works — missed callers now get a text back.");
  });
});

// ── Switch-on ────────────────────────────────────────────────────────────────

describe("switch-on", () => {
  it("recipes per tier", () => {
    expect(dfyRecipeSlugs("catch")).toEqual(["missed-call-text-back", "new-lead-owner-alert", "booking-reminder", "customer-text-to-owner"]);
    expect(dfyRecipeSlugs("close")).toEqual(expect.arrayContaining(["quote-follow-up", "no-show-recovery", "stale-lead-nudge"]));
    expect(dfyRecipeSlugs("close")).not.toContain("call-summary-to-owner");
    expect(dfyRecipeSlugs("front_desk")).toEqual(expect.arrayContaining(["call-summary-to-owner", "no-show-recovery"]));
    expect(dfyRecipeSlugs("front_desk")).not.toContain("review-request"); // review requests run from review settings
  });

  it("turns drafts on (when SMS is configured), leaves paused alone", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC1");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "t");
    vi.stubEnv("TWILIO_FROM_NUMBER", "+17055559999");
    const wf = (slug: string, status: string) => ({ id: `wf-${slug}`, organization_id: ORG, company_id: COMPANY, slug, status, definition: { _disabled_reason: "x" } });
    db = createFakeDb(
      tables({
        workflows: [
          ...dfyRecipeSlugs("close").map((slug) => wf(slug, "draft")),
          { ...wf("quote-follow-up", "paused") },
        ].filter((w, i, all) => all.findIndex((x) => x.slug === w.slug) === i || w.status === "paused"),
      }),
    );
    db.tables.workflows = db.tables.workflows.filter((w) => !(w.slug === "quote-follow-up" && w.status === "draft"));
    const ctx = { organizationId: ORG, actorProfileId: null, supabase: db.client };
    const result = await switchOnAutomations(ctx, COMPANY, "close");
    expect(result.activated).toEqual(expect.arrayContaining(["missed-call-text-back", "no-show-recovery", "stale-lead-nudge"]));
    expect(result.activated).not.toContain("quote-follow-up");
    expect(db.tables.workflows.find((w) => w.slug === "quote-follow-up")?.status).toBe("paused");
    expect(db.tables.workflows.find((w) => w.slug === "no-show-recovery")).toMatchObject({ status: "active", definition: {} });
  });
});

// ── Booking hours ────────────────────────────────────────────────────────────

describe("booking hours from companies.hours (fixtures)", () => {
  it("parses times", () => {
    expect([parseTime("8am"), parseTime("8:30 PM"), parseTime("17:00"), parseTime("0800"), parseTime("noon"), parseTime("13pm")]).toEqual([480, 1230, 1020, 480, 720, null]);
  });
  it("structured day keys", () => {
    expect(
      bookingHoursFromCompanyHours({ monday: { open: "08:00", close: "17:00" }, tuesday: { open: "08:00", close: "18:30" }, saturday: "closed", sunday: null }),
    ).toEqual({ startHour: 8, endHour: 19, workingDays: [1, 2] });
  });
  it("Google periods + weekday text", () => {
    expect(
      bookingHoursFromCompanyHours({ periods: [1, 2, 3, 4, 5].map((day) => ({ open: { day, time: "0700" }, close: { day, time: "1600" } })) }),
    ).toEqual({ startHour: 7, endHour: 16, workingDays: [1, 2, 3, 4, 5] });
    expect(
      bookingHoursFromCompanyHours({ weekdayText: ["Monday: 8:00 AM – 5:00 PM", "Tuesday: 8:00 AM – 5:00 PM", "Saturday: 9:00 AM – 1:00 PM", "Sunday: Closed"] }),
    ).toEqual({ startHour: 8, endHour: 17, workingDays: [1, 2, 6] });
  });
  it("the enrichment's own Google shape ({ summary, periods: [{ day, open, close }] })", () => {
    const enriched = {
      summary: "Monday: 7:00 AM – 6:00 PM; Tuesday: 7:00 AM – 6:00 PM; Saturday: 8:00 AM – 12:00 PM; Sunday: Closed",
      periods: [
        { day: 1, open: "07:00", close: "18:00" },
        { day: 2, open: "07:00", close: "18:00" },
        { day: 6, open: "08:00", close: "12:00" },
      ],
    };
    expect(bookingHoursFromCompanyHours(enriched)).toEqual({ startHour: 7, endHour: 18, workingDays: [1, 2, 6] });
  });
  it("the wizard's free-text summary", () => {
    expect(bookingHoursFromCompanyHours({ summary: "Mon–Fri 8am–5pm, Sat 9am–1pm" })).toEqual({ startHour: 8, endHour: 17, workingDays: [1, 2, 3, 4, 5, 6] });
    expect(bookingHoursFromCompanyHours({ summary: "Mon-Fri 7-4" })).toEqual({ startHour: 7, endHour: 16, workingDays: [1, 2, 3, 4, 5] });
  });
  it("anything unclear → null (never a guess)", () => {
    expect(bookingHoursFromCompanyHours({ summary: "by appointment" })).toBeNull();
    expect(bookingHoursFromCompanyHours(null)).toBeNull();
    expect(bookingHoursFromCompanyHours({})).toBeNull();
    expect(bookingHoursFromCompanyHours({ monday: { open: "late", close: "later" } })).toBeNull();
  });
});

// ── Messages (golden) ────────────────────────────────────────────────────────

describe("done-for-you messages (golden)", () => {
  const input = {
    ownerName: "Jane Roofer",
    businessName: "Jane's Roofing",
    forwardUrl: `${APP}/forward/${TOKEN}`,
    phonePath: "missed_call_catcher" as const,
    method: "dial_code" as const,
  };
  it("forwarding text + email", () => {
    expect(renderForwardingSms(input)).toBe(
      `CrankLeads: Hi Jane, Jane's Roofing is almost live. Last step: turn on call forwarding so every call you miss gets a text back in seconds. It's one tap: ${APP}/forward/${TOKEN}\nReply STOP to stop these texts.`,
    );
    expect(renderForwardingSms({ ...input, method: "provider", phonePath: "ai_receptionist" })).toContain("so your AI receptionist picks up the calls you miss. Here's how (2 min):");
    const email = renderForwardingEmail(input);
    expect(email.fromName).toBe("CrankLeads");
    expect(email.body).toMatchSnapshot();
    expect(`${email.body}${email.html}`).not.toMatch(/EmpireVu|stripe/i);
  });
  it("operator escalation", () => {
    const email = renderOperatorEscalationEmail({
      businessName: "Jane's Roofing",
      tier: "close",
      ownerName: "Jane Roofer",
      ownerPhone: "4165550101",
      ownerEmail: "jane@roofco.example",
      organizationId: ORG,
      conciergeUrl: `https://app.house.test/concierge/${ORG}`,
      done: ["Text-back number"],
      left: ["Turn on call forwarding", "Missed-call text-back on"],
      reason: "Not live 24 hours after they bought.",
    });
    expect(email.subject).toBe("Call Jane Roofer (416) 555-0101 to finish setup — Jane's Roofing");
    expect(email.body).toMatchSnapshot();
  });
  it("concierge item in the daily operator health email", () => {
    const item = conciergeItem(
      {
        organizationId: ORG,
        businessName: "Jane's Roofing",
        tier: "catch",
        stripeCustomerId: null,
        reasons: ["forwarding_help", "escalated"],
        since: "2026-10-06T13:00:00Z",
        ownerName: "Jane Roofer",
        ownerPhone: "4165550101",
        ownerEmail: "jane@roofco.example",
        subscriptionStatus: "active",
        conciergeLink: `https://app.house.test/concierge/${ORG}`,
        numberError: null,
        phoneKind: "landline",
        phoneCarrier: "bell",
      },
      { nowMs: at("2026-10-07T13:00:00Z") },
    );
    expect(item).toMatchObject({
      severity: "high",
      problem: "Asked us to set up their call forwarding — Not live 24 hours after purchase — business line: landline, bell.",
      action: "Call Jane Roofer ((416) 555-0101, jane@roofco.example) and finish setup with them in the concierge console.",
      links: [{ label: "Concierge console", url: `https://app.house.test/concierge/${ORG}` }],
    });
  });
});

// ── Progress view (pure) ─────────────────────────────────────────────────────

describe("setup progress view", () => {
  const facts = {
    pricedServices: 0,
    servicesNeedingPrices: 3,
    catcherNumber: CATCHER,
    forwardingVerified: false,
    aiNumber: null,
    receptionistCallReceived: false,
    paymentsConnected: false,
    websiteLeadReceived: false,
    textBackActive: true,
  };
  const checklist = computeSetupChecklist({ organizationId: ORG, companyId: COMPANY, tier: "close", facts, appBaseUrl: APP });
  it("done for them ✓, the one thing left, optional extras", () => {
    const view = buildSetupProgressView({
      checklist,
      intake: { status: "enriched", token: "t" },
      site: { status: "published" },
      progress: { switched_on_at: "2026-10-05T14:00:00Z", number_flagged_at: null },
      numberPretty: "(705) 555-0000",
      forwardUrl: `${APP}/forward/${TOKEN}`,
    });
    expect(view.items.map((i) => [i.key, i.state])).toEqual([
      ["number", "done"],
      ["details", "done"],
      ["automations", "done"],
      ["page", "done"],
    ]);
    expect(view.forwarding).toEqual({ done: false, url: `${APP}/forward/${TOKEN}` });
    expect(view.quickSetupUrl).toBeNull();
    expect(view.extras.map((e) => e.key)).toEqual(["prices", "payments"]);
  });
  it("quick setup unanswered → it's a to-do with its link; no site row → no page item", () => {
    const view = buildSetupProgressView({
      checklist,
      intake: { status: "sent", token: "intake-1" },
      site: null,
      progress: null,
      numberPretty: null,
      forwardUrl: null,
    });
    expect(view.items.find((i) => i.key === "details")?.state).toBe("todo");
    expect(view.quickSetupUrl).toBe(`${APP}/setup/intake-1`);
    expect(view.items.map((i) => i.key)).toEqual(["number", "details", "automations"]);
  });
});
