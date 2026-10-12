/**
 * Module load order: no role module may (statically) reach the staff registry. It used to, via
 * role → owner-channel/notify → owner-channel/approvals → (registry, and sms-agent/approved →
 * sms-agent/tools → registry) → role index, so a route that loads a role module first ran the
 * role's index before that module's exports existed. Found by the Phase 2 e2e run
 * (scripts/e2e-dfy/staff.ts): the marketing settings route (view → campaigns → deps) answered
 * 500 with "Cannot access 'defaultMarketerDeps' before initialization" (and, in vitest, filed the
 * marketing_campaign executor under the key "undefined"). Fixed by loading the registry lazily in
 * owner-channel/approvals.ts and moving ownerLabel into sms-agent/facts.ts.
 *
 * Every entry is imported first in a fresh module graph (vi.resetModules), then the merged
 * registry must match the one built when the registry itself loads first.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const SRC = join(__dirname, "..");

function filesUnder(dir: string, match: (f: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, match));
    else if (match(full)) out.push(full);
  }
  return out;
}

const STAFF_FILES = filesUnder(join(SRC, "server/services/staff"), (f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
const ROUTES = filesUnder(join(SRC, "app/api/organizations/[organizationId]/companies/[companyId]/ai-settings"), (f) => f.endsWith("route.ts"));
const ENTRIES = [...STAFF_FILES, ...ROUTES].map((f) => relative(SRC, f));

interface Shape {
  kinds: string[];
  agentTools: string[];
  ownerTools: string[];
  sweeps: string[];
}

async function registryShape(): Promise<Shape> {
  const reg = await import("@/server/services/staff/registry");
  const roles = reg.staffRoles();
  return {
    kinds: roles.flatMap((r) => Object.keys(r.approvalExecutors)).sort(),
    agentTools: reg.roleAgentTools().map((t) => String(t.name)).sort(),
    ownerTools: reg.roleOwnerTools().map((t) => String(t.tool?.name)).sort(),
    sweeps: roles.flatMap((r) => r.sweeps.map((s) => String(s.name))).sort(),
  };
}

describe("staff modules load from any entry point", () => {
  let baseline: Shape;

  beforeEach(() => {
    vi.resetModules();
  });

  it("baseline (registry first) has every role's kinds, tools and sweeps", async () => {
    baseline = await registryShape();
    expect(baseline.kinds).toEqual(
      expect.arrayContaining(["ai_estimate", "payment_plan", "weather_reschedule", "fill_gap", "bulk_reschedule", "marketing_campaign", "review_reply", "google_post"]),
    );
    expect(baseline.ownerTools).toEqual(expect.arrayContaining(["pending_estimates", "who_owes_me", "weather_outlook", "start_win_back"]));
    for (const list of Object.values(baseline)) expect(list).not.toContain("undefined");
    // The first cold load of the whole module graph takes ~4.5 s alone, more under the full suite.
  }, 30_000);

  for (const entry of ENTRIES) {
    it(`loading ${entry} first gives the same registry`, async () => {
      await expect(import(/* @vite-ignore */ join(SRC, entry))).resolves.toBeTruthy();
      expect(await registryShape()).toEqual(baseline);
    });
  }
});
