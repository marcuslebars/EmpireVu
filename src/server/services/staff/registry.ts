/**
 * Merges the AI staff role modules (staff/types.ts) for the front desk's hooks:
 * sms-agent/tools.ts (allAgentTools), sms-agent/entry.ts (prompt notes), owner-channel
 * (tools, prompt notes, approval runner) and the scheduler (runStaffSweeps).
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { bookkeeperRole } from "@/server/services/staff/bookkeeper";
import { dispatcherRole } from "@/server/services/staff/dispatcher";
import { estimatorRole } from "@/server/services/staff/estimator";
import { marketerRole } from "@/server/services/staff/marketer";
import { importerRole } from "@/server/services/staff/importer";
import { officeManagerRole } from "@/server/services/staff/office-manager";
import { portingRole } from "@/server/services/staff/porting";
import { recruiterRole } from "@/server/services/staff/recruiter";
import type { RoleApprovalExecutor, RoleOwnerTool, StaffRoleModule } from "@/server/services/staff/types";
import type { AgentTool } from "@/server/services/sms-agent/tools";

/** Kinds the front desk itself owns — a role may not claim them. */
export const CORE_APPROVAL_KINDS = new Set(["send_quote", "custom_price", "book_job", "send_reply", "callback", "owner_command"]);

export function staffRoles(): StaffRoleModule[] {
  return [estimatorRole, bookkeeperRole, dispatcherRole, marketerRole, officeManagerRole, importerRole, portingRole, recruiterRole];
}

/** The roles switched on for one company (a failing activeFor counts as off). */
export async function activeRolesFor(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<StaffRoleModule[]> {
  const checks = await Promise.all(
    staffRoles().map(async (role) => {
      if (!role.activeFor) return true;
      try {
        return await role.activeFor(admin, scope);
      } catch {
        return false;
      }
    }),
  );
  return staffRoles().filter((_, i) => checks[i]);
}

export function roleApprovalExecutor(kind: string): RoleApprovalExecutor | null {
  if (CORE_APPROVAL_KINDS.has(kind)) return null;
  for (const role of staffRoles()) {
    const fn = role.approvalExecutors[kind];
    if (fn) return fn;
  }
  return null;
}

export function roleAgentTools(): AgentTool<never>[] {
  return staffRoles().flatMap((r) => r.agentTools);
}

export function roleAgentPromptNotes(): string[] {
  return staffRoles().flatMap((r) => r.agentPromptNotes);
}

export function roleOwnerTools(): RoleOwnerTool[] {
  return staffRoles().flatMap((r) => r.ownerTools);
}

export function roleOwnerPromptNotes(): string[] {
  return staffRoles().flatMap((r) => r.ownerPromptNotes);
}

/** Problems with the merged roles (duplicate kinds/tools/sweeps). Empty when healthy; a test asserts it. */
export function registryProblems(coreAgentTools: string[], coreOwnerTools: string[]): string[] {
  const problems: string[] = [];
  const seen = (label: string, names: string[], reserved: string[]) => {
    const all = new Set(reserved);
    for (const n of names) {
      if (all.has(n)) problems.push(`duplicate ${label}: ${n}`);
      all.add(n);
    }
  };
  seen("approval kind", staffRoles().flatMap((r) => Object.keys(r.approvalExecutors)), [...CORE_APPROVAL_KINDS]);
  seen("SMS agent tool", roleAgentTools().map((t) => t.name), coreAgentTools);
  seen("owner tool", roleOwnerTools().map((t) => t.tool.name), coreOwnerTools);
  seen("sweep", staffRoles().flatMap((r) => r.sweeps.map((s) => s.name)), []);
  return problems;
}

const lastRunMs = new Map<string, number>();

/** Run every role sweep whose interval has passed. Each is isolated: a failure is logged, never thrown. */
export async function runStaffSweeps(admin: AdminClient, nowMs: number): Promise<void> {
  for (const role of staffRoles()) {
    for (const sweep of role.sweeps) {
      const key = `${role.role}:${sweep.name}`;
      if (nowMs - (lastRunMs.get(key) ?? 0) < sweep.intervalMs) continue;
      lastRunMs.set(key, nowMs);
      try {
        await sweep.run(admin, nowMs);
      } catch (error) {
        console.error(`[staff] ${key} failed`, error instanceof Error ? error.message : error);
      }
    }
  }
}

/** Test hook: forget sweep throttling. */
export function resetStaffSweepClock(): void {
  lastRunMs.clear();
}
