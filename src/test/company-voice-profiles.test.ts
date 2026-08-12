import { describe, expect, it } from "vitest";

import type { RetellVoiceConfig } from "@/server/outbound/retell-voice";
import {
  effectiveVoiceForProfile,
  type CompanyVoiceProfile,
} from "@/server/services/company-voice-profiles";

const GLOBAL: RetellVoiceConfig = { apiKey: "key_x", fromNumber: "+17055550000", agentId: "agent_global" };

const profile = (over: Partial<CompanyVoiceProfile> = {}): CompanyVoiceProfile => ({
  companyId: "co1",
  retellOutboundAgentId: "agent_storage",
  fromNumber: "+17055551111",
  brandLabel: "A1 Marine Storage",
  dynamicVariables: { services: "winterization, storage" },
  active: true,
  ...over,
});

describe("effectiveVoiceForProfile — per-company outbound routing", () => {
  it("uses the company's agent, caller ID + brand context when set", () => {
    const { config, dynamicVariables } = effectiveVoiceForProfile(GLOBAL, profile(), {
      customerName: "Dana",
      companyName: "Fallback Co",
    });
    // The brand's own agent → its knowledge base + system prompt.
    expect(config.agentId).toBe("agent_storage");
    expect(config.fromNumber).toBe("+17055551111"); // brand caller ID
    expect(config.apiKey).toBe("key_x"); //            apiKey is always global
    // brand_label wins over the fallback company name.
    expect(dynamicVariables.company_name).toBe("A1 Marine Storage");
    expect(dynamicVariables.customer_name).toBe("Dana");
    expect(dynamicVariables.services).toBe("winterization, storage"); // brand context carried through
  });

  it("falls back to the global agent/number + fallback company name when no profile exists", () => {
    const { config, dynamicVariables } = effectiveVoiceForProfile(GLOBAL, null, {
      customerName: "Dana",
      companyName: "A1 Coatings",
    });
    expect(config.agentId).toBe("agent_global");
    expect(config.fromNumber).toBe("+17055550000");
    expect(dynamicVariables.company_name).toBe("A1 Coatings");
  });

  it("falls back per-field for anything the profile leaves empty", () => {
    const { config } = effectiveVoiceForProfile(
      GLOBAL,
      profile({ retellOutboundAgentId: null, fromNumber: null }),
      {},
    );
    expect(config.agentId).toBe("agent_global");
    expect(config.fromNumber).toBe("+17055550000");
  });

  it("omits company_name when neither brand_label nor a fallback is given", () => {
    const { dynamicVariables } = effectiveVoiceForProfile(GLOBAL, profile({ brandLabel: null }), {
      customerName: "Dana",
    });
    expect(dynamicVariables.company_name).toBeUndefined();
    expect(dynamicVariables.customer_name).toBe("Dana");
  });
});
