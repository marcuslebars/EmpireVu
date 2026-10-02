import { describe, expect, it } from "vitest";

import { ownerClockTime, prettyPhone } from "@/server/services/retell/call-summary";
import { looksAbandoned } from "@/server/services/retell/lead-adapter";
import { getRecipe } from "@/server/services/workflow-engine/recipes";
import { isSupportedWorkflowTrigger } from "@/server/services/workflow-engine/definitions";

// Parity with the A1 Marine Care site's owner texts and hung-up recovery rule
// (a1marinecare/src/lib/retell/webhook.ts + followups.ts).

describe("owner-text formats match the A1 Care site", () => {
  it("writes phones as 705-555-1234", () => {
    expect(prettyPhone("+17055551234")).toBe("705-555-1234");
    expect(prettyPhone("7055551234")).toBe("705-555-1234");
    expect(prettyPhone("")).toBe("unknown number");
    expect(prettyPhone("+447700900123")).toBe("+447700900123");
  });

  it("writes the call-started clock time as 2:05p.m. in the business zone", () => {
    expect(ownerClockTime(new Date("2026-10-02T18:05:00Z"), "America/Toronto")).toBe("2:05p.m.");
    expect(ownerClockTime(new Date("2026-10-02T13:30:00Z"), "America/Toronto")).toBe("9:30a.m.");
  });
});

const BASE = {
  direction: "inbound",
  fromNumber: "+17055551234",
  durationMs: 40_000,
  inVoicemail: false,
  disconnectionReason: "user_hangup",
  servicesRequested: [] as string[],
  callSummary: "The caller asked about shrink wrapping a 22 ft bowrider and hung up.",
  transcript: null,
};

describe("looksAbandoned (hung up before a quote)", () => {
  it("flags an inbound call about the service that just ended", () => {
    expect(looksAbandoned(BASE)).toBe(true);
    expect(looksAbandoned({ ...BASE, callSummary: null, servicesRequested: ["Winterization"] })).toBe(true);
    expect(looksAbandoned({ ...BASE, callSummary: null, transcript: "Agent: hi\nUser: how much to wrap my boat" })).toBe(true);
  });

  it("ignores short calls, voicemail, transfers, outbound calls and unrelated calls", () => {
    expect(looksAbandoned({ ...BASE, durationMs: 14_999 })).toBe(false);
    expect(looksAbandoned({ ...BASE, durationMs: null })).toBe(false);
    expect(looksAbandoned({ ...BASE, inVoicemail: true })).toBe(false);
    expect(looksAbandoned({ ...BASE, disconnectionReason: "call_transfer" })).toBe(false);
    expect(looksAbandoned({ ...BASE, direction: "outbound" })).toBe(false);
    expect(looksAbandoned({ ...BASE, fromNumber: null })).toBe(false);
    expect(looksAbandoned({ ...BASE, callSummary: "Asked about dock repairs." })).toBe(false);
  });

  it("treats a missing direction as inbound, like the Care site", () => {
    expect(looksAbandoned({ ...BASE, direction: null })).toBe(true);
  });
});

describe("new receptionist triggers + recipes", () => {
  it("are supported triggers", () => {
    for (const t of ["call.started", "call.abandoned", "quote.deposit_link_failed"]) expect(isSupportedWorkflowTrigger(t)).toBe(true);
  });

  it("are in the recipe catalog with the matching trigger", () => {
    expect(getRecipe("call-started-to-owner")?.trigger_event).toBe("call.started");
    expect(getRecipe("call-abandoned-recovery-text")?.trigger_event).toBe("call.abandoned");
    expect(getRecipe("deposit-link-failed-owner-alert")?.trigger_event).toBe("quote.deposit_link_failed");
  });
});
