/**
 * The AI staff (docs/ai-staff.md): roles that plug into the front desk without editing it.
 * Each role is one module (staff/<role>/index.ts) exporting a StaffRoleModule; the registry
 * (staff/registry.ts) merges them into the SMS agent, the owner-by-text agent, the approval
 * runner and the scheduler.
 *
 * IMPORT RULE: role modules may only `import type` from sms-agent/tools.ts and
 * owner-channel/tools.ts (those files import the registry at runtime — a value import back
 * would be a cycle).
 */
import type Anthropic from "@anthropic-ai/sdk";

import type { AdminClient, ApprovalDecision, ExecuteResult, OwnerApprovalRow } from "@/server/services/front-desk/contracts";
import type { AgentTool } from "@/server/services/sms-agent/tools";
import type { ToolRunState } from "@/server/services/owner-channel/tools";

export type StaffRole = "estimator" | "bookkeeper" | "dispatcher" | "marketer";

/**
 * Runs an owner_approvals row of a kind the role owns, once the owner decided (Y / N / expiry).
 * `decision.approved === false` covers both N and expiry (`decidedVia: "expiry"`) — tidy up
 * (tell the customer if one is waiting) and return. The owner channel already claimed the row
 * (status pending → approved/rejected/expired) and records the returned result on it, so the
 * executor only does the work and must be idempotent for retries (claim your own side
 * effects — e.g. a conditional update — before sending anything). `message` is texted to the
 * owner: one short line.
 */
export type RoleApprovalExecutor = (admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision) => Promise<ExecuteResult>;

/** A tool for the owner-by-text agent. `run` must never throw (return { error } instead). */
export interface RoleOwnerTool {
  tool: Anthropic.Messages.Tool;
  run(state: ToolRunState, input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** A background pass the scheduler runs every `intervalMs` (it is guarded: a throw is logged). */
export interface StaffSweep {
  name: string;
  intervalMs: number;
  run(admin: AdminClient, nowMs: number): Promise<void>;
}

export interface StaffRoleModule {
  role: StaffRole;
  /** owner_approvals.kind → executor. Kinds must be unique across roles and not a core kind. */
  approvalExecutors: Record<string, RoleApprovalExecutor>;
  /** Extra tools for the customer-facing SMS agent. Names must be unique. */
  agentTools: AgentTool<never>[];
  /** Lines appended to the SMS agent's system prompt (how/when to use agentTools). */
  agentPromptNotes: string[];
  /** Extra tools for the owner-by-text agent. */
  ownerTools: RoleOwnerTool[];
  /** Lines appended to the owner agent's rules. */
  ownerPromptNotes: string[];
  sweeps: StaffSweep[];
  /**
   * Is this role on for the company? Its agent/owner tools and prompt notes are only offered to
   * companies where it is (so a house org with the role off never sees them). Must never throw;
   * a role without it counts as on.
   */
  activeFor?: (admin: AdminClient, scope: { organizationId: string; companyId: string }) => Promise<boolean>;
}

export function emptyRole(role: StaffRole): StaffRoleModule {
  return { role, approvalExecutors: {}, agentTools: [], agentPromptNotes: [], ownerTools: [], ownerPromptNotes: [], sweeps: [] };
}
