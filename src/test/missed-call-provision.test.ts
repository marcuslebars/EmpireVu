import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, fakeTenantContext, type FakeDb } from "./fake-supabase";

const installRecipes = vi.fn((..._a: unknown[]) => Promise.resolve({ installed: [], skipped: [] }));
vi.mock("@/server/services/workflow-engine/recipes/install", () => ({
  installRecipes: (...a: unknown[]) => installRecipes(...a),
}));

import type { TenantServiceContext } from "@/server/services/shared";
import {
  catcherFriendlyName,
  getMissedCallCatcherStatus,
  provisionMissedCallCatcher,
  type TwilioIncomingNumber,
  type TwilioNumbersClient,
} from "@/server/services/twilio/provision";

const ORG = "org-1";
const COMPANY = "co-1";
const BASE = "https://app.crankleads.test";
const VOICE_URL = `${BASE}/api/twilio/voice/inbound`;
const SMS_URL = `${BASE}/api/twilio/sms/inbound`;
const env = { ...process.env };
afterAll(() => {
  process.env = env;
});

/** A mocked Twilio account: an inventory of available numbers + the account's numbers. */
function mockTwilio(initial: TwilioIncomingNumber[] = []) {
  const account: TwilioIncomingNumber[] = initial.map((n) => ({ ...n }));
  let counter = 0;
  const client = {
    searchAvailableLocal: vi.fn((_country: string, areaCode: number | null) =>
      Promise.resolve(areaCode === 999 ? [] : [{ phone_number: `+1${areaCode ?? 705}5550${100 + counter}` }]),
    ),
    listIncoming: vi.fn((filter: { phoneNumber?: string; friendlyName?: string }) =>
      Promise.resolve(
        account.filter(
          (n) =>
            (!filter.phoneNumber || n.phone_number === filter.phoneNumber) &&
            (!filter.friendlyName || n.friendly_name === filter.friendlyName),
        ),
      ),
    ),
    purchase: vi.fn((input: { phoneNumber: string; friendlyName: string; voiceUrl: string; smsUrl: string }) => {
      counter += 1;
      const bought = { sid: `PN${counter}`, phone_number: input.phoneNumber, friendly_name: input.friendlyName, voice_url: input.voiceUrl, sms_url: input.smsUrl };
      account.push(bought);
      return Promise.resolve(bought);
    }),
    updateWebhooks: vi.fn((sid: string, input: { voiceUrl: string; smsUrl: string; friendlyName: string }) => {
      const n = account.find((x) => x.sid === sid)!;
      n.voice_url = input.voiceUrl;
      n.sms_url = input.smsUrl;
      n.friendly_name = input.friendlyName;
      return Promise.resolve({ ...n });
    }),
  } satisfies TwilioNumbersClient;
  return { client, account };
}

let db: FakeDb;
/** Cross-org owner lookup over the WHOLE fake table (what the service-role lookup sees). */
const lookupOwner = (phone: string) =>
  Promise.resolve(
    (db.tables.voice_numbers.find((r) => r.phone_e164 === phone) as
      | { organization_id: string; company_id: string; provider: string; mode: string; active: boolean }
      | undefined) ?? null,
  );
const deps = (client: TwilioNumbersClient) => ({ client, lookupOwner });
const ctx = (): TenantServiceContext => fakeTenantContext(db, ORG, "user-1");

beforeEach(() => {
  process.env.APP_BASE_URL = BASE;
  process.env.TWILIO_ACCOUNT_SID = "AC123";
  process.env.TWILIO_AUTH_TOKEN = "token";
  delete process.env.TWILIO_WEBHOOK_BASE_URL;
  delete process.env.TWILIO_NUMBER_COUNTRY;
  installRecipes.mockClear();
  db = createFakeDb({
    companies: [{ id: COMPANY, organization_id: ORG, name: "Muskoka Plumbing" }],
    voice_numbers: [],
  });
});

