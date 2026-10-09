/**
 * Owner takeover: when a person texts the customer by hand (the app inbox composer, or the
 * owner's relay), the AI steps back. The conversation goes to state 'owner' for 72h, or until
 * the owner turns the AI back on ("AI back on for Dana" / the inbox toggle).
 *
 * Called by: inbox.ts sendContactMessage (after a manual SMS goes out), the owner channel's
 * relay and "AI back on" command, and the inbox "Take over" / "Let AI handle it" route.
 */
import { isAIConfigured } from "@/server/ai/claude";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import {
  effectiveState,
  ensureConversation,
  findConversation,
  takeoverEndsAt,
  updateConversation,
  type ConversationState,
} from "@/server/services/sms-agent/conversation";
import { loadSmsAgentSettings, smsAgentActive, smsAgentLimits } from "@/server/services/sms-agent/settings";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export interface ConversationStatus {
  /** The AI front desk is switched on for this company. */
  agentActive: boolean;
  /** Effective state ('ai' after a lapsed takeover). 'ai' when there's no conversation yet. */
  state: ConversationState;
  /** When a takeover lapses and the AI picks the conversation back up. */
  takeoverEndsAt: string | null;
  summary: string | null;
  aiTurns: number;
}

async function organizationOf(admin: AdminClient, companyId: string): Promise<string | null> {
  const { data } = await (admin as Db).from("companies").select("organization_id").eq("id", companyId).maybeSingle();
  return (data as { organization_id: string } | null)?.organization_id ?? null;
}

/**
 * A person replied by hand → the AI goes quiet for this customer for 72h. Never throws (it runs
 * after a message already went out). Returns false when nothing could be recorded.
 */
export async function markOwnerTakeover(
  admin: AdminClient,
  input: { companyId: string; contactId: string; at?: Date },
): Promise<boolean> {
  try {
    const organizationId = await organizationOf(admin, input.companyId);
    if (!organizationId) return false;
    const at = (input.at ?? new Date()).toISOString();
    const conv = await ensureConversation(
      admin,
      { organizationId, companyId: input.companyId, contactId: input.contactId },
      { state: "owner", owner_takeover_at: at },
    );
    if (conv.state !== "owner" || conv.owner_takeover_at !== at) {
      await updateConversation(admin, conv.id, { state: "owner", owner_takeover_at: at });
    }
    return true;
  } catch (err) {
    console.error("[sms-agent] markOwnerTakeover failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * "AI back on" (on=true): the AI handles this customer again. on=false pauses the AI for this
 * customer until it's turned back on (no 72h lapse).
 */
export async function setConversationAi(
  admin: AdminClient,
  input: { companyId: string; contactId: string; on: boolean },
): Promise<ConversationStatus | null> {
  const organizationId = await organizationOf(admin, input.companyId);
  if (!organizationId) return null;
  const conv = await ensureConversation(admin, { organizationId, companyId: input.companyId, contactId: input.contactId });
  await updateConversation(
    admin,
    conv.id,
    input.on ? { state: "ai", owner_takeover_at: null, last_error: null } : { state: "paused", owner_takeover_at: new Date().toISOString() },
  );
  return getConversationStatus(admin, { companyId: input.companyId, contactId: input.contactId });
}

/** What the inbox shows for one customer. Works on the caller's RLS client (members can read). */
export async function getConversationStatus(
  db: AdminClient,
  input: { companyId: string; contactId: string },
  now: Date = new Date(),
): Promise<ConversationStatus> {
  const [settings, conv] = await Promise.all([
    loadSmsAgentSettings(db, input.companyId),
    findConversation(db, input),
  ]);
  const takeoverMs = smsAgentLimits().takeoverMs;
  return {
    agentActive: Boolean(settings && smsAgentActive(settings)),
    state: conv ? effectiveState(conv, now, takeoverMs) : "ai",
    takeoverEndsAt: conv && effectiveState(conv, now, takeoverMs) === "owner" ? takeoverEndsAt(conv, takeoverMs) : null,
    summary: conv?.summary ?? null,
    aiTurns: conv?.ai_turns ?? 0,
  };
}

/**
 * Will the AI answer this customer's texts right now? Used to keep the owner's phone quiet
 * (the customer-text-to-owner relay skips when the AI is handling it). Best-effort: false on
 * any error, so the owner still gets the text.
 */
export async function isSmsAgentHandling(
  db: AdminClient,
  input: { companyId: string; contactId: string },
  now: Date = new Date(),
): Promise<boolean> {
  try {
    if (!isAIConfigured()) return false;
    const settings = await loadSmsAgentSettings(db, input.companyId);
    if (!settings || !smsAgentActive(settings)) return false;
    const { data: contact } = await (db as Db)
      .from("contacts")
      .select("sms_opt_out_at")
      .eq("id", input.contactId)
      .maybeSingle();
    if ((contact as { sms_opt_out_at: string | null } | null)?.sms_opt_out_at) return false;
    const conv = await findConversation(db, input);
    if (!conv) return true;
    const state = effectiveState(conv, now, smsAgentLimits().takeoverMs);
    return state === "ai" || state === "closed";
  } catch (err) {
    console.error("[sms-agent] handling check failed:", err instanceof Error ? err.message : err);
    return false;
  }
}
