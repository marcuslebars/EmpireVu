/**
 * The done-for-you scheduler registrations (workflow-engine/scheduler.ts → runDoneForYouPasses):
 * each part runs once per tick, in buyer order, and one failing (even throwing, which they
 * shouldn't) never stops the others. Throttling lives in the owning modules (tested there);
 * the follow-up pass is throttled here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as string[], fail: new Set<string>() }));

function step(name: string) {
  return async () => {
    h.calls.push(name);
    if (h.fail.has(name)) throw new Error(`${name} exploded`);
    return null;
  };
}

vi.mock("@/server/services/dfy/intake", () => ({ processPendingIntakeSends: step("intake") }));
vi.mock("@/server/services/dfy/enrich", () => ({ processPendingEnrichments: step("enrich") }));
vi.mock("@/server/services/dfy/orchestrator", () => ({ runDoneForYouSweep: step("switch-on") }));
vi.mock("@/server/services/dfy/site-generator", () => ({ runGeneratedSitesPass: step("sites") }));
vi.mock("@/server/services/crankleads/setup-followups", () => ({ processSetupFollowups: step("follow-ups"), SETUP_FOLLOWUP_INTERVAL_MS: 300_000 }));

import { runDoneForYouPasses } from "@/server/services/workflow-engine/scheduler";

const T0 = Date.parse("2026-10-08T14:00:00Z");

beforeEach(() => {
  h.calls = [];
  h.fail = new Set();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("runDoneForYouPasses", () => {
  it("runs every part once, in buyer order; the follow-up pass is throttled to every 5 minutes", async () => {
    await runDoneForYouPasses({} as never, T0);
    expect(h.calls).toEqual(["intake", "enrich", "switch-on", "sites", "follow-ups"]);
    h.calls = [];
    await runDoneForYouPasses({} as never, T0 + 60_000);
    expect(h.calls).toEqual(["intake", "enrich", "switch-on", "sites"]);
    h.calls = [];
    await runDoneForYouPasses({} as never, T0 + 300_000);
    expect(h.calls).toContain("follow-ups");
  });

  it("a part that throws never stops the others (and the pass itself never throws)", async () => {
    h.fail = new Set(["intake", "enrich", "switch-on", "sites"]);
    await expect(runDoneForYouPasses({} as never, T0 + 3_600_000)).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 0)); // the un-awaited enrichment's rejection is caught
    expect(h.calls).toEqual(["intake", "enrich", "switch-on", "sites", "follow-ups"]);
  });
});