describe("provisionMissedCallCatcher", () => {
  it("buys a number in the requested area code with voice + SMS webhooks, and stores it for the company", async () => {
    const { client } = mockTwilio();
    const result = await provisionMissedCallCatcher(ctx(), { companyId: COMPANY, areaCode: 705 }, deps(client));

    expect(client.searchAvailableLocal).toHaveBeenCalledWith("CA", 705);
    expect(client.purchase).toHaveBeenCalledWith({
      phoneNumber: "+17055550100",
      friendlyName: catcherFriendlyName(COMPANY),
      voiceUrl: VOICE_URL,
      smsUrl: SMS_URL,
    });
    expect(result).toMatchObject({ phoneNumber: "+17055550100", phoneNumberPretty: "(705) 555-0100", purchased: true, numberSid: "PN1" });
    expect(result.instructions.recommended.activate).toBe("**004*+17055550100#");

    expect(db.tables.voice_numbers).toHaveLength(1);
    expect(db.tables.voice_numbers[0]).toMatchObject({
      organization_id: ORG,
      company_id: COMPANY,
      phone_e164: "+17055550100",
      provider: "twilio",
      mode: "missed_call_catcher",
      provider_number_sid: "PN1",
      active: true,
    });
    expect(installRecipes).toHaveBeenCalledWith(expect.anything(), COMPANY, { only: ["missed-call-text-back"] });
  });

  it("is idempotent: a second run buys nothing and changes nothing", async () => {
    const { client } = mockTwilio();
    await provisionMissedCallCatcher(ctx(), { companyId: COMPANY, areaCode: 705 }, deps(client));
    const again = await provisionMissedCallCatcher(ctx(), { companyId: COMPANY, areaCode: 705 }, deps(client));

    expect(client.purchase).toHaveBeenCalledTimes(1);
    expect(client.updateWebhooks).not.toHaveBeenCalled();
    expect(again).toMatchObject({ phoneNumber: "+17055550100", purchased: false, webhooksUpdated: false });
    expect(db.tables.voice_numbers).toHaveLength(1);
  });

  it("recovers a number bought on a run whose DB write failed (FriendlyName tag) instead of buying again", async () => {
    const { client } = mockTwilio();
    db.failNext("voice_numbers", { message: "db down" }, "insert");
    await expect(provisionMissedCallCatcher(ctx(), { companyId: COMPANY, areaCode: 705 }, deps(client))).rejects.toThrow("db down");
    expect(client.purchase).toHaveBeenCalledTimes(1);

    const retry = await provisionMissedCallCatcher(ctx(), { companyId: COMPANY, areaCode: 705 }, deps(client));
    expect(client.purchase).toHaveBeenCalledTimes(1);
    expect(retry).toMatchObject({ phoneNumber: "+17055550100", purchased: false });
    expect(db.tables.voice_numbers).toHaveLength(1);
  });

  it("re-points the webhooks when someone changed them in the Twilio console", async () => {
    const { client, account } = mockTwilio();
    await provisionMissedCallCatcher(ctx(), { companyId: COMPANY, areaCode: 705 }, deps(client));
    account[0].voice_url = "https://handler.twilio.com/twiml/EHxxx";

    const result = await provisionMissedCallCatcher(ctx(), { companyId: COMPANY }, deps(client));
    expect(client.updateWebhooks).toHaveBeenCalledWith("PN1", { voiceUrl: VOICE_URL, smsUrl: SMS_URL, friendlyName: catcherFriendlyName(COMPANY) });
    expect(result.webhooksUpdated).toBe(true);
    expect(account[0].voice_url).toBe(VOICE_URL);
  });

  it("attaches an existing account number (configures it, no purchase)", async () => {
    const { client } = mockTwilio([{ sid: "PN9", phone_number: "+12495550111", voice_url: null, sms_url: null }]);
    const result = await provisionMissedCallCatcher(ctx(), { companyId: COMPANY, attachNumber: "(249) 555-0111" }, deps(client));

    expect(client.purchase).not.toHaveBeenCalled();
    expect(client.updateWebhooks).toHaveBeenCalledWith("PN9", { voiceUrl: VOICE_URL, smsUrl: SMS_URL, friendlyName: catcherFriendlyName(COMPANY) });
    expect(result).toMatchObject({ phoneNumber: "+12495550111", purchased: false });
    expect(db.tables.voice_numbers[0]).toMatchObject({ phone_e164: "+12495550111", provider_number_sid: "PN9", mode: "missed_call_catcher" });
  });

  it("switching numbers retires the old catcher row", async () => {
    const { client } = mockTwilio([{ sid: "PN9", phone_number: "+12495550111", voice_url: "https://demo.twilio.com/welcome/voice/", sms_url: "" }]);
    await provisionMissedCallCatcher(ctx(), { companyId: COMPANY, areaCode: 705 }, deps(client));
    await provisionMissedCallCatcher(ctx(), { companyId: COMPANY, attachNumber: "+12495550111" }, deps(client));

    const rows = db.tables.voice_numbers;
    expect(rows.find((r) => r.phone_e164 === "+17055550100")?.active).toBe(false);
    expect(rows.find((r) => r.phone_e164 === "+12495550111")?.active).toBe(true);
  });

  it("rejects attaching a number that isn't in the account, and an empty area code inventory", async () => {
    const { client } = mockTwilio();
    await expect(provisionMissedCallCatcher(ctx(), { companyId: COMPANY, attachNumber: "+12495550000" }, deps(client))).rejects.toThrow(
      /isn't in the Twilio account/,
    );
    await expect(provisionMissedCallCatcher(ctx(), { companyId: COMPANY, areaCode: 999 }, deps(client))).rejects.toThrow(
      /No numbers available in area code 999/,
    );
    expect(client.purchase).not.toHaveBeenCalled();
  });

  it("maps a number owned by another account (unique violation) to a friendly error", async () => {
    const { client } = mockTwilio();
    db.failNext("voice_numbers", { message: "duplicate key", code: "23505" }, "insert");
    await expect(provisionMissedCallCatcher(ctx(), { companyId: COMPANY, areaCode: 705 }, deps(client))).rejects.toThrow(
      /already connected to another account/,
    );
  });

  it("refuses a company outside the caller's org, and an unconfigured deployment", async () => {
    const { client } = mockTwilio();
    await expect(provisionMissedCallCatcher(ctx(), { companyId: "other-co", areaCode: 705 }, deps(client))).rejects.toThrow(
      /does not belong/,
    );
    delete process.env.APP_BASE_URL;
    await expect(provisionMissedCallCatcher(ctx(), { companyId: COMPANY, areaCode: 705 }, deps(client))).rejects.toThrow(/APP_BASE_URL/);
    expect(client.purchase).not.toHaveBeenCalled();
  });
});

