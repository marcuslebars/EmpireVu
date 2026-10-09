/**
 * Settings → AI front desk → Text conversations: what the panel shows, and the owner's change
 * (merged into companies.ai_settings.sms_agent only — the other sections are left alone).
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { TenantServiceContext } from "@/server/services/shared";
import {
  loadSmsAgentSettings,
  mergeSmsAgentSettings,
  type SmsAgentAutonomy,
} from "@/server/services/sms-agent/settings";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export interface SmsAgentSettingsView {
  companyId: string;
  enabled: boolean;
  autonomy: SmsAgentAutonomy;
  /** On/off is the plan default (no explicit owner choice yet). */
  enabledIsDefault: boolean;
  /** The default for this org: on for CrankLeads accounts. */
  defaultEnabled: boolean;
  stats: {
    /** Conversations the AI replied in, last 30 days. */
    conversations30d: number;
    /** AI texts sent, last 30 days. */
    aiReplies30d: number;
    /** Conversations currently with the owner (hand-off / takeover). */
    withOwner: number;
    /** Approvals waiting on the owner. */
    pendingApprovals: number;
  };
}

/** Read via the caller's RLS client (members can read their org's rows). */
export async function getSmsAgentSettingsView(ctx: TenantServiceContext, companyId: string, now: Date = new Date()): Promise<SmsAgentSettingsView> {
  const db = ctx.supabase as unknown as Db;
  const settings = await loadSmsAgentSettings(db as AdminClient, companyId);
  if (!settings || settings.organizationId !== ctx.organizationId) throw new Error("Company not found.");
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const count = async (query: Db): Promise<number> => {
    const { count: n, error } = await query;
    if (error) return 0;
    return n ?? 0;
  };
  const [conversations30d, aiReplies30d, withOwner, pendingApprovals] = await Promise.all([
    count(
      db
        .from("sms_conversations")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", ctx.organizationId)
        .eq("company_id", companyId)
        .gte("last_ai_reply_at", since),
    ),
    count(
      db
        .from("message_log")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", ctx.organizationId)
        .eq("company_id", companyId)
        .eq("sent_by", "sms_agent")
        .eq("status", "sent")
        .gte("created_at", since),
    ),
    count(
      db
        .from("sms_conversations")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", ctx.organizationId)
        .eq("company_id", companyId)
        .eq("state", "owner"),
    ),
    count(
      db
        .from("owner_approvals")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", ctx.organizationId)
        .eq("company_id", companyId)
        .eq("status", "pending"),
    ),
  ]);
  return {
    companyId,
    enabled: settings.enabled,
    autonomy: settings.autonomy,
    enabledIsDefault: settings.enabledIsDefault,
    defaultEnabled: settings.crankleads,
    stats: { conversations30d, aiReplies30d, withOwner, pendingApprovals },
  };
}

import { updateAiSettings } from "@/server/services/front-desk/ai-settings-write";

/** Write with the service role (ai_settings isn't client-writable); the caller checked the role + company. */
export async function updateSmsAgentSettings(
  admin: AdminClient,
  organizationId: string,
  companyId: string,
  patch: { enabled?: boolean; autonomy?: SmsAgentAutonomy },
): Promise<void> {
  // Optimistic (companies.updated_at): a concurrent write to another section isn't clobbered.
  const written = await updateAiSettings(admin, { organizationId, companyId }, (current) => mergeSmsAgentSettings(current, patch) as Record<string, unknown>);
  if (!written) throw new Error("Company not found.");
}
