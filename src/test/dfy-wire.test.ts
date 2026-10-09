/**
 * Done-for-you seams (docs/done-for-you.md → "What the buyer experiences"): the messages a
 * buyer gets across the four parts — quick setup → switch-on (+ page built inline) →
 * forwarding text → ONE "You're live" (page link folded in) — or the page text once, later,
 * when the page publishes after go-live. Reminders stay quiet right after a setup text.
 * One site-URL helper everywhere. The DB is the in-memory PostgREST fake; Twilio etc. are fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "./helpers/fake-supabase";
import { processSetupFollowups, reminderQuietReason, REMINDER_QUIET_AFTER_TEXT_MS } from "@/server/services/crankleads/setup-followups";
import { renderLiveSms } from "@/server/services/crankleads/followup-messages";
import { forwardPageUrl } from "@/server/services/dfy/links";
import { advanceDoneForYou, type DoneForYouDeps } from "@/server/services/dfy/orchestrator";
import { buildSetupProgressView } from "@/server/services/dfy/progress-view";
import { notifyPublishedSites, PAGE_TEXT_HOLD_MS, pendingSiteCompanyIds } from "@/server/services/dfy/site-generator";
import { siteUrl } from "@/server/services/dfy/site-url";
import { computeSetupChecklist } from "@/server/services/crankleads/setup-checklist";
import type { DeliverMessageInput } from "@/server/services/workflow-engine/messaging";

type Row = Record<string, unknown>;

const ORG = "org-1";
const COMPANY = "company-1";
const APP = "https://app.crankleads.test";
const PAGES = "https://pages.crankleads.test";
const CATCHER = "+17055550000";
const at = (iso: string) => Date.parse(iso);

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
        created_at: "2026-10-05T12:59:00Z",
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
    setup_intakes: [
      {
        organization_id: ORG,
        company_id: COMPANY,
        token: "it",
        status: "enriched",
        created_at: "2026-10-05T13:00:00Z",
        sms_sent_at: "2026-10-05T13:00:05Z",
        sent_at: "2026-10-05T13:00:05Z",
        enriched_at: "2026-10-05T13:10:00Z",
      },
    ],
    voice_numbers: [
      {
        id: "vn-1",
        organization_id: ORG,
        company_id: COMPANY,
        provider: "twilio",
        mode: "missed_call_catcher",
        phone_e164: CATCHER,
        active: true,
        forwarding_verified_at: null,
      },
    ],
    workflows: [{ id: "wf", organization_id: ORG, company_id: COMPANY, slug: "missed-call-text-back", status: "active" }],
    dfy_progress: [],
    company_sites: [],
    crankleads_setup_followups: [],
    ...overrides,
  };
}

let db: FakeDb;
let delivered: DeliverMessageInput[];

const deliver = async (input: DeliverMessageInput) => {
  delivered.push(input);
  return { status: "sent" as const, body: input.body };
};

/** A stand-in for the site builder: inserts a published page (what generateSite({publish}) does). */
function publishPage(nowIso: string) {
  db.tables.company_sites.push({
    id: "site-1",
    organization_id: ORG,
    company_id: COMPANY,
    slug: "janes-roofing",
    status: "published",
    mode: "full",
    generated_at: nowIso,
    published_at: nowIso,
    owner_notified_at: null,
  });
}

function orchestratorDeps(nowIso: string, opts: { buildPage: boolean }): Partial<DoneForYouDeps> {
  return {
    now: () => at(nowIso),
    deliver,
    sendEmail: async () => ({ id: "op" }),
    ensureNumber: async () => ({ status: "ready", phoneNumber: CATCHER, purchasedNow: false }),
    switchOn: async () => ({
      automations: { activated: ["missed-call-text-back"], alreadyActive: [], keptDraft: [] },
      reviews: "no_review_url" as const,
      booking: "no_hours" as const,
      receptionist: "not_front_desk" as const,
    }),
    startTest: vi.fn(async () => ({})) as never,
    generateSite: async () => {
      if (!opts.buildPage) throw new Error("model down");
      publishPage(nowIso);
    },
  };
}

const siteDeps = (nowIso: string) => ({ deliver, now: () => new Date(nowIso), writeCopy: null });
const followupDeps = { deliver, sendEmail: async () => ({ id: "op" }) };