describe("provisioning ownership guards (one Twilio account, many tenants)", () => {
  const OTHER_ORG = "org-2";

  it("refuses the platform's shared TWILIO_FROM_NUMBER, before touching its webhooks", async () => {
    process.env.TWILIO_FROM_NUMBER = "705-555-0999";
    const { client } = mockTwilio([{ sid: "PNshared", phone_number: "+17055550999", voice_url: null, sms_url: SMS_URL }]);
    await expect(provisionMissedCallCatcher(ctx(), { companyId: COMPANY, attachNumber: "+17055550999" }, deps(client))).rejects.toThrow(
      /shared SMS sender/,
    );
    expect(client.updateWebhooks).not.toHaveBeenCalled();
    expect(db.tables.voice_numbers).toHaveLength(0);
    delete process.env.TWILIO_FROM_NUMBER;
  });

  it("refuses another org's catcher number (cross-org row), without rewriting its webhooks", async () => {
    db.tables.voice_numbers.push({
      id: "vn-other", organization_id: OTHER_ORG, company_id: "co-9", phone_e164: "+17055550500",
      provider: "twilio", mode: "missed_call_catcher", active: true,
    });
    const { client } = mockTwilio([{ sid: "PN5", phone_number: "+17055550500", friendly_name: catcherFriendlyName("co-9"), voice_url: VOICE_URL, sms_url: SMS_URL }]);
    await expect(provisionMissedCallCatcher(ctx(), { companyId: COMPANY, attachNumber: "+17055550500" }, deps(client))).rejects.toThrow(
      /belongs to another company/,
    );
    expect(client.updateWebhooks).not.toHaveBeenCalled();
  });

  it("refuses an untagged number that already has a row in another org (e.g. a Retell/SMS line)", async () => {
    db.tables.voice_numbers.push({
      id: "vn-other", organization_id: OTHER_ORG, company_id: "co-9", phone_e164: "+17055550501",
      provider: "retell", mode: "ai_receptionist", active: false,
    });
    const { client } = mockTwilio([{ sid: "PN6", phone_number: "+17055550501", voice_url: null, sms_url: null }]);
    await expect(provisionMissedCallCatcher(ctx(), { companyId: COMPANY, attachNumber: "+17055550501" }, deps(client))).rejects.toThrow(
      /already connected to another company/,
    );
    expect(client.updateWebhooks).not.toHaveBeenCalled();
  });

  it("refuses a number from the same org but a different company", async () => {
    db.tables.voice_numbers.push({
      id: "vn-sib", organization_id: ORG, company_id: "co-sibling", phone_e164: "+17055550502",
      provider: "twilio", mode: "missed_call_catcher", active: true,
    });
    const { client } = mockTwilio([{ sid: "PN7", phone_number: "+17055550502", voice_url: null, sms_url: null }]);
    await expect(provisionMissedCallCatcher(ctx(), { companyId: COMPANY, attachNumber: "+17055550502" }, deps(client))).rejects.toThrow(
      /already connected/,
    );
  });

  it("refuses attaching an untagged number whose webhooks are already configured", async () => {
    const { client } = mockTwilio([{ sid: "PN8", phone_number: "+17055550503", voice_url: "https://other.example/voice", sms_url: null }]);
    await expect(provisionMissedCallCatcher(ctx(), { companyId: COMPANY, attachNumber: "+17055550503" }, deps(client))).rejects.toThrow(
      /already has voice\/SMS webhooks configured/,
    );
    expect(client.updateWebhooks).not.toHaveBeenCalled();
  });

  it("allows re-attaching a number tagged for THIS company (and tags attached numbers)", async () => {
    const { client, account } = mockTwilio([
      { sid: "PN10", phone_number: "+17055550504", friendly_name: catcherFriendlyName(COMPANY), voice_url: VOICE_URL, sms_url: SMS_URL },
      { sid: "PN11", phone_number: "+17055550505", voice_url: null, sms_url: null },
    ]);
    await expect(provisionMissedCallCatcher(ctx(), { companyId: COMPANY, attachNumber: "+17055550504" }, deps(client))).resolves.toMatchObject({
      phoneNumber: "+17055550504",
    });
    await provisionMissedCallCatcher(ctx(), { companyId: COMPANY, attachNumber: "+17055550505" }, deps(client));
    expect(account.find((n) => n.sid === "PN11")?.friendly_name).toBe(catcherFriendlyName(COMPANY));
  });
});

