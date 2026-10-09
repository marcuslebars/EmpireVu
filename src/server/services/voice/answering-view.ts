// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): Settings → AI front desk → Call answering. The route
// checks org membership (owner/admin for writes) and that the company belongs to the org on
// the caller's RLS client FIRST; only then does this read/write that one company's row with
// the service role (companies.ai_settings is not client-writable). Writes merge ONLY
// ai_settings.call_answering.
// ─────────────────────────────────────────────────────────────────────────────
import { toJson } from "@/server/db/json";
import { receptionistBeginMessage } from "@/server/services/retell/provision";
import { getAiAnswerConfig, loadAnsweringState } from "@/server/services/voice/ai-answer";
import { mergeCallAnsweringSettings, type CallAnsweringMode, type CallAnsweringPatch } from "@/server/services/voice/answering-settings";
import { MESSAGE_AGENT_BEGIN_MESSAGE } from "@/server/services/voice/message-agent";
import { loadMinuteAllowance, type MinuteAllowance } from "@/server/services/voice/minutes";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export interface CallAnsweringView {
  companyId: string;
  companyName: string;
  mode: CallAnsweringMode;
  modeExplicit: boolean;
  includedMinutes: number;
  /** What this month looks like (Front Desk: the plan's org-wide allowance). */
  allowance: MinuteAllowance;
  /** "message" (takes a message) or "receptionist" (Front Desk: quotes + books). */
  agentKind: "message" | "receptionist";
  /** The deployment has Retell wired (otherwise calls go to voicemail whatever the mode). */
  available: boolean;
  preview: { greeting: string; collects: string[]; never: string[]; afterCall: string[] };
}

export async function getCallAnsweringView(admin: AdminClient, organizationId: string, companyId: string, now: Date = new Date()): Promise<CallAnsweringView | null> {
  const state = await loadAnsweringState(admin, organizationId, companyId);
  if (!state) return null;
  const frontDesk = state.org.crankleads_tier === "front_desk" || state.org.plan === "front_desk";
  const allowance = await loadMinuteAllowance(
    admin,
    { organizationId, companyId, tier: state.org.crankleads_tier, plan: state.org.plan, includedMinutes: state.settings.includedMinutes },
    now,
  );
  const config = getAiAnswerConfig();
  const name = state.company.name;
  const agentKind = frontDesk ? "receptionist" : "message";
  return {
    companyId,
    companyName: name,
    mode: state.settings.mode,
    modeExplicit: state.settings.modeExplicit,
    includedMinutes: state.settings.includedMinutes,
    allowance,
    agentKind,
    available: config.enabled && Boolean(config.apiKey && config.tokenSecret && (config.messageAgentId || frontDesk)),
    preview: {
      greeting: agentKind === "receptionist" ? receptionistBeginMessage(name) : MESSAGE_AGENT_BEGIN_MESSAGE.replace("{{company_name}}", name),
      collects:
        agentKind === "receptionist"
          ? ["What they need", "Their name and best number", "A price from your price list (texted as a quote)", "A booking, when you have open slots"]
          : ["What they need", "Their name", "The best number to call back", "The address or town", "How urgent it is"],
      never:
        agentKind === "receptionist"
          ? ["Make up a price that isn't on your price list", "Offer a time that isn't open on your calendar"]
          : ["Give prices or estimates", "Promise a time or a guarantee"],
      afterCall: [
        "You get a text with a short summary (emergencies alert you right away)",
        "The caller gets one text from your number: your booking link or \"we'll call you back\"",
        "If the AI can't pick up, or your minutes run out, callers get your voicemail and the usual text-back",
      ],
    },
  };
}

import { updateAiSettings } from "@/server/services/front-desk/ai-settings-write";

/** Merge ONLY the call_answering section; returns the fresh view. */
export async function updateCallAnswering(
  admin: AdminClient,
  organizationId: string,
  companyId: string,
  patch: CallAnsweringPatch,
): Promise<CallAnsweringView | null> {
  // Optimistic (companies.updated_at): a concurrent write to another section isn't clobbered.
  const written = await updateAiSettings(admin, { organizationId, companyId }, (current) => mergeCallAnsweringSettings(current, patch) as Record<string, unknown>);
  if (!written) return null;
  return getCallAnsweringView(admin, organizationId, companyId);
}
