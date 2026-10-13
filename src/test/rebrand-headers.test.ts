/**
 * Everdoer rebrand PR 1 (decision D6): inbound x-everdoer-* headers with x-empirevu-* fallback,
 * and the Retell tool header NAME we write, which follows EVERDOER_WRITE_NEW_NAMES.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signIntakeBody } from "@/server/services/lead-intake/hmac";
import { captureLegacyUsage } from "@/test/helpers/legacy-usage-capture";

const handleLeadIntake = vi.fn();
vi.mock("@/server/services/lead-intake/intake", () => ({
  handleLeadIntake: (...args: unknown[]) => handleLeadIntake(...args),
}));
const resolveIntakeKey = vi.fn();
vi.mock("@/server/services/lead-intake/intake-keys", () => ({
  resolveIntakeKey: (...args: unknown[]) => resolveIntakeKey(...args),
}));

import { POST as intakePOST } from "@/app/api/intake/route";
import {
  LEGACY_RETELL_FUNCTION_SECRET_HEADER,
  RETELL_FUNCTION_SECRET_HEADER,
  retellFunctionSecretHeaderForWrite,
  verifyRetellFunctionSecret,
} from "@/server/services/retell/auth";
import { buildReceptionistTools } from "@/server/services/retell/receptionist-tools";
import { LEGACY_TELNYX_SECRET_HEADER, TELNYX_SECRET_HEADER, verifyTelnyxSecret } from "@/server/services/telnyx/auth";
import { buildMessageAgentConfig } from "@/server/services/voice/message-agent";

let usage: ReturnType<typeof captureLegacyUsage>;
const ENV_KEYS = ["RETELL_FUNCTION_SECRET", "TELNYX_WEBHOOK_SECRET", "LEAD_INTAKE_SECRET", "EVERDOER_WRITE_NEW_NAMES"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  usage = captureLegacyUsage();
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.RETELL_FUNCTION_SECRET = "rs-VALUE-123";
  process.env.TELNYX_WEBHOOK_SECRET = "telnyx-secret";
  delete process.env.EVERDOER_WRITE_NEW_NAMES;
  handleLeadIntake.mockReset().mockResolvedValue({ ok: true, leadId: "lead_test" });
  resolveIntakeKey.mockReset();
});
afterEach(() => {
  usage.restore();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const post = (url: string, headers: Record<string, string>, body = "{}") => new Request(url, { method: "POST", headers, body });

describe("names", () => {
  it("are the D6 names", () => {
    expect(RETELL_FUNCTION_SECRET_HEADER).toBe("x-everdoer-retell-secret");
    expect(LEGACY_RETELL_FUNCTION_SECRET_HEADER).toBe("x-empirevu-retell-secret");
    expect(TELNYX_SECRET_HEADER).toBe("x-everdoer-telnyx-secret");
    expect(LEGACY_TELNYX_SECRET_HEADER).toBe("x-empirevu-telnyx-secret");
  });
});

describe("Retell function secret (x-everdoer-retell-secret, falls back to x-empirevu-retell-secret)", () => {
  const url = "https://app.empirevu.com/api/retell/functions/quote?secret=nope";

  it("accepts the old header and counts it (path only, never the value or query)", async () => {
    expect(verifyRetellFunctionSecret(post(url, { "x-empirevu-retell-secret": "rs-VALUE-123" }))).toBe(true);
    const rows = await usage.rows();
    expect(rows).toEqual([{ kind: "header", key: "x-empirevu-retell-secret", sample: "/api/retell/functions/quote", count: 1 }]);
    expect(JSON.stringify(rows)).not.toContain("rs-VALUE-123");
  });

  it("accepts the new header and counts nothing", async () => {
    expect(verifyRetellFunctionSecret(post(url, { "x-everdoer-retell-secret": "rs-VALUE-123" }))).toBe(true);
    expect(await usage.rows()).toEqual([]);
  });

  it("new wins when both are sent (a wrong new value is NOT rescued by a right old one)", async () => {
    expect(verifyRetellFunctionSecret(post(url, { "x-everdoer-retell-secret": "rs-VALUE-123", "x-empirevu-retell-secret": "wrong" }))).toBe(true);
    expect(verifyRetellFunctionSecret(post(url, { "x-everdoer-retell-secret": "wrong", "x-empirevu-retell-secret": "rs-VALUE-123" }))).toBe(false);
    expect(await usage.rows()).toEqual([]);
  });

  it("still fails closed: wrong value, missing header, missing env secret", () => {
    expect(verifyRetellFunctionSecret(post(url, { "x-empirevu-retell-secret": "wrong" }))).toBe(false);
    expect(verifyRetellFunctionSecret(post(url, {}))).toBe(false);
    delete process.env.RETELL_FUNCTION_SECRET;
    expect(verifyRetellFunctionSecret(post(url, { "x-everdoer-retell-secret": "rs-VALUE-123" }))).toBe(false);
  });
});

describe("Telnyx secret (x-everdoer-telnyx-secret, falls back to x-empirevu-telnyx-secret)", () => {
  const url = "https://api.empirevu.com/api/telnyx/insights";

  it("old accepted + counted; new accepted, not counted; new wins", async () => {
    expect(verifyTelnyxSecret(post(url, { "x-empirevu-telnyx-secret": "telnyx-secret" }))).toBe(true);
    expect(verifyTelnyxSecret(post(url, { "x-everdoer-telnyx-secret": "telnyx-secret" }))).toBe(true);
    expect(verifyTelnyxSecret(post(url, { "x-everdoer-telnyx-secret": "nope", "x-empirevu-telnyx-secret": "telnyx-secret" }))).toBe(false);
    expect(verifyTelnyxSecret(post(url, { "x-empirevu-telnyx-secret": "nope" }))).toBe(false);
    expect(await usage.rows()).toEqual([{ kind: "header", key: "x-empirevu-telnyx-secret", sample: "/api/telnyx/insights", count: 2 }]);
  });
});

describe("/api/intake (x-everdoer-key / -signature, falls back to x-empirevu-*)", () => {
  const KEY = "evk_testkey123";
  const body = JSON.stringify({ contact: { email: "a@b.com" } });
  const target = { id: "k1", organizationId: "org-K", companyId: "co-K" };

  it("key mode with the NEW headers: 200, nothing counted", async () => {
    resolveIntakeKey.mockResolvedValue(target);
    const res = await intakePOST(post("http://test/api/intake", { "x-everdoer-key": KEY, "x-everdoer-signature": signIntakeBody(body, KEY) }, body));
    expect(res.status).toBe(200);
    expect(resolveIntakeKey).toHaveBeenCalledWith(KEY);
    expect(await usage.rows()).toEqual([]);
  });

  it("key mode with the OLD headers (the A1 sites today): 200, each old name counted", async () => {
    resolveIntakeKey.mockResolvedValue(target);
    const res = await intakePOST(post("http://test/api/intake", { "x-empirevu-key": KEY, "x-empirevu-signature": signIntakeBody(body, KEY) }, body));
    expect(res.status).toBe(200);
    const rows = await usage.rows();
    expect(rows).toEqual(
      expect.arrayContaining([
        { kind: "header", key: "x-empirevu-key", sample: "/api/intake", count: 1 },
        { kind: "header", key: "x-empirevu-signature", sample: "/api/intake", count: 1 },
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it("mixed names work (each header falls back on its own)", async () => {
    resolveIntakeKey.mockResolvedValue(target);
    const res = await intakePOST(post("http://test/api/intake", { "x-everdoer-key": KEY, "x-empirevu-signature": signIntakeBody(body, KEY) }, body));
    expect(res.status).toBe(200);
    expect(await usage.rows()).toEqual([{ kind: "header", key: "x-empirevu-signature", sample: "/api/intake", count: 1 }]);
  });

  it("new key header wins over the old one", async () => {
    resolveIntakeKey.mockResolvedValue(target);
    await intakePOST(post("http://test/api/intake", { "x-everdoer-key": KEY, "x-empirevu-key": "evk_other", "x-everdoer-signature": signIntakeBody(body, KEY) }, body));
    expect(resolveIntakeKey).toHaveBeenCalledWith(KEY);
  });

  it("legacy mode (shared secret, no key) verifies under either signature name; a bad signature is still 401", async () => {
    process.env.LEAD_INTAKE_SECRET = "legacy-secret";
    const sig = signIntakeBody(body, "legacy-secret");
    expect((await intakePOST(post("http://test/api/intake", { "x-empirevu-signature": sig }, body))).status).toBe(200);
    expect((await intakePOST(post("http://test/api/intake", { "x-everdoer-signature": sig }, body))).status).toBe(200);
    expect((await intakePOST(post("http://test/api/intake", { "x-everdoer-signature": signIntakeBody(body, "nope") }, body))).status).toBe(401);
    expect(handleLeadIntake).toHaveBeenCalledTimes(2);
  });
});

describe("Retell tool header NAME we write follows EVERDOER_WRITE_NEW_NAMES", () => {
  const headerNames = (tools: Array<Record<string, unknown>>) =>
    tools.filter((t) => t.headers).map((t) => Object.keys(t.headers as Record<string, string>));

  it("flag off (PR 1 default): old name only, everywhere", () => {
    expect(retellFunctionSecretHeaderForWrite()).toBe("x-empirevu-retell-secret");
    const tools = buildReceptionistTools({ baseUrl: "https://app.empirevu.com", functionSecret: "s", marine: false });
    expect(new Set(headerNames(tools).flat())).toEqual(new Set(["x-empirevu-retell-secret"]));
    const llm = buildMessageAgentConfig({ baseUrl: "https://app.empirevu.com", functionSecret: "s" }).llm;
    expect(new Set(headerNames(llm.general_tools as Array<Record<string, unknown>>).flat())).toEqual(new Set(["x-empirevu-retell-secret"]));
  });

  it("flag on: new name only, everywhere", () => {
    process.env.EVERDOER_WRITE_NEW_NAMES = "1";
    expect(retellFunctionSecretHeaderForWrite()).toBe("x-everdoer-retell-secret");
    const tools = buildReceptionistTools({ baseUrl: "https://app.everdoer.com", functionSecret: "s", marine: true });
    expect(new Set(headerNames(tools).flat())).toEqual(new Set(["x-everdoer-retell-secret"]));
    const llm = buildMessageAgentConfig({ baseUrl: "https://app.everdoer.com", functionSecret: "s" }).llm;
    expect(new Set(headerNames(llm.general_tools as Array<Record<string, unknown>>).flat())).toEqual(new Set(["x-everdoer-retell-secret"]));
  });

  it("whatever name we write, our verifier accepts it", () => {
    for (const flag of [undefined, "1"]) {
      if (flag) process.env.EVERDOER_WRITE_NEW_NAMES = flag;
      else delete process.env.EVERDOER_WRITE_NEW_NAMES;
      const name = retellFunctionSecretHeaderForWrite();
      expect(verifyRetellFunctionSecret(post("https://x/api/retell/functions/book", { [name]: "rs-VALUE-123" }))).toBe(true);
    }
  });
});
