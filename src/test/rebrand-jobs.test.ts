/**
 * Everdoer rebrand PR 1: the provider re-point jobs, against injected fakes only (no Twilio, no
 * Retell, no network). job:twilio-repoint, job:twilio-retag, job:retell-repoint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb } from "./fake-supabase";
import { captureLegacyUsage } from "@/test/helpers/legacy-usage-capture";

import {
  inspectAgent,
  listProvisionedReceptionists,
  parseRetellRepointArgs,
  runRetellRepoint,
  type RetellRepointDeps,
} from "@/server/services/rebrand/retell-repoint";
import {
  formatRepointPlan,
  parseRepointArgs,
  planTwilioRepoint,
  repointApplyBlocker,
  resolveRepointTarget,
  runTwilioRepoint,
  swapOldHost,
} from "@/server/services/rebrand/twilio-repoint";
import { planTwilioRetag, RetagRefusedError, runTwilioRetag } from "@/server/services/rebrand/twilio-retag";
import type { RetellReader } from "@/server/services/retell/health";
import type { TwilioAccountNumber, TwilioAccountNumbersClient } from "@/server/services/twilio/provision";

let usage: ReturnType<typeof captureLegacyUsage>;
beforeEach(() => {
  usage = captureLegacyUsage();
});
afterEach(() => {
  usage.restore();
});

function fakeTwilio(numbers: TwilioAccountNumber[]) {
  const account = numbers.map((n) => ({ ...n }));
  const client = {
    listAll: vi.fn(() => Promise.resolve(account.map((n) => ({ ...n })))),
    update: vi.fn((sid: string, fields: Record<string, string>) => {
      if (sid === "PNfail") return Promise.reject(new Error("twilio 500"));
      return Promise.resolve();
    }),
  } satisfies TwilioAccountNumbersClient;
  return client;
}

const CATCHER: TwilioAccountNumber = {
  sid: "PN1",
  phone_number: "+17055550100",
  friendly_name: "EmpireVu catcher co-1",
  voice_url: "https://app.empirevu.com/api/twilio/voice/inbound",
  voice_fallback_url: "",
  sms_url: "https://api.empirevu.com/api/twilio/sms/inbound?x=1&y=%20z",
  sms_fallback_url: null,
  status_callback: "https://app.crankleads.com/api/twilio/status",
};
const LINE: TwilioAccountNumber = {
  sid: "PN2",
  phone_number: "+17055550200",
  friendly_name: "Everdoer line co-2",
  voice_url: "https://app.empirevu.com/api/twilio/voice/business-line",
  sms_url: "https://app.everdoer.com/api/twilio/sms/inbound",
};
const A1_HAND_SET: TwilioAccountNumber = {
  sid: "PN3",
  phone_number: "+17055550300",
  friendly_name: "A1 Marine Care main",
  voice_url: "https://api.empirevu.com/api/twilio/voice/inbound",
  sms_url: "https://api.empirevu.com/api/twilio/sms/inbound",
};
const TENANT: TwilioAccountNumber = {
  sid: "PN4",
  phone_number: "+17055550400",
  friendly_name: "EmpireVu catcher co-4",
  voice_url: "https://quotes.a1marinecare.ca/api/voice",
  sms_url: "https://handler.twilio.com/twiml/EH1",
};

describe("swapOldHost", () => {
  it("swaps only the hostname; scheme, userinfo, port, path and query byte for byte", () => {
    expect(swapOldHost("https://app.empirevu.com/api/twilio/voice/inbound", "app.everdoer.com")).toBe("https://app.everdoer.com/api/twilio/voice/inbound");
    expect(swapOldHost("https://API.EmpireVu.com/a?b=%20c&d", "app.everdoer.com")).toBe("https://app.everdoer.com/a?b=%20c&d");
    expect(swapOldHost("http://user:p%40ss@app.crankleads.com:8443/x#frag", "app.everdoer.com")).toBe("http://user:p%40ss@app.everdoer.com:8443/x#frag");
    expect(swapOldHost("https://app.empirevu.com", "app.everdoer.com")).toBe("https://app.everdoer.com");
  });
  it("leaves new hosts, tenant hosts, marketing hosts and Twilio handlers alone", () => {
    for (const url of [
      "https://app.everdoer.com/api/x",
      "https://quotes.a1marinecare.ca/api/x",
      "https://empirevu.com/api/x",
      "https://app.empirevu.com.evil.example/api/x",
      "https://handler.twilio.com/twiml/EH1",
      "",
      null,
      "not a url",
    ]) {
      expect(swapOldHost(url, "app.everdoer.com")).toBeNull();
    }
  });
});

describe("resolveRepointTarget", () => {
  it("--to wins; EVERDOER_APP_BASE_URL is the fallback; one is required", () => {
    expect(resolveRepointTarget("https://app.everdoer.com", {})).toEqual({ origin: "https://app.everdoer.com", host: "app.everdoer.com", known: true });
    expect(resolveRepointTarget(null, { EVERDOER_APP_BASE_URL: "https://api.everdoer.com/" }).host).toBe("api.everdoer.com");
    expect(() => resolveRepointTarget(null, {})).toThrow(/--to/);
  });
  it("refuses http, a path/query, and an old host", () => {
    expect(() => resolveRepointTarget("http://app.everdoer.com", {})).toThrow(/https/);
    expect(() => resolveRepointTarget("https://app.everdoer.com/api", {})).toThrow(/origin only/);
    expect(() => resolveRepointTarget("https://app.everdoer.com?x=1", {})).toThrow(/origin only/);
    expect(() => resolveRepointTarget("https://app.empirevu.com", {})).toThrow(/OLD host/);
  });
  it("parses args", () => {
    expect(parseRepointArgs(["--to", "https://app.everdoer.com", "--only", "+17055550100", "--apply"])).toEqual({ apply: true, to: "https://app.everdoer.com", only: "+17055550100" });
    expect(parseRepointArgs([])).toEqual({ apply: false, to: null, only: null });
  });
});

describe("job:twilio-repoint", () => {
  it("plans only tagged numbers' old-host URL fields; lists hand-set numbers as untouched", () => {
    const plan = planTwilioRepoint([CATCHER, LINE, A1_HAND_SET, TENANT], "app.everdoer.com");
    expect(plan.changes).toEqual([
      { sid: "PN1", phoneNumber: "+17055550100", field: "voice_url", formField: "VoiceUrl", from: CATCHER.voice_url, to: "https://app.everdoer.com/api/twilio/voice/inbound" },
      { sid: "PN1", phoneNumber: "+17055550100", field: "sms_url", formField: "SmsUrl", from: CATCHER.sms_url, to: "https://app.everdoer.com/api/twilio/sms/inbound?x=1&y=%20z" },
      { sid: "PN1", phoneNumber: "+17055550100", field: "status_callback", formField: "StatusCallback", from: CATCHER.status_callback, to: "https://app.everdoer.com/api/twilio/status" },
      { sid: "PN2", phoneNumber: "+17055550200", field: "voice_url", formField: "VoiceUrl", from: LINE.voice_url, to: "https://app.everdoer.com/api/twilio/voice/business-line" },
    ]);
    expect(plan.untouched.map((u) => [u.phoneNumber, u.field])).toEqual([
      ["+17055550300", "voice_url"],
      ["+17055550300", "sms_url"],
    ]);
    expect(plan.considered).toBe(3);
    const table = formatRepointPlan(plan);
    expect(table).toContain("number\tfield\tfrom\tto");
    expect(table).toContain("+17055550100\tVoiceUrl\thttps://app.empirevu.com/api/twilio/voice/inbound\thttps://app.everdoer.com/api/twilio/voice/inbound");
    expect(table).toContain("NOT touched");
  });

  it("dry run writes nothing", async () => {
    const client = fakeTwilio([CATCHER, LINE, A1_HAND_SET]);
    const result = await runTwilioRepoint(client, { apply: false, targetHost: "app.everdoer.com" });
    expect(result.plan.changes).toHaveLength(4);
    expect(client.update).not.toHaveBeenCalled();
  });

  it("--apply writes ONE update per number with only the changed URL fields (no methods, no tags, never an untagged number)", async () => {
    const client = fakeTwilio([CATCHER, LINE, A1_HAND_SET, TENANT]);
    const result = await runTwilioRepoint(client, { apply: true, targetHost: "app.everdoer.com" });
    expect(result.applied).toBe(2);
    expect(client.update.mock.calls).toEqual([
      ["PN1", { VoiceUrl: "https://app.everdoer.com/api/twilio/voice/inbound", SmsUrl: "https://app.everdoer.com/api/twilio/sms/inbound?x=1&y=%20z", StatusCallback: "https://app.everdoer.com/api/twilio/status" }],
      ["PN2", { VoiceUrl: "https://app.everdoer.com/api/twilio/voice/business-line" }],
    ]);
    const written = client.update.mock.calls.flatMap((c) => Object.keys(c[1]));
    expect(written.every((k) => ["VoiceUrl", "VoiceFallbackUrl", "SmsUrl", "SmsFallbackUrl", "StatusCallback"].includes(k))).toBe(true);
  });

  it("--only limits it to one number", async () => {
    const client = fakeTwilio([CATCHER, LINE]);
    await runTwilioRepoint(client, { apply: true, targetHost: "app.everdoer.com", only: "+17055550200" });
    expect(client.update.mock.calls.map((c) => c[0])).toEqual(["PN2"]);
  });

  it("a failed update is reported and the rest continue", async () => {
    const client = fakeTwilio([{ ...CATCHER, sid: "PNfail" }, LINE]);
    const result = await runTwilioRepoint(client, { apply: true, targetHost: "app.everdoer.com" });
    expect(result.applied).toBe(1);
    expect(result.failed).toEqual([{ phoneNumber: "+17055550100", error: "twilio 500" }]);
  });
});

describe("job:twilio-retag", () => {
  it("plans old → new for our old tags only", () => {
    expect(planTwilioRetag([CATCHER, LINE, A1_HAND_SET, { ...LINE, sid: "PN5", friendly_name: "EmpireVu line co-5" }])).toEqual([
      { sid: "PN1", phoneNumber: "+17055550100", from: "EmpireVu catcher co-1", to: "Everdoer catcher co-1" },
      { sid: "PN5", phoneNumber: "+17055550200", from: "EmpireVu line co-5", to: "Everdoer line co-5" },
    ]);
  });

  it("dry run is allowed with the flag off and writes nothing", async () => {
    const client = fakeTwilio([CATCHER]);
    const result = await runTwilioRetag(client, { apply: false }, {});
    expect(result.changes).toHaveLength(1);
    expect(client.update).not.toHaveBeenCalled();
  });

  it("--apply is refused unless EVERDOER_WRITE_NEW_NAMES is on (nothing listed or written)", async () => {
    const client = fakeTwilio([CATCHER]);
    await expect(runTwilioRetag(client, { apply: true }, {})).rejects.toBeInstanceOf(RetagRefusedError);
    expect(client.listAll).not.toHaveBeenCalled();
    expect(client.update).not.toHaveBeenCalled();
  });

  it("--apply with the flag on writes ONLY FriendlyName", async () => {
    const client = fakeTwilio([CATCHER, LINE, A1_HAND_SET]);
    const result = await runTwilioRetag(client, { apply: true }, { EVERDOER_WRITE_NEW_NAMES: "1" });
    expect(result.applied).toBe(1);
    expect(client.update.mock.calls).toEqual([["PN1", { FriendlyName: "Everdoer catcher co-1" }]]);
  });
});

// ── Retell ────────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
function fakeReader(agents: Record<string, Obj>, llms: Record<string, Obj>, numbers: Record<string, Obj> = {}): RetellReader {
  return {
    getAgent: vi.fn((id: string) => Promise.resolve((agents[id] ?? { error: "404" }) as never)),
    getLlm: vi.fn((id: string) => Promise.resolve((llms[id] ?? { error: "404" }) as never)),
    getPhoneNumber: vi.fn((n: string) => Promise.resolve((numbers[n] ?? { error: "404" }) as never)),
  };
}

const OLD_TOOLS = (header: string, host = "app.empirevu.com") => ({
  general_tools: [
    { type: "custom", name: "quote_services", url: `https://${host}/api/retell/functions/price-quote`, headers: { [header]: "s" } },
    { type: "end_call", name: "end_call" },
  ],
});

function retellDb(voiceNumbers: Array<Record<string, unknown>> = []) {
  return createFakeDb({
    voice_numbers: voiceNumbers,
    onboarding_progress: [
      { organization_id: "org-1", company_id: "co-stale", step: "phone", data: { llmId: "llm-stale", agentId: "ag-stale", phoneNumber: "+15550000001" } },
      { organization_id: "org-1", company_id: "co-fresh", step: "phone", data: { llmId: "llm-fresh", agentId: "ag-fresh", phoneNumber: "+15550000002" } },
      // Not ours to touch: no stored ids (e.g. a company whose agent was set up by hand).
      { organization_id: "org-a1", company_id: "co-a1", step: "phone", data: { phoneNumber: "+15550000009" } },
      { organization_id: "org-1", company_id: "co-stale", step: "business", data: { llmId: "x", agentId: "y", phoneNumber: "z" } },
    ],
  });
}

const ENV = { APP_BASE_URL: "https://app.everdoer.com", RETELL_FUNCTION_SECRET: "s" };

describe("job:retell-repoint", () => {
  it("lists only receptionists our provisioning stored ids for (phone step with llmId/agentId/phoneNumber)", async () => {
    const all = await listProvisionedReceptionists(retellDb().client);
    expect(all.map((r) => r.companyId).sort()).toEqual(["co-fresh", "co-stale"]);
    const one = await listProvisionedReceptionists(retellDb().client, "co-fresh");
    expect(one.map((r) => r.agentId)).toEqual(["ag-fresh"]);
  });

  it("parses args", () => {
    expect(parseRetellRepointArgs(["--apply", "--company", "co-1", "--all"])).toEqual({ apply: true, all: true, companyId: "co-1" });
    expect(parseRetellRepointArgs([])).toEqual({ apply: false, all: false, companyId: null });
  });

  it("inspectAgent flags old hosts and the header name the flag does not select", async () => {
    const reader = fakeReader(
      { a: { agent_name: "Front desk", webhook_url: "https://api.empirevu.com/api/retell/webhook", response_engine: { llm_id: "l" } } },
      { l: OLD_TOOLS("x-empirevu-retell-secret") },
      { "+1": { inbound_webhook_url: "https://app.crankleads.com/api/retell/inbound" } },
    );
    const off = await inspectAgent(reader, { agentId: "a", phoneNumber: "+1" }, { host: "app.everdoer.com", headerName: "x-empirevu-retell-secret" });
    expect(off.stale).toEqual(["post-call webhook → api.empirevu.com", "tool quote_services → app.empirevu.com", "inbound webhook → app.crankleads.com"]);
    const on = await inspectAgent(reader, { agentId: "a", phoneNumber: "+1" }, { host: "app.everdoer.com", headerName: "x-everdoer-retell-secret" });
    expect(on.stale).toContain("tool quote_services header x-empirevu-retell-secret");
    expect(on.agentName).toBe("Front desk");
  });

  function deps(over: Partial<RetellRepointDeps> = {}, env: Record<string, string | undefined> = ENV) {
    const reader = fakeReader(
      {
        "ag-stale": { webhook_url: "https://app.empirevu.com/api/retell/webhook", response_engine: { llm_id: "llm-stale" } },
        "ag-fresh": { webhook_url: "https://app.everdoer.com/api/retell/webhook", response_engine: { llm_id: "llm-fresh" } },
        "ag-msg": { webhook_url: "https://app.empirevu.com/api/retell/webhook" },
      },
      {
        "llm-stale": OLD_TOOLS("x-empirevu-retell-secret"),
        "llm-fresh": OLD_TOOLS("x-empirevu-retell-secret", "app.everdoer.com"),
        "llm-msg": OLD_TOOLS("x-empirevu-retell-secret"),
      },
      {
        "+15550000001": { inbound_webhook_url: "https://app.empirevu.com/api/retell/inbound" },
        "+15550000002": { inbound_webhook_url: "https://app.everdoer.com/api/retell/inbound" },
      },
    );
    return {
      db: retellDb().client,
      reader,
      resync: vi.fn((_ctx: unknown, _companyId: string) => Promise.resolve({ status: "resynced", llmId: "l", agentId: "a", phoneNumber: "p" } as const)),
      ensureMessage: vi.fn(() => Promise.resolve({ llmId: "llm-msg", agentId: "ag-msg" })),
      env,
      ...over,
    };
  }

  it("dry run: reports stale / up to date, resyncs nothing", async () => {
    const d = deps({}, { ...ENV, RETELL_MESSAGE_AGENT_ID: "ag-msg", RETELL_MESSAGE_LLM_ID: "llm-msg" });
    const rows = await runRetellRepoint(d, { apply: false, all: false, companyId: null });
    expect(rows.map((r) => [r.label, r.action])).toEqual(
      expect.arrayContaining([
        ["company co-stale", "would_resync"],
        ["company co-fresh", "none"],
        ["shared message agent", "would_resync"],
      ]),
    );
    expect(d.resync).not.toHaveBeenCalled();
    expect(d.ensureMessage).not.toHaveBeenCalled();
  });

  it("--apply resyncs only the stale ones, through the per-company resync pinned to the company's org", async () => {
    const d = deps({}, { ...ENV, RETELL_MESSAGE_AGENT_ID: "ag-msg", RETELL_MESSAGE_LLM_ID: "llm-msg" });
    const rows = await runRetellRepoint(d, { apply: true, all: false, companyId: null });
    expect(d.resync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.resync).mock.calls[0][1]).toBe("co-stale");
    expect((vi.mocked(d.resync).mock.calls[0][0] as { organizationId: string }).organizationId).toBe("org-1");
    expect(d.ensureMessage).toHaveBeenCalledTimes(1);
    expect(rows.find((r) => r.companyId === "co-fresh")?.action).toBe("none");
  });

  it("flag on: an agent whose URLs are fine but still sends the old header name is stale", async () => {
    const d = deps({}, { ...ENV, EVERDOER_WRITE_NEW_NAMES: "1" });
    await runRetellRepoint(d, { apply: true, all: false, companyId: null });
    expect(vi.mocked(d.resync).mock.calls.map((c) => c[1]).sort()).toEqual(["co-fresh", "co-stale"]);
  });

  it("--company limits it to that company and skips the shared agent; --all resyncs even clean ones", async () => {
    const d = deps({}, { ...ENV, RETELL_MESSAGE_AGENT_ID: "ag-msg" });
    await runRetellRepoint(d, { apply: true, all: true, companyId: "co-fresh" });
    expect(vi.mocked(d.resync).mock.calls.map((c) => c[1])).toEqual(["co-fresh"]);
    expect(d.ensureMessage).not.toHaveBeenCalled();
  });

  it("an agent Retell can't read is skipped (not blindly resynced), and a resync failure is reported", async () => {
    const d = deps({ resync: vi.fn(() => Promise.reject(new Error("retell down"))) });
    (d.reader.getAgent as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      Promise.resolve(id === "ag-fresh" ? ({ error: "404" } as never) : ({ webhook_url: "https://app.empirevu.com/api/retell/webhook" } as never)),
    );
    const rows = await runRetellRepoint(d, { apply: true, all: false, companyId: null });
    expect(rows.find((r) => r.companyId === "co-fresh")?.action).toBe("skipped_error");
    expect(rows.find((r) => r.companyId === "co-stale")).toMatchObject({ action: "failed", detail: "retell down" });
  });

  it("never resyncs a company whose live Retell number uses a different (hand-made) agent", async () => {
    const d = deps({
      db: retellDb([
        { company_id: "co-stale", provider: "retell", provider_agent_id: "ag-care-by-hand" },
        { company_id: "co-fresh", provider: "retell", provider_agent_id: "ag-fresh" },
      ]).client,
    });
    const rows = await runRetellRepoint(d, { apply: true, all: true, companyId: null });
    expect(rows.find((r) => r.companyId === "co-stale")).toMatchObject({ action: "skipped_guard" });
    expect(rows.find((r) => r.companyId === "co-stale")?.detail).toContain("ag-care-by-hand");
    expect(vi.mocked(d.resync).mock.calls.map((c) => c[1])).toEqual(["co-fresh"]);
  });

  it("RETELL_REPOINT_SKIP_COMPANIES is an explicit deny-list, in the dry run too", async () => {
    const d = deps({}, { ...ENV, RETELL_REPOINT_SKIP_COMPANIES: " co-stale , other " });
    const dry = await runRetellRepoint(d, { apply: false, all: false, companyId: null });
    expect(dry.find((r) => r.companyId === "co-stale")?.action).toBe("skipped_guard");
    await runRetellRepoint(d, { apply: true, all: true, companyId: null });
    expect(vi.mocked(d.resync).mock.calls.map((c) => c[1])).toEqual(["co-fresh"]);
  });

  it("--apply refuses while APP_BASE_URL is still an old host", async () => {
    const d = deps({}, { ...ENV, APP_BASE_URL: "https://app.empirevu.com" });
    await expect(runRetellRepoint(d, { apply: true, all: false, companyId: null })).rejects.toThrow(/old host/);
    expect(d.resync).not.toHaveBeenCalled();
    await expect(runRetellRepoint(d, { apply: false, all: false, companyId: null })).resolves.toBeTruthy();
  });
});

describe("job:twilio-repoint --apply ordering", () => {
  it("refuses until the webhook base itself is on the target host", () => {
    expect(repointApplyBlocker("app.everdoer.com", {})).toMatch(/not set/);
    expect(repointApplyBlocker("app.everdoer.com", { APP_BASE_URL: "https://app.empirevu.com" })).toMatch(/still app.empirevu.com/);
    expect(repointApplyBlocker("app.everdoer.com", { APP_BASE_URL: "https://app.everdoer.com", TWILIO_WEBHOOK_BASE_URL: "https://api.empirevu.com" })).toMatch(/still api.empirevu.com/);
    expect(repointApplyBlocker("app.everdoer.com", { APP_BASE_URL: "https://api.everdoer.com" })).toMatch(/must match/);
    expect(repointApplyBlocker("app.everdoer.com", { APP_BASE_URL: "https://app.empirevu.com", TWILIO_WEBHOOK_BASE_URL: "https://app.everdoer.com" })).toBeNull();
  });
});

describe("job:retell-repoint live-binding guard", () => {
  it("skips a company whose Retell number is bound (in Retell) to another agent, even if our DB says otherwise", async () => {
    const reader = {
      getAgent: vi.fn(() => Promise.resolve({ webhook_url: "https://app.empirevu.com/api/retell/webhook", response_engine: { llm_id: "llm-stale" } })),
      getLlm: vi.fn(() => Promise.resolve({ general_tools: [] })),
      getPhoneNumber: vi.fn(() => Promise.resolve({ inbound_webhook_url: "https://app.empirevu.com/api/retell/inbound", inbound_agent_id: "ag-hand-bound" })),
    } as unknown as RetellReader;
    const resync = vi.fn();
    const rows = await runRetellRepoint(
      { db: retellDb().client, reader, resync, ensureMessage: null, env: ENV },
      { apply: true, all: true, companyId: "co-stale" },
    );
    expect(rows[0]).toMatchObject({ action: "skipped_guard" });
    expect(rows[0].detail).toContain("ag-hand-bound");
    expect(resync).not.toHaveBeenCalled();
  });
});