describe("manual voice-number entry can't create twilio rows", () => {
  it("rejects provider 'twilio' (twilio rows come only from provisioning)", async () => {
    const { createVoiceNumber } = await import("@/server/services/voice-numbers");
    await expect(
      createVoiceNumber(ctx(), { companyId: COMPANY, phone: "+17055550999", provider: "twilio" as never }),
    ).rejects.toThrow(/provider must be 'retell' or 'telnyx'/);
    expect(db.tables.voice_numbers).toHaveLength(0);
  });
});

describe("getMissedCallCatcherStatus", () => {
  it("returns the active catcher number with forwarding instructions", async () => {
    const { client } = mockTwilio();
    await provisionMissedCallCatcher(ctx(), { companyId: COMPANY, areaCode: 705 }, deps(client));
    const status = await getMissedCallCatcherStatus(ctx(), COMPANY);
    expect(status.configured).toBe(true);
    expect(status.number).toMatchObject({ phoneNumber: "+17055550100", phoneNumberPretty: "(705) 555-0100" });
    expect(status.instructions?.codes.map((c) => c.activate)).toEqual([
      "**61*+17055550100#",
      "**67*+17055550100#",
      "**62*+17055550100#",
    ]);
  });

  it("no number yet → null", async () => {
    const status = await getMissedCallCatcherStatus(ctx(), COMPANY);
    expect(status.number).toBeNull();
    expect(status.instructions).toBeNull();
  });
});
