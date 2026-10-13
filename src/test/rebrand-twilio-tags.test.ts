/**
 * Everdoer rebrand PR 1: Twilio FriendlyName tags. Readers recognise "EmpireVu …" and
 * "Everdoer …"; writers use the old prefix until EVERDOER_WRITE_NEW_NAMES is on; an old-tag match
 * is counted (twilio_tag). The idempotency lookup must find a number under EITHER name, or a
 * second number would be bought.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, fakeTenantContext, type FakeDb } from "./fake-supabase";
import { captureLegacyUsage } from "@/test/helpers/legacy-usage-capture";

vi.mock("@/server/services/workflow-engine/recipes/install", () => ({
  installRecipes: () => Promise.resolve({ installed: [], skipped: [] }),
}));

import { businessLineFriendlyName } from "@/server/services/staff/porting/completion";
import { twilioSideOk } from "@/server/services/staff/porting/guards";
import {
  isTwilioTagFor,
  parseTwilioTag,
  retaggedFriendlyName,
  twilioTagCandidates,
  twilioTagForWrite,
} from "@/server/services/twilio/friendly-name";
import {
  assertNumberClaimable,
  catcherFriendlyName,
  provisionMissedCallCatcher,
  type TwilioIncomingNumber,
  type TwilioNumbersClient,
} from "@/server/services/twilio/provision";

const ORG = "org-1";
const CO = "co-1";
const OTHER = "co-2";
const BASE = "https://app.empirevu.com";
const VOICE_URL = `${BASE}/api/twilio/voice/inbound`;
const SMS_URL = `${BASE}/api/twilio/sms/inbound`;
const ENV_KEYS = ["APP_BASE_URL", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WEBHOOK_BASE_URL", "EVERDOER_WRITE_NEW_NAMES"];
const saved: Record<string, string | undefined> = {};
let usage: ReturnType<typeof captureLegacyUsage>;
let db: FakeDb;

beforeEach(() => {
  usage = captureLegacyUsage();
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.APP_BASE_URL = BASE;
  process.env.TWILIO_ACCOUNT_SID = "AC123";
  process.env.TWILIO_AUTH_TOKEN = "token";
  delete process.env.TWILIO_WEBHOOK_BASE_URL;
  delete process.env.EVERDOER_WRITE_NEW_NAMES;
  db = createFakeDb({ companies: [{ id: CO, organization_id: ORG, name: "Muskoka Plumbing" }], voice_numbers: [] });
});
afterEach(() => {
  usage.restore();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("friendly-name module", () => {
  it("writes the old prefix by default and the new one under the flag", () => {
    expect(twilioTagForWrite("catcher", CO)).toBe("EmpireVu catcher co-1");
    expect(twilioTagForWrite("line", CO)).toBe("EmpireVu line co-1");
    expect(catcherFriendlyName(CO)).toBe("EmpireVu catcher co-1");
    expect(businessLineFriendlyName(CO)).toBe("EmpireVu line co-1");
    process.env.EVERDOER_WRITE_NEW_NAMES = "true";
    expect(catcherFriendlyName(CO)).toBe("Everdoer catcher co-1");
    expect(businessLineFriendlyName(CO)).toBe("Everdoer line co-1");
  });

  it("candidates are new first, then old", () => {
    expect(twilioTagCandidates("catcher", CO)).toEqual(["Everdoer catcher co-1", "EmpireVu catcher co-1"]);
  });

  it("parses both prefixes, counts only old ones on the read path", async () => {
    expect(parseTwilioTag("Everdoer line co-1")).toEqual({ kind: "line", companyId: "co-1", legacy: false });
    expect(parseTwilioTag("EmpireVu catcher co-1")).toEqual({ kind: "catcher", companyId: "co-1", legacy: true });
    expect(parseTwilioTag("Main office")).toBeNull();
    expect(parseTwilioTag(null)).toBeNull();
    expect(await usage.rows()).toEqual([]); // parse alone never counts

    expect(isTwilioTagFor("Everdoer catcher co-1", "catcher", CO)).toBe(true);
    expect(isTwilioTagFor("EmpireVu catcher co-1", "catcher", CO)).toBe(true);
    expect(isTwilioTagFor("EmpireVu catcher co-2", "catcher", CO)).toBe(false);
    expect(isTwilioTagFor("EmpireVu line co-1", "catcher", CO)).toBe(false);
    expect(await usage.rows()).toEqual([
      { kind: "twilio_tag", key: "EmpireVu catcher", sample: null, count: 2 },
      { kind: "twilio_tag", key: "EmpireVu line", sample: null, count: 1 },
    ]);
  });

  it("retag maps old → new and leaves anything else alone", () => {
    expect(retaggedFriendlyName("EmpireVu catcher co-1")).toBe("Everdoer catcher co-1");
    expect(retaggedFriendlyName("EmpireVu line co-9")).toBe("Everdoer line co-9");
    expect(retaggedFriendlyName("Everdoer line co-9")).toBeNull();
    expect(retaggedFriendlyName("A1 Marine Care main line")).toBeNull();
    expect(retaggedFriendlyName(null)).toBeNull();
  });
});

function mockTwilio(initial: TwilioIncomingNumber[] = []) {
  const account = initial.map((n) => ({ ...n }));
  const client = {
    searchAvailableLocal: vi.fn(() => Promise.resolve([{ phone_number: "+17055550199" }])),
    listIncoming: vi.fn((filter: { phoneNumber?: string; friendlyName?: string }) =>
      Promise.resolve(account.filter((n) => (!filter.phoneNumber || n.phone_number === filter.phoneNumber) && (!filter.friendlyName || n.friendly_name === filter.friendlyName))),
    ),
    purchase: vi.fn((input: { phoneNumber: string; friendlyName: string; voiceUrl: string; smsUrl: string }) => {
      const bought = { sid: "PNnew", phone_number: input.phoneNumber, friendly_name: input.friendlyName, voice_url: input.voiceUrl, sms_url: input.smsUrl };
      account.push(bought);
      return Promise.resolve(bought);
    }),
    updateWebhooks: vi.fn((sid: string, input: { voiceUrl: string; smsUrl: string; friendlyName: string }) => {
      const n = account.find((x) => x.sid === sid)!;
      Object.assign(n, { voice_url: input.voiceUrl, sms_url: input.smsUrl, friendly_name: input.friendlyName });
      return Promise.resolve({ ...n });
    }),
  } satisfies TwilioNumbersClient;
  return { client, account };
}
const lookupOwner = () => Promise.resolve(null);
const ctx = () => fakeTenantContext(db, ORG, "user-1");

describe("catcher provisioning idempotency (a duplicate purchase costs money)", () => {
  it("flag ON: finds a number left under the OLD tag instead of buying, then writes the new tag", async () => {
    process.env.EVERDOER_WRITE_NEW_NAMES = "1";
    const { client, account } = mockTwilio([{ sid: "PN1", phone_number: "+17055550100", friendly_name: "EmpireVu catcher co-1", voice_url: VOICE_URL, sms_url: SMS_URL }]);
    const result = await provisionMissedCallCatcher(ctx(), { companyId: CO, areaCode: 705 }, { client, lookupOwner });
    expect(client.purchase).not.toHaveBeenCalled();
    expect(result).toMatchObject({ numberSid: "PN1", purchased: false });
    expect(client.listIncoming.mock.calls.map((c) => c[0].friendlyName)).toEqual(["Everdoer catcher co-1", "EmpireVu catcher co-1"]);
    expect(account[0].friendly_name).toBe("Everdoer catcher co-1");
    expect(await usage.rows()).toContainEqual({ kind: "twilio_tag", key: "EmpireVu catcher", sample: null, count: 1 });
  });

  it("flag OFF (e.g. after a rollback): finds a number under the NEW tag instead of buying", async () => {
    const { client, account } = mockTwilio([{ sid: "PN1", phone_number: "+17055550100", friendly_name: "Everdoer catcher co-1", voice_url: VOICE_URL, sms_url: SMS_URL }]);
    const result = await provisionMissedCallCatcher(ctx(), { companyId: CO, areaCode: 705 }, { client, lookupOwner });
    expect(client.purchase).not.toHaveBeenCalled();
    expect(result).toMatchObject({ numberSid: "PN1", purchased: false });
    expect(account[0].friendly_name).toBe("EmpireVu catcher co-1"); // writers follow the flag
  });

  it("flag OFF, nothing tagged: buys once with the OLD tag (unchanged behaviour)", async () => {
    const { client } = mockTwilio();
    await provisionMissedCallCatcher(ctx(), { companyId: CO, areaCode: 705 }, { client, lookupOwner });
    expect(client.purchase).toHaveBeenCalledWith(expect.objectContaining({ friendlyName: "EmpireVu catcher co-1" }));
  });

  it("refuses a number tagged for another company under EITHER prefix", async () => {
    for (const friendly_name of ["EmpireVu catcher co-2", "Everdoer catcher co-2"]) {
      await expect(
        assertNumberClaimable(ctx(), CO, { sid: "PN5", phone_number: "+17055550500", friendly_name }, { attaching: true, lookupOwner }),
      ).rejects.toThrow("belongs to another company");
    }
  });

  it("our own tag under either prefix is ours (attach skips the 'webhooks already configured' refusal)", async () => {
    for (const friendly_name of ["EmpireVu catcher co-1", "Everdoer catcher co-1"]) {
      await expect(
        assertNumberClaimable(ctx(), CO, { sid: "PN5", phone_number: "+17055550500", friendly_name, voice_url: "https://elsewhere.example/x" }, { attaching: true, lookupOwner }),
      ).resolves.toBeUndefined();
    }
  });
});

describe("porting guards read both prefixes", () => {
  const url = "https://hooks.test/api/twilio/voice/business-line";
  it("never touches a catcher, or another company's line, under either prefix", () => {
    for (const brand of ["EmpireVu", "Everdoer"]) {
      expect(twilioSideOk({ sid: "x", phone_number: "+1", friendly_name: `${brand} catcher ${CO}` }, CO, url)).toBe(false);
      expect(twilioSideOk({ sid: "x", phone_number: "+1", friendly_name: `${brand} line ${OTHER}` }, CO, url)).toBe(false);
      expect(twilioSideOk({ sid: "x", phone_number: "+1", friendly_name: `${brand} line ${CO}`, voice_url: url }, CO, url)).toBe(true);
    }
  });
});
