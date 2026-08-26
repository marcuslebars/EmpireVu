import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildCreateCallBody,
  readRetellVoiceConfig,
  type RetellVoiceConfig,
} from "@/server/outbound/retell-voice";
import { isOutboundCall, readRetellCallFields } from "@/server/services/retell/lead-adapter";

const CFG: RetellVoiceConfig = { apiKey: "key_x", fromNumber: "+17055551000", agentId: null };

describe("buildCreateCallBody", () => {
  it("includes only from/to when nothing else is set", () => {
    expect(buildCreateCallBody(CFG, { toNumber: "+14165551234" })).toEqual({
      from_number: "+17055551000",
      to_number: "+14165551234",
    });
  });

  it("adds override_agent_id when a dedicated outbound agent is configured", () => {
    const body = buildCreateCallBody({ ...CFG, agentId: "agent_out" }, { toNumber: "+14165551234" });
    expect(body.override_agent_id).toBe("agent_out");
  });

  it("passes metadata + dynamic variables through", () => {
    const body = buildCreateCallBody(CFG, {
      toNumber: "+14165551234",
      metadata: { contactId: "c1", organizationId: "o1" },
      dynamicVariables: { customer_name: "Dana", company_name: "A1 Marine Storage" },
    });
    expect(body.metadata).toEqual({ contactId: "c1", organizationId: "o1" });
    expect(body.retell_llm_dynamic_variables).toEqual({
      customer_name: "Dana",
      company_name: "A1 Marine Storage",
    });
  });

  it("omits empty metadata / dynamic variables", () => {
    const body = buildCreateCallBody(CFG, { toNumber: "+1", metadata: {}, dynamicVariables: {} });
    expect(body).not.toHaveProperty("metadata");
    expect(body).not.toHaveProperty("retell_llm_dynamic_variables");
  });
});

describe("readRetellVoiceConfig", () => {
  const keys = ["RETELL_API_KEY", "RETELL_FROM_NUMBER", "RETELL_OUTBOUND_AGENT_ID"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns null unless apiKey + fromNumber are both set", () => {
    expect(readRetellVoiceConfig()).toBeNull();
    process.env.RETELL_API_KEY = "key_x";
    expect(readRetellVoiceConfig()).toBeNull(); // still missing from-number
  });

  it("reads apiKey + fromNumber + optional agent id", () => {
    process.env.RETELL_API_KEY = "key_x";
    process.env.RETELL_FROM_NUMBER = "+17055551000";
    process.env.RETELL_OUTBOUND_AGENT_ID = "agent_out";
    expect(readRetellVoiceConfig()).toEqual({
      apiKey: "key_x",
      fromNumber: "+17055551000",
      agentId: "agent_out",
    });
  });
});

describe("isOutboundCall (webhook direction routing)", () => {
  it("outbound direction → outbound", () => {
    expect(isOutboundCall({ direction: "outbound", metadata: null })).toBe(true);
  });
  it("explicit inbound wins even with contactId metadata", () => {
    expect(isOutboundCall({ direction: "inbound", metadata: { contactId: "c1" } })).toBe(false);
  });
  it("contactId metadata with no direction → outbound (a call we placed)", () => {
    expect(isOutboundCall({ direction: null, metadata: { contactId: "c1" } })).toBe(true);
  });
  it("no direction, no contactId → inbound lead", () => {
    expect(isOutboundCall({ direction: null, metadata: null })).toBe(false);
  });
});

describe("readRetellCallFields — outbound call", () => {
  it("extracts direction + the echoed metadata + outcome fields", () => {
    const fields = readRetellCallFields({
      event: "call_analyzed",
      call: {
        call_id: "call_out_1",
        direction: "outbound",
        from_number: "+17055551000",
        to_number: "+14165551234",
        metadata: { contactId: "c1", organizationId: "o1", companyId: "co1" },
        call_analysis: { call_summary: "Left a voicemail.", call_successful: true, in_voicemail: true },
      },
    });
    expect(fields.direction).toBe("outbound");
    expect(fields.metadata).toEqual({ contactId: "c1", organizationId: "o1", companyId: "co1" });
    expect(fields.callSummary).toBe("Left a voicemail.");
    expect(fields.callSuccessful).toBe(true);
    expect(fields.inVoicemail).toBe(true);
    expect(isOutboundCall(fields)).toBe(true);
  });
});