const live = () => delivered.filter((m) => /You're live/.test(`${m.subject ?? ""} ${m.body}`));
const pageTexts = () => delivered.filter((m) => /Your new page is live/.test(`${m.subject ?? ""} ${m.body}`));
const forwarding = () => delivered.filter((m) => /call forwarding/.test(`${m.subject ?? ""} ${m.body}`));

function verifyForwarding(iso: string) {
  db.tables.voice_numbers[0].forwarding_verified_at = iso;
}

beforeEach(() => {
  vi.stubEnv("APP_BASE_URL", "https://app.house.test");
  vi.stubEnv("CRANKLEADS_APP_BASE_URL", APP);
  vi.stubEnv("PAGES_BASE_URL", PAGES);
  vi.stubEnv("OWNER_EMAIL", "ops@crankleads.test");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  delivered = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("buyer message sequence", () => {
  it("page published before go-live → folded into ONE 'You're live' (text + email); no separate page text, ever", async () => {
    db = createFakeDb(tables(), { crankleads_setup_followups: [["purchase_id", "stage"]] });

    // Mon 10:00 — intake enriched: switch on, page built inline, THEN the forwarding text.
    const t1 = "2026-10-05T14:00:00Z";
    const first = await advanceDoneForYou(db.client, COMPANY, orchestratorDeps(t1, { buildPage: true }));
    expect(first.steps).toEqual(["number_ready", "switched_on", "site_built", "forwarding_text_sent"]);
    expect(forwarding().map((m) => m.channel)).toEqual(["sms", "email"]);

    // The sites sweep holds the page text (it will ride along with "You're live").
    expect(await notifyPublishedSites(db.client, { deps: siteDeps(t1) })).toEqual([]);
    expect(db.tables.company_sites[0].owner_notified_at).toBeNull();
    // No reminder on top of the setup texts.
    expect((await processSetupFollowups(db.client, at(t1), followupDeps)).map((o) => o.reason)).toEqual(["just_purchased"]);

    // 10:20 — forwarding verified (test passed). The next orchestrator tick goes live right away.
    verifyForwarding("2026-10-05T14:19:00Z");
    const t2 = "2026-10-05T14:20:00Z";
    const second = await advanceDoneForYou(db.client, COMPANY, orchestratorDeps(t2, { buildPage: true }));
    expect(second.steps).toContain("live");
    expect(db.tables.crankleads_purchases[0].live_at).toBe("2026-10-05T14:20:00.000Z");
    expect(live().map((m) => m.channel).sort()).toEqual(["email", "sms"]);
    const liveSms = live().find((m) => m.channel === "sms")!;
    expect(liveSms.body).toContain(`Your new page: ${PAGES}/janes-roofing`);
    expect(liveSms).toMatchObject({ smsFrom: "platform", to: "+14165550101" });
    expect(live().find((m) => m.channel === "email")!.body).toContain(`Your new page is live: ${PAGES}/janes-roofing`);
    expect(db.tables.company_sites[0].owner_notified_at).toBe("2026-10-05T14:20:00.000Z");

    // Every later pass, every part: nothing new.
    const t3 = "2026-10-05T14:30:00Z";
    expect(await notifyPublishedSites(db.client, { deps: siteDeps(t3) })).toEqual([]);
    await processSetupFollowups(db.client, at(t3), followupDeps);
    expect(await advanceDoneForYou(db.client, COMPANY, orchestratorDeps(t3, { buildPage: true }))).toMatchObject({ skipped: "live" });
    await processSetupFollowups(db.client, at("2026-10-06T14:00:00Z"), followupDeps);

    expect(live()).toHaveLength(2); // one text + one email
    expect(pageTexts().filter((m) => m.channel === "sms")).toHaveLength(0);
    expect(forwarding()).toHaveLength(2);
    expect(delivered).toHaveLength(4);
  });

  it("page published AFTER go-live → 'You're live' without a page link, then the page text ONCE", async () => {
    db = createFakeDb(tables(), { crankleads_setup_followups: [["purchase_id", "stage"]] });
    const t1 = "2026-10-05T14:00:00Z";
    expect((await advanceDoneForYou(db.client, COMPANY, orchestratorDeps(t1, { buildPage: false }))).steps).not.toContain("site_built");
    verifyForwarding("2026-10-05T14:19:00Z");
    await advanceDoneForYou(db.client, COMPANY, orchestratorDeps("2026-10-05T14:20:00Z", { buildPage: false }));
    expect(live()).toHaveLength(2);
    expect(live().every((m) => !m.body.includes("/janes-roofing"))).toBe(true);

    // The sites sweep (backstop) publishes it later; its text goes once.
    publishPage("2026-10-05T14:25:00Z");
    const sent = await notifyPublishedSites(db.client, { deps: siteDeps("2026-10-05T14:25:00Z") });
    expect(sent).toEqual([{ companyId: COMPANY, channel: "sms", status: "sent" }]);
    expect(await notifyPublishedSites(db.client, { deps: siteDeps("2026-10-05T14:30:00Z") })).toEqual([]);
    expect(pageTexts()).toHaveLength(1);
    expect(pageTexts()[0].body).toContain(`${PAGES}/janes-roofing`);
    expect(live()).toHaveLength(2);
  });

  it("live claimed overnight: the page text keeps waiting for the morning 'You're live' (no race at 08:00)", async () => {
    db = createFakeDb(tables(), { crankleads_setup_followups: [["purchase_id", "stage"]] });
    await advanceDoneForYou(db.client, COMPANY, orchestratorDeps("2026-10-05T14:00:00Z", { buildPage: true }));
    verifyForwarding("2026-10-06T02:00:00Z");
    // 22:30 Toronto: live_at is stamped, the message waits for 08:00.
    await advanceDoneForYou(db.client, COMPANY, orchestratorDeps("2026-10-06T02:30:00Z", { buildPage: true }));
    expect(db.tables.crankleads_purchases[0].live_at).toBeTruthy();
    expect(live()).toHaveLength(0);
    // 08:00: the sites sweep runs before the follow-up pass — it still holds.
    expect(await notifyPublishedSites(db.client, { deps: siteDeps("2026-10-06T12:00:00Z") })).toEqual([]);
    await processSetupFollowups(db.client, at("2026-10-06T12:01:00Z"), followupDeps);
    expect(live()).toHaveLength(2);
    expect(live().find((m) => m.channel === "sms")!.body).toContain(`${PAGES}/janes-roofing`);
    expect(await notifyPublishedSites(db.client, { deps: siteDeps("2026-10-06T12:05:00Z") })).toEqual([]);
    expect(pageTexts().filter((m) => m.channel === "sms")).toHaveLength(0);
  });

  it("the page text goes on its own for buyers who won't get a 'You're live' (stopped reminders, or stuck for days)", async () => {
    db = createFakeDb(tables(), { crankleads_setup_followups: [["purchase_id", "stage"]] });
    publishPage("2026-10-05T14:00:00Z");
    db.tables.crankleads_purchases[0].setup_reminders_stopped_at = "2026-10-05T13:30:00Z";
    expect(await notifyPublishedSites(db.client, { deps: siteDeps("2026-10-05T14:00:00Z") })).toHaveLength(1);

    db = createFakeDb(tables(), { crankleads_setup_followups: [["purchase_id", "stage"]] });
    publishPage("2026-10-05T14:00:00Z");
    expect(await notifyPublishedSites(db.client, { deps: siteDeps("2026-10-07T14:00:00Z") })).toEqual([]);
    const later = new Date(at("2026-10-05T13:00:00Z") + PAGE_TEXT_HOLD_MS + 3_600_000).toISOString();
    expect(await notifyPublishedSites(db.client, { deps: siteDeps(later) })).toHaveLength(1);
  });

  it("the 2h 'no answer' fallback switches on AND builds the page from whatever we have; a late enrichment rebuilds it once", async () => {
    db = createFakeDb(
      tables({ setup_intakes: [{ organization_id: ORG, company_id: COMPANY, token: "it", status: "sent", created_at: "2026-10-05T13:00:00Z", enriched_at: null }] }),
    );
    const generate = vi.fn(async (_a: unknown, _c: string, opts: { publish?: boolean }) => {
      if (opts.publish) publishPage("2026-10-05T15:01:00Z");
      else db.tables.company_sites[0].generated_at = "2026-10-05T16:00:00Z";
    });
    const deps = (iso: string) => ({ ...orchestratorDeps(iso, { buildPage: true }), generateSite: generate as never });
    const out = await advanceDoneForYou(db.client, COMPANY, deps("2026-10-05T15:01:00Z"));
    expect(out.steps).toEqual(expect.arrayContaining(["switched_on", "site_built"]));
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][2]).toEqual({ publish: true });

    // Quick setup answered + enriched later → one rebuild (keeps status — no publish flag).
    Object.assign(db.tables.setup_intakes[0], { status: "enriched", enriched_at: "2026-10-05T15:30:00Z" });
    expect((await advanceDoneForYou(db.client, COMPANY, deps("2026-10-05T16:00:00Z"))).steps).toContain("site_built");
    expect(generate.mock.calls[1][2]).toEqual({});
    expect((await advanceDoneForYou(db.client, COMPANY, deps("2026-10-05T16:05:00Z"))).steps).not.toContain("site_built");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("the sites sweep is the backstop for switched-on companies whose inline build failed", async () => {
    db = createFakeDb(
      tables({
        setup_intakes: [{ organization_id: ORG, company_id: COMPANY, token: "it", status: "sent", created_at: "2026-10-05T13:00:00Z" }],
        dfy_progress: [{ organization_id: ORG, company_id: COMPANY, switched_on_at: "2026-10-05T15:01:00Z" }],
      }),
    );
    expect(await pendingSiteCompanyIds(db.client)).toEqual([COMPANY]);
    publishPage("2026-10-05T15:05:00Z");
    expect(await pendingSiteCompanyIds(db.client)).toEqual([]);
  });
});

describe("reminders don't land on top of a setup text", () => {
  const P = at("2026-10-05T13:00:00Z");
  it("quiet for 3h after purchase and after the latest quick-setup / forwarding text", () => {
    expect(REMINDER_QUIET_AFTER_TEXT_MS).toBe(3 * 3_600_000);
    expect(reminderQuietReason(P, null, P + 2 * 3_600_000)).toBe("just_purchased");
    expect(reminderQuietReason(P, null, P + 3 * 3_600_000)).toBeNull();
    expect(reminderQuietReason(P, "2026-10-06T12:30:00Z", at("2026-10-06T13:00:00Z"))).toBe("recent_setup_text");
    expect(reminderQuietReason(P, "2026-10-06T09:00:00Z", at("2026-10-06T13:00:00Z"))).toBeNull();
  });

  it("an operator re-send of the quick-setup link at 09:15 holds the 09:30 day-1 reminder", async () => {
    db = createFakeDb(
      tables({
        setup_intakes: [
          { organization_id: ORG, company_id: COMPANY, token: "it", status: "sent", created_at: "2026-10-05T13:00:00Z", sms_sent_at: "2026-10-06T13:15:00Z", sent_at: "2026-10-05T13:00:05Z" },
        ],
      }),
      { crankleads_setup_followups: [["purchase_id", "stage"]] },
    );
    const out = await processSetupFollowups(db.client, at("2026-10-06T13:30:00Z"), followupDeps);
    expect(out.map((o) => o.reason)).toEqual(["recent_setup_text"]);
    expect(delivered).toHaveLength(0);
    const later = await processSetupFollowups(db.client, at("2026-10-06T16:30:00Z"), followupDeps);
    expect(later.map((o) => o.action)).toEqual(["reminder_sent"]);
    expect(delivered.find((m) => m.channel === "sms")!.body).toContain(`${APP}/setup/it`);
  });

  it("reminders stop once live", async () => {
    db = createFakeDb(tables({ crankleads_purchases: [{ ...tables().crankleads_purchases[0], live_at: "2026-10-05T15:00:00Z" }] }), {
      crankleads_setup_followups: [["purchase_id", "stage"]],
    });
    db.tables.crankleads_setup_followups.push({ organization_id: ORG, purchase_id: "purchase-1", stage: "live", local_date: "2026-10-05" });
    await processSetupFollowups(db.client, at("2026-10-08T14:00:00Z"), followupDeps);
    expect(delivered).toHaveLength(0);
  });
});

describe("one site URL", () => {
  it("siteUrl is the only builder: pages host when PAGES_BASE_URL is set, else <CrankLeads app>/s/<slug>", () => {
    expect(siteUrl("janes-roofing", "crankleads")).toBe(`${PAGES}/janes-roofing`);
    vi.stubEnv("PAGES_BASE_URL", "");
    expect(siteUrl("janes-roofing", "crankleads")).toBe(`${APP}/s/janes-roofing`);
  });

  it("the in-app progress view links the published page with the same URL", () => {
    const checklist = computeSetupChecklist({
      organizationId: ORG,
      companyId: COMPANY,
      tier: "catch",
      appBaseUrl: APP,
      facts: {
        pricedServices: 0,
        servicesNeedingPrices: 0,
        catcherNumber: CATCHER,
        forwardingVerified: false,
        aiNumber: null,
        receptionistCallReceived: false,
        paymentsConnected: false,
        websiteLeadReceived: false,
        textBackActive: true,
      },
    });
    const view = buildSetupProgressView({
      checklist,
      intake: { status: "enriched", token: "it" },
      site: { status: "published", slug: "janes-roofing" },
      progress: { switched_on_at: "2026-10-05T14:00:00Z", number_flagged_at: null },
      numberPretty: "(705) 555-0000",
      forwardUrl: forwardPageUrl("x".repeat(32)),
    });
    expect(view.items.find((i) => i.key === "page")?.detail).toBe(`${PAGES}/janes-roofing`);
  });

  it("the 'You're live' text carries the URL it is given (from siteUrl), never a second scheme", () => {
    const sms = renderLiveSms({
      ownerName: "Jane",
      businessName: "Jane's Roofing",
      phonePath: "missed_call_catcher",
      appUrl: APP,
      number: CATCHER,
      siteUrl: siteUrl("janes-roofing", "crankleads"),
      setPasswordUrl: null,
    });
    expect(sms).toContain(`${PAGES}/janes-roofing`);
    expect(sms).not.toContain("/s/janes-roofing");
  });
});
