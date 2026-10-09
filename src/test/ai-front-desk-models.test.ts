/** Front-desk model getters live in ai/config.ts; Sonnet usage can be priced separately. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { getOwnerAgentModel, getSmsAgentModel } from "@/server/ai/config";
import { aiRatesPerMTok, modelFamily } from "@/server/ai/pricing";
import { getOwnerAgentModel as ownerChannelReexport } from "@/server/services/owner-channel/agent";

afterEach(() => vi.unstubAllEnvs());

describe("front-desk models", () => {
  it("default to claude-sonnet-5-5, env-overridable, one getter each", () => {
    vi.stubEnv("AI_MODEL_SMS_AGENT", "");
    vi.stubEnv("AI_MODEL_OWNER_AGENT", "");
    expect(getSmsAgentModel()).toBe("claude-sonnet-5-5");
    expect(getOwnerAgentModel()).toBe("claude-sonnet-5-5");
    vi.stubEnv("AI_MODEL_OWNER_AGENT", "claude-opus-5");
    expect(ownerChannelReexport()).toBe("claude-opus-5");
  });

  it("AI_PRICE_SONNET_* prices Sonnet calls without touching the Opus defaults", () => {
    for (const k of ["INPUT", "OUTPUT", "CACHE_READ", "CACHE_WRITE"]) {
      vi.stubEnv(`AI_PRICE_${k}_PER_MTOK`, "");
      vi.stubEnv(`AI_PRICE_SONNET_${k}_PER_MTOK`, "");
    }
    expect(modelFamily("claude-sonnet-5-5")).toBe("SONNET");
    expect(modelFamily("gpt-4.1")).toBeNull();
    // Unset family rates fall back to the defaults.
    expect(aiRatesPerMTok("claude-sonnet-5-5")).toEqual(aiRatesPerMTok());
    vi.stubEnv("AI_PRICE_SONNET_INPUT_PER_MTOK", "3");
    vi.stubEnv("AI_PRICE_SONNET_OUTPUT_PER_MTOK", "15");
    expect(aiRatesPerMTok("claude-sonnet-5-5")).toMatchObject({ input: 3, output: 15, cacheRead: 0.5 });
    expect(aiRatesPerMTok("claude-opus-5")).toMatchObject({ input: 5, output: 25 });
  });
});
