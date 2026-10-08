/**
 * Done-for-you quick-setup intake (src/server/services/dfy/intake.ts): one intake per company
 * (same token every time), the setup text + email backup, the retry sweep, and the public
 * token page's view/answers — validated, plain-English errors, scoped to the token's company.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAndSendSetupIntake,
  ensureSetupIntake,
  getSetupView,
  isSetupToken,
  MAX_SEND_ATTEMPTS,
  newSetupToken,
  parseIntakeAnswers,
  processPendingIntakeSends,
  resendSetupIntake,
  submitSetupAnswers,
} from "@/server/services/dfy/intake";
import type { DeliverMessageInput, DeliverMessageResult } from "@/server/services/workflow-engine/messaging";
import { isPublicPath } from "@/lib/public-routes";
import { parseDollarsToCents, priceUnitLabel } from "@/lib/setup-intake";

import { createFakeDb, type FakeDb } from "./helpers/fake-supabase";

type Row = Record<string, unknown>;

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const COMPANY = "33333333-3333-4333-8333-333333333333";
const OTHER_COMPANY = "44444444-4444-4444-8444-444444444444";
const ITEM_A = "55555555-5555-4555-8555-555555555555";
const ITEM_B = "66666666-6666-4666-8666-666666666666";
const FOREIGN_ITEM = "77777777-7777-4777-8777-777777777777";
// 2026-10-08 14:00 Toronto (EDT, UTC-4) — inside the daytime retry window.
const NOON_MS = Date.parse("2026-10-08T18:00:00.000Z");

let db: FakeDb;
let admin: never;
let deliver: ReturnType<typeof vi.fn<(input: DeliverMessageInput) => Promise<DeliverMessageResult>>>;

function setup(extra: Record<string, Row[]> = {}) {
  db = createFakeDb(
    {
      organizations: [
        { id: ORG, platform_brand: "crankleads", crankleads_tier: "catch" },
        { id: OTHER_ORG, platform_brand: "crankleads", crankleads_tier: "catch" },
      ],
      companies: [
        {
          id: COMPANY,
          organization_id: ORG,
          name: "Jane's Roofing",
          owner_email: "jane@roofco.example",
          owner_phone_e164: "+17055550101",
          timezone: "America/Toronto",
          business_phone_kind: null,
          business_phone_carrier: null,
        },
        { id: OTHER_COMPANY, organization_id: OTHER_ORG, name: "Other Co", owner_email: "x@y.example", owner_phone_e164: "+14165550000", timezone: null },
      ],
      service_catalog_items: [
        { id: ITEM_A, organization_id: ORG, company_id: COMPANY, label: "Roof inspection", pricing_type: "flat", unit_label: "visit", rate_cents: 0, sort_order: 1 },
        { id: ITEM_B, organization_id: ORG, company_id: COMPANY, label: "Shingle repair", pricing_type: "per_measure", unit_label: "sq ft", rate_cents: 0, sort_order: 2 },
        { id: FOREIGN_ITEM, organization_id: OTHER_ORG, company_id: OTHER_COMPANY, label: "Theirs", pricing_type: "flat", unit_label: null, rate_cents: 5000, sort_order: 1 },
      ],
      setup_intakes: [],
      ...extra,
    },
    { setup_intakes: [["company_id"], ["token"]] },
  );
  admin = db.client;
  deliver = vi.fn(async (input: DeliverMessageInput) => ({ status: "sent" as const, body: input.body, providerRef: "x" }));
}

beforeEach(() => {
  vi.stubEnv("APP_BASE_URL", "https://app.empirevu.test");
  vi.stubEnv("CRANKLEADS_APP_BASE_URL", "https://app.crankleads.test");
  vi.stubEnv("GOOGLE_PLACES_API_KEY", "");
  setup();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const intakes = () => db.tables.setup_intakes;

describe("tokens", () => {
  it("are 32 URL-safe characters (24 random bytes) and unique", () => {
    const a = newSetupToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(new Set(Array.from({ length: 50 }, newSetupToken)).size).toBe(50);
    expect(isSetupToken(a)).toBe(true);
    expect(isSetupToken("short")).toBe(false);
    expect(isSetupToken("a".repeat(31))).toBe(false);
    expect(isSetupToken(`${"a".repeat(31)}/`)).toBe(false);
    expect(isSetupToken(`${"a".repeat(32)}' or 1=1`)).toBe(false);
    expect(isSetupToken(null)).toBe(false);
  });

  it("/setup/:token opens signed out", () => {
    expect(isPublicPath(`/setup/${newSetupToken()}`)).toBe(true);
    expect(isPublicPath("/setup")).toBe(false);
    expect(isPublicPath("/setup/x/admin")).toBe(false);
  });
});

describe("createAndSendSetupIntake", () => {
  it("creates one intake per company, texts the owner from the platform number, emails a backup, marks it sent", async () => {
    const out = await createAndSendSetupIntake(admin, { organizationId: ORG, companyId: COMPANY }, { deliver, now: () => NOON_MS });
    expect(intakes()).toHaveLength(1);
    const intake = intakes()[0];
    const url = `https://app.crankleads.test/setup/${intake.token as string}`;
    expect(out).toEqual({ status: "sent", sms: true, email: true, url });
    expect(intake).toMatchObject({ status: "sent", send_attempts: 1, organization_id: ORG, company_id: COMPANY, last_error: null });
    expect(intake.sent_at).toBeTruthy();

    const sms = deliver.mock.calls.find(([m]) => m.channel === "sms")?.[0];
    expect(sms).toMatchObject({ to: "+17055550101", smsFrom: "platform", companyId: COMPANY, contactId: null, consentContact: null });
    expect(sms?.body).toBe(`CrankLeads: you're in. 60 seconds and we'll set the rest up for you: ${url}`);
    const email = deliver.mock.calls.find(([m]) => m.channel === "email")?.[0];
    expect(email).toMatchObject({ to: "jane@roofco.example", fromName: "CrankLeads", subject: "Your 60-second setup link" });
    expect(email?.body).toContain(url);
    expect(`${sms?.body}${email?.body}${email?.html}`).not.toMatch(/empire\s*vu/i);
  });

  it("is idempotent: same token, no second text", async () => {
    const first = await createAndSendSetupIntake(admin, { organizationId: ORG, companyId: COMPANY }, { deliver, now: () => NOON_MS });
    const second = await createAndSendSetupIntake(admin, { organizationId: ORG, companyId: COMPANY }, { deliver, now: () => NOON_MS });
    expect(second).toEqual({ status: "already_sent", url: first.url });
    expect(intakes()).toHaveLength(1);
    expect(deliver).toHaveBeenCalledTimes(2); // one text + one email, once
    const again = await ensureSetupIntake(admin, { organizationId: ORG, companyId: COMPANY });
    expect(again.url).toBe(first.url);
  });

  it("a lost insert race re-reads the winner's row", async () => {
    await ensureSetupIntake(admin, { organizationId: ORG, companyId: COMPANY });
    const token = intakes()[0].token;
    // Pretend our first read missed it (the other worker inserted in between).
    db.failNext("setup_intakes", "select", { message: "x" });
    await expect(ensureSetupIntake(admin, { organizationId: ORG, companyId: COMPANY })).rejects.toThrow();
    const { intake } = await ensureSetupIntake(admin, { organizationId: ORG, companyId: COMPANY });
    expect(intake.token).toBe(token);
    expect(intakes()).toHaveLength(1);
  });

  it("refuses a company id from another org", async () => {
    await ensureSetupIntake(admin, { organizationId: OTHER_ORG, companyId: OTHER_COMPANY });
    await expect(ensureSetupIntake(admin, { organizationId: ORG, companyId: OTHER_COMPANY })).rejects.toThrow(/another organization/);
  });

  it("a failed text leaves it pending with last_error; emailBackup if_sms_fails sends the email instead", async () => {
    deliver.mockImplementation(async (input) =>
      input.channel === "sms" ? { status: "failed", reason: "Twilio rejected", body: input.body } : { status: "sent", body: input.body },
    );
    const out = await createAndSendSetupIntake(admin, { organizationId: ORG, companyId: COMPANY, emailBackup: "if_sms_fails" }, { deliver, now: () => NOON_MS });
    expect(out.status).toBe("failed");
    expect(intakes()[0]).toMatchObject({ status: "pending", send_attempts: 1 });
    expect(intakes()[0].last_error).toContain("Twilio rejected");
    expect(intakes()[0].email_sent_at).toBeTruthy();
    expect(deliver.mock.calls.map(([m]) => m.channel)).toEqual(["sms", "email"]);
  });

  it("never throws for a delivery that throws", async () => {
    deliver.mockRejectedValue(new Error("network"));
    const out = await createAndSendSetupIntake(admin, { organizationId: ORG, companyId: COMPANY }, { deliver, now: () => NOON_MS });
    expect(out.status).toBe("failed");
  });

  it("bought at night: no text until 08:00 (the welcome email has the link); an email copy only if the welcome email failed", async () => {
    const NIGHT = NOON_MS + 12 * 3_600_000; // midnight Toronto
    const out = await createAndSendSetupIntake(admin, { organizationId: ORG, companyId: COMPANY, emailBackup: "if_sms_fails" }, { deliver, now: () => NIGHT });
    expect(out).toMatchObject({ status: "queued", email: false });
    expect(deliver).not.toHaveBeenCalled();
    expect(intakes()[0]).toMatchObject({ status: "pending", send_attempts: 0 });
    // Welcome email failed → the email copy goes now, still no text.
    intakes()[0].created_at = new Date(NIGHT - 3_600_000).toISOString();
    const backup = await createAndSendSetupIntake(admin, { organizationId: ORG, companyId: COMPANY, emailBackup: "always" }, { deliver, now: () => NIGHT });
    expect(backup).toMatchObject({ status: "queued", email: true });
    expect(deliver.mock.calls.map(([m]) => m.channel)).toEqual(["email"]);
    expect(intakes()[0]).toMatchObject({ status: "pending", last_error: null });
    // Next morning → the retry sweep texts it.
    deliver.mockClear();
    intakes()[0].updated_at = new Date(NIGHT - 3_600_000).toISOString();
    const morning = NOON_MS + 20 * 3_600_000 + 5 * 60_000;
    expect(await processPendingIntakeSends(admin, { nowMs: morning }, { deliver })).toEqual({ attempted: 1, sent: 1 });
    expect(deliver.mock.calls.map(([m]) => m.channel)).toEqual(["sms"]);
  });

  it("operator resend outside hours sends the email only and says so", async () => {
    await ensureSetupIntake(admin, { organizationId: ORG, companyId: COMPANY });
    const out = await resendSetupIntake(admin, { organizationId: ORG, companyId: COMPANY }, { deliver, now: () => NOON_MS + 12 * 3_600_000 });
    expect(out).toMatchObject({ status: "sent", sms: false, email: true, quietHours: true });
    expect(deliver.mock.calls.map(([m]) => m.channel)).toEqual(["email"]);
  });

  it("stopped / exempt purchases get no quick-setup text", async () => {
    db.tables.crankleads_purchases = [{ id: "p1", organization_id: ORG, company_id: COMPANY, created_at: "2026-10-01T00:00:00Z", setup_reminders_stopped_at: "2026-10-02T00:00:00Z" }];
    expect((await createAndSendSetupIntake(admin, { organizationId: ORG, companyId: COMPANY }, { deliver, now: () => NOON_MS })).status).toBe("texts_stopped");
    expect((await resendSetupIntake(admin, { organizationId: ORG, companyId: COMPANY }, { deliver, now: () => NOON_MS })).status).toBe("texts_stopped");
    expect(deliver).not.toHaveBeenCalled();
  });

  it("does not regress an intake the buyer already opened", async () => {
    await ensureSetupIntake(admin, { organizationId: ORG, companyId: COMPANY });
    intakes()[0].status = "opened";
    const out = await createAndSendSetupIntake(admin, { organizationId: ORG, companyId: COMPANY }, { deliver, now: () => NOON_MS });
    expect(out.status).toBe("already_sent");
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe("processPendingIntakeSends (retry sweep)", () => {
  async function failedOnce() {
    deliver.mockImplementationOnce(async (input) => ({ status: "failed", reason: "down", body: input.body }));
    await createAndSendSetupIntake(admin, { organizationId: ORG, companyId: COMPANY, emailBackup: "never" }, { deliver, now: () => NOON_MS - 20 * 60_000 });
    intakes()[0].created_at = new Date(NOON_MS - 30 * 60_000).toISOString();
    deliver.mockClear();
  }

  it("retries a pending intake (text only — the email backup only if the text fails again)", async () => {
    await failedOnce();
    const res = await processPendingIntakeSends(admin, { nowMs: NOON_MS }, { deliver });
    expect(res).toEqual({ attempted: 1, sent: 1 });
    expect(deliver.mock.calls.map(([m]) => m.channel)).toEqual(["sms"]);
    expect(intakes()[0]).toMatchObject({ status: "sent", send_attempts: 2 });
    // Nothing left to do.
    deliver.mockClear();
    expect(await processPendingIntakeSends(admin, { nowMs: NOON_MS + 60 * 60_000 }, { deliver })).toEqual({ attempted: 0, sent: 0 });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("waits 10 minutes between tries, stays quiet at night, and gives up after a few tries", async () => {
    await failedOnce();
    // Too soon after the last try.
    expect((await processPendingIntakeSends(admin, { nowMs: NOON_MS - 15 * 60_000 }, { deliver })).attempted).toBe(0);
    // 23:30 Toronto.
    const night = Date.parse("2026-10-09T03:30:00.000Z");
    intakes()[0].created_at = new Date(night - 60 * 60_000).toISOString();
    expect((await processPendingIntakeSends(admin, { nowMs: night }, { deliver })).attempted).toBe(0);
    // Keep failing until the cap.
    intakes()[0].created_at = new Date(NOON_MS - 30 * 60_000).toISOString();
    deliver.mockImplementation(async (input) =>
      input.channel === "sms" ? { status: "failed", reason: "down", body: input.body } : { status: "sent", body: input.body },
    );
    for (let i = 0; i < 5; i++) {
      await processPendingIntakeSends(admin, { nowMs: NOON_MS + i * 20 * 60_000 }, { deliver });
    }
    expect(intakes()[0].send_attempts).toBe(MAX_SEND_ATTEMPTS);
    expect(intakes()[0].status).toBe("pending");
    // The email backup went once, not on every try.
    expect(deliver.mock.calls.filter(([m]) => m.channel === "email")).toHaveLength(1);
  });

  it("two workers can't both send the same try (claim on send_attempts)", async () => {
    await failedOnce();
    const snapshot = { ...intakes()[0] };
    const first = processPendingIntakeSends(admin, { nowMs: NOON_MS }, { deliver });
    // The second worker read the same row before the first claimed it.
    intakes()[0].send_attempts = snapshot.send_attempts; // unchanged until claim
    const second = processPendingIntakeSends(admin, { nowMs: NOON_MS }, { deliver });
    const results = await Promise.all([first, second]);
    expect(results.reduce((n, r) => n + r.attempted, 0)).toBe(1);
    expect(deliver.mock.calls.filter(([m]) => m.channel === "sms")).toHaveLength(1);
  });
});

describe("public page: view + answers", () => {
  let token: string;
  beforeEach(async () => {
    token = (await ensureSetupIntake(admin, { organizationId: ORG, companyId: COMPANY })).intake.token;
  });

  const goodAnswers = () => ({
    listing: { kind: "website", url: "janesroofing.ca" },
    phone: { number: "(705) 555-0199", kind: "cell", carrier: "rogers" },
    prices: { skipped: false, items: [{ id: ITEM_A, label: "Roof inspection", priceCents: 15000 }, { label: "Gutter guards", priceCents: 9900, unit: "ft" }] },
  });

  it("an unknown or malformed token gets nothing", async () => {
    expect(await getSetupView(admin, "nope")).toBeNull();
    expect(await getSetupView(admin, newSetupToken())).toBeNull();
    expect(await submitSetupAnswers(admin, newSetupToken(), goodAnswers())).toBeNull();
  });

  it("returns ONLY this company's services and phone, branded; marks opened once", async () => {
    const view = await getSetupView(admin, token, NOON_MS);
    expect(view).toMatchObject({
      brand: "crankleads",
      businessName: "Jane's Roofing",
      state: "open",
      placesEnabled: false,
      phone: { number: "(705) 555-0101", kind: null, carrier: null },
      answers: null,
    });
    expect(view?.services).toEqual([
      { id: ITEM_A, label: "Roof inspection", unitLabel: "per visit", priceCents: null },
      { id: ITEM_B, label: "Shingle repair", unitLabel: "per sq ft", priceCents: null },
    ]);
    expect(JSON.stringify(view)).not.toContain(ORG);
    expect(JSON.stringify(view)).not.toContain(FOREIGN_ITEM);
    expect(intakes()[0]).toMatchObject({ status: "opened", opened_at: new Date(NOON_MS).toISOString() });
    // Every catalog read is scoped to the token's org + company.
    const catalogReads = db.queries.filter((q) => q.table === "service_catalog_items");
    expect(catalogReads.every((q) => q.filters.some((f) => f.column === "organization_id" && f.value === ORG) && q.filters.some((f) => f.column === "company_id" && f.value === COMPANY))).toBe(true);
    await getSetupView(admin, token, NOON_MS + 1000);
    expect(intakes()[0].opened_at).toBe(new Date(NOON_MS).toISOString());
  });

  it("saves normalized answers and queues enrichment; re-opening shows the summary; re-submitting re-queues", async () => {
    const view = await submitSetupAnswers(admin, token, goodAnswers(), NOON_MS);
    expect(view?.state).toBe("submitted");
    const intake = intakes()[0];
    expect(intake).toMatchObject({ status: "submitted", enrich_attempts: 0, submitted_at: new Date(NOON_MS).toISOString() });
    expect(intake.answers).toEqual({
      listing: { kind: "website", url: "https://janesroofing.ca/" },
      phone: { number: "+17055550199", kind: "cell", carrier: "rogers" },
      prices: {
        skipped: false,
        items: [
          { id: ITEM_A, label: "Roof inspection", priceCents: 15000 },
          { label: "Gutter guards", priceCents: 9900, unit: "ft" },
        ],
      },
    });
    const reopened = await getSetupView(admin, token);
    expect(reopened?.state).toBe("submitted");
    expect(reopened?.phone).toEqual({ number: "(705) 555-0199", kind: "cell", carrier: "rogers" });
    expect(reopened?.services.find((s) => s.id === ITEM_A)?.priceCents).toBe(15000);

    intake.status = "enriched";
    intake.enrich_attempts = 1;
    await submitSetupAnswers(admin, token, { ...goodAnswers(), prices: { skipped: true, items: [{ id: ITEM_A, label: "x", priceCents: 1 }] } });
    expect(intakes()[0]).toMatchObject({ status: "submitted", enrich_attempts: 0 });
    expect((intakes()[0].answers as { prices: unknown }).prices).toEqual({ skipped: true, items: [] });
  });

  it("refuses a service id from another company (token scoping)", async () => {
    const answers = goodAnswers();
    answers.prices.items = [{ id: FOREIGN_ITEM, label: "Theirs", priceCents: 100 }];
    await expect(submitSetupAnswers(admin, token, answers)).rejects.toThrow("One of the services changed — reload the page and try again.");
    expect(intakes()[0].status).not.toBe("submitted");
  });
});

describe("answer validation (plain English)", () => {
  const base = {
    listing: { kind: "none" },
    phone: { number: "705-555-0123", kind: "landline", carrier: "bell" },
    prices: { skipped: true, items: [] },
  };
  const fails = (patch: Record<string, unknown>) => {
    try {
      parseIntakeAnswers({ ...base, ...patch });
    } catch (err) {
      return (err as Error).message;
    }
    return null;
  };

  it("accepts the three listing kinds", () => {
    expect(parseIntakeAnswers(base).listing).toEqual({ kind: "none" });
    expect(parseIntakeAnswers({ ...base, listing: { kind: "google", placeId: "ChIJN1t_tDeuEmsRUsoyG83frY4", name: "Jane's Roofing", address: "1 Main St" } }).listing).toMatchObject({ kind: "google" });
    expect(parseIntakeAnswers({ ...base, listing: { kind: "website", url: "https://www.janes.ca/home" } }).listing).toEqual({ kind: "website", url: "https://www.janes.ca/home" });
  });

  it("rejects with sentences a contractor understands", () => {
    expect(fails({ listing: { kind: "website", url: "not a site" } })).toMatch(/website address doesn't look right/);
    expect(fails({ listing: { kind: "website", url: "http://localhost:3000" } })).toMatch(/website address doesn't look right/);
    expect(fails({ listing: { kind: "website", url: "http://10.0.0.5/" } })).toMatch(/website address doesn't look right/);
    expect(fails({ listing: { kind: "google", placeId: "../../x", name: "a" } })).toBe("Pick your business from the list again.");
    expect(fails({ phone: { number: "555", kind: "cell", carrier: "bell" } })).toMatch(/with the area code/);
    expect(fails({ phone: { number: "705-555-0123", kind: "fax", carrier: "bell" } })).toMatch(/cell, landline or internet phone/);
    expect(fails({ phone: { number: "705-555-0123", kind: "cell", carrier: "att" } })).toMatch(/phone company/);
    expect(fails({ prices: { skipped: false, items: [{ label: "x", priceCents: 0 }] } })).toMatch(/more than \$0/);
    expect(fails({ prices: { skipped: false, items: [{ label: "x", priceCents: 12.5 }] } })).toMatch(/numbers/i);
    expect(fails({ prices: { skipped: false, items: [{ label: "", priceCents: 100 }] } })).toBe("Give each service you add a name.");
    expect(fails({ listing: undefined })).toBe("Something in the form didn't look right — check it and try again.");
  });

  it("dollar parsing + unit labels", () => {
    expect(parseDollarsToCents("$1,250")).toBe(125000);
    expect(parseDollarsToCents("89.5")).toBe(8950);
    expect(parseDollarsToCents("")).toBeNull();
    expect(parseDollarsToCents("abc")).toBeNaN();
    expect(priceUnitLabel("flat", null)).toBe("flat price");
    expect(priceUnitLabel("per_unit", "hour")).toBe("per hour");
  });
});
