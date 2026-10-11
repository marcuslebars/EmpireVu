import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StaffSweep } from "@/server/services/staff/types";

const { sweeps } = vi.hoisted(() => ({ sweeps: [] as StaffSweep[] }));
vi.mock("@/server/services/staff/marketer", async () => {
  const { emptyRole } = await import("@/server/services/staff/types");
  return { marketerRole: { ...emptyRole("marketer"), sweeps, approvalExecutors: { win_back_campaign: vi.fn(async () => ({ ok: true, message: "Sent." })) } } };
});

import { AGENT_TOOLS } from "@/server/services/sms-agent/tools";
import { OWNER_TOOLS } from "@/server/services/owner-channel/tools";
import { registryProblems, resetStaffSweepClock, roleApprovalExecutor, runStaffSweeps } from "@/server/services/staff/registry";

beforeEach(() => {
  sweeps.length = 0;
  resetStaffSweepClock();
});

describe("AI staff registry", () => {
  it("merged roles have no duplicate kinds, tools or sweeps", () => {
    expect(registryProblems(AGENT_TOOLS.map((t) => t.name), OWNER_TOOLS.map((t) => t.name))).toEqual([]);
  });

  it("routes a role's approval kind to its executor; core kinds never go to a role", () => {
    expect(roleApprovalExecutor("win_back_campaign")).toBeTypeOf("function");
    expect(roleApprovalExecutor("send_quote")).toBeNull();
    expect(roleApprovalExecutor("owner_command")).toBeNull();
    expect(roleApprovalExecutor("nobody_owns_this")).toBeNull();
  });

  it("sweeps are throttled per interval and a failing sweep doesn't stop the others", async () => {
    const ran: string[] = [];
    sweeps.push(
      { name: "boom", intervalMs: 60_000, run: async () => { ran.push("boom"); throw new Error("x"); } },
      { name: "ok", intervalMs: 60_000, run: async () => { ran.push("ok"); } },
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runStaffSweeps({} as never, 1_000_000);
    await runStaffSweeps({} as never, 1_030_000); // too soon
    await runStaffSweeps({} as never, 1_061_000);
    expect(ran).toEqual(["boom", "ok", "boom", "ok"]);
    err.mockRestore();
  });
});
