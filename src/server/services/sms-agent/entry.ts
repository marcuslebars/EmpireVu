/**
 * The AI front desk's text conversations — entry point (docs/front-desk-ai.md, "Text conversations").
 *
 * runSmsAgentForInbound is called by the inbound SMS router for every customer text on a
 * company number (after STOP/START handling and owner detection). It decides whether to answer,
 * runs one agent turn, sends the reply through deliverMessage, and records the outcome.
 *
 * Skips (no reply): agent off for the company · AI not configured · contact opted out ·
 * conversation with the owner (takeover, 72h) or paused · empty / phone auto-reply / a plain
 * "ok thanks" that answers nothing · a text a finished turn already answered (queue retry).
 * Daily caps reached → hand off to the owner.
 *
 * One turn at a time per conversation (conversation.ts lease). The turn waits a few seconds so
 * rapid-fire texts are answered together, and after it finishes it checks for texts that came in
 * meanwhile and runs again for those.
 *
 * Never throws. Any failure → the conversation goes to the owner quietly (no half-baked text to
 * the customer) and the owner is alerted.
 */
import { isAIConfigured, type AiUsageMeta } from "@/server/ai/claude";
import { getSmsAgentModel } from "@/server/ai/config";
import type { AdminClient, InboundCustomerSms } from "@/server/services/front-desk/contracts";
import { recordAiUsageSafe } from "@/server/services/usage";
import { runAgentTurn, defaultModelClient, type ModelClient, type AgentTurnOutput } from "@/server/services/sms-agent/agent";
import { createApproval, defaultApprovalDeps, type ApprovalDeps } from "@/server/services/sms-agent/approvals";
import {
  claimTurn,
  effectiveState,
  ensureConversation,
  findConversation,
  mergeCollected,
  releaseTurn,
  updateConversation,
  type ConversationRow,
} from "@/server/services/sms-agent/conversation";
import { loadBusinessFacts, priceListAmounts, type BusinessFacts } from "@/server/services/sms-agent/facts";
import {
  ensureDisclosure,
  ensureLinks,
  extractAmountsCents,
  fitLength,
  isAcknowledgement,
  isAutoReply,
  mentionsPercentDeal,
  stripPlatformNames,
  toPlainText,
  unvouchedAmounts,
} from "@/server/services/sms-agent/guard";
import { countAiReplies, hasInboundAfter, loadHistory, newCustomerMessages, type LoggedMessage } from "@/server/services/sms-agent/history";
import { fetchMmsImages, type FetchedImage } from "@/server/services/sms-agent/media";
import { buildConversationTurn, buildSystemPrompt } from "@/server/services/sms-agent/prompt";
import { defaultAgentServices, withinOwnerHours, type AgentContact, type AgentServices, type CompanyRef } from "@/server/services/sms-agent/services";
import { loadSmsAgentSettings, smsAgentActive, smsAgentLimits, type SmsAgentLimits, type SmsAgentSettings } from "@/server/services/sms-agent/settings";
import { newTurnEffects, ownerLabel, type TurnEffects, type TurnState } from "@/server/services/sms-agent/tools";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export interface SmsAgentDeps {
  services: AgentServices;
  approvalDeps: ApprovalDeps;
  modelClient(): ModelClient;
  model(): string;
  fetchImages(media: LoggedMessage["media"]): Promise<FetchedImage[]>;
  loadFacts(admin: AdminClient, companyId: string): Promise<BusinessFacts>;
  recordUsage(input: { organizationId: string; companyId: string } & AiUsageMeta): Promise<void>;
  limits(): SmsAgentLimits;
  sleep(ms: number): Promise<void>;
  aiConfigured(): boolean;
}

export const defaultSmsAgentDeps: SmsAgentDeps = {
  services: defaultAgentServices,
  approvalDeps: defaultApprovalDeps,
  modelClient: defaultModelClient,
  model: getSmsAgentModel,
  fetchImages: (media) => fetchMmsImages(media),
  loadFacts: loadBusinessFacts,
  recordUsage: (input) => recordAiUsageSafe(input),
  limits: smsAgentLimits,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  aiConfigured: isAIConfigured,
};

export type SmsAgentSkipReason =
  | "disabled"
  | "ai_not_configured"
  | "no_contact"
  | "opted_out"
  | "owner"
  | "paused"
  | "closed"
  | "not_for_agent"
  | "already_handled"
  | "busy"
  | "capped"
  | "error";

export interface SmsAgentOutcome {
  replied: boolean;
  skipped?: SmsAgentSkipReason;
  handedOff?: boolean;
  turns?: number;
}

const CONTACT_COLUMNS =
  "id, organization_id, company_id, first_name, last_name, phone, email, notes, metadata, sms_opt_out_at, email_opt_out_at, sms_consent_at, consent_source";

async function loadContact(admin: AdminClient, sms: InboundCustomerSms): Promise<AgentContact | null> {
  const { data, error } = await (admin as Db)
    .from("contacts")
    .select(CONTACT_COLUMNS)
    .eq("organization_id", sms.organizationId)
    .eq("id", sms.contactId)
    .maybeSingle();
  if (error) throw error;
  const contact = data as AgentContact | null;
  return contact && contact.company_id === sms.companyId ? contact : null;
}

async function inboundCreatedAt(admin: AdminClient, sms: InboundCustomerSms): Promise<string> {
  if (sms.messageLogId) {
    const { data } = await (admin as Db)
      .from("message_log")
      .select("created_at")
      .eq("organization_id", sms.organizationId)
      .eq("id", sms.messageLogId)
      .maybeSingle();
    const at = (data as { created_at: string } | null)?.created_at;
    if (at) return at;
  }
  return sms.receivedAt;
}

function displayName(contact: AgentContact): string {
  const first = contact.first_name && !/^\+?\d[\d\s()-]{6,}$/.test(contact.first_name) ? contact.first_name : "";
  return [first, contact.last_name].filter(Boolean).join(" ") || contact.phone || "A customer";
}

function preview(text: string, max = 160): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export async function runSmsAgentForInbound(admin: AdminClient, sms: InboundCustomerSms): Promise<{ replied: boolean }> {
  return runSmsAgent(admin, sms, defaultSmsAgentDeps);
}

/** The full flow with injectable deps (tests). Never throws. */
export async function runSmsAgent(admin: AdminClient, sms: InboundCustomerSms, deps: SmsAgentDeps): Promise<SmsAgentOutcome> {
  try {
    return await runInner(admin, sms, deps);
  } catch (err) {
    console.error("[sms-agent] failed before the turn:", err instanceof Error ? err.message : err);
    return { replied: false, skipped: "error" };
  }
}

async function runInner(admin: AdminClient, sms: InboundCustomerSms, deps: SmsAgentDeps): Promise<SmsAgentOutcome> {
  const settings = await loadSmsAgentSettings(admin, sms.companyId);
  if (!settings || settings.organizationId !== sms.organizationId || !smsAgentActive(settings)) return { replied: false, skipped: "disabled" };
  if (!deps.aiConfigured()) return { replied: false, skipped: "ai_not_configured" };

  const contact = await loadContact(admin, sms);
  if (!contact) return { replied: false, skipped: "no_contact" };
  if (contact.sms_opt_out_at) return { replied: false, skipped: "opted_out" };

  const limits = deps.limits();
  const now = deps.services.now();
  const key = { organizationId: sms.organizationId, companyId: sms.companyId, contactId: sms.contactId };
  let conv = await ensureConversation(admin, key);
  const body = sms.body ?? "";
  const hasMedia = (sms.media ?? []).length > 0;

  const state = effectiveState(conv, now, limits.takeoverMs);
  if (state === "owner") return { replied: false, skipped: "owner" };
  if (state === "paused") return { replied: false, skipped: "paused" };
  if (!hasMedia && (!body.trim() || isAutoReply(body))) return { replied: false, skipped: "not_for_agent" };
  if (state === "closed") {
    if (!hasMedia && isAcknowledgement(body)) return { replied: false, skipped: "closed" };
  }
  if (conv.state !== state || state === "closed") {
    // A lapsed takeover, or a closed conversation the customer re-opened with a real message.
    await updateConversation(admin, conv.id, { state: "ai", owner_takeover_at: null });
    conv = { ...conv, state: "ai", owner_takeover_at: null };
  }

  const receivedAt = await inboundCreatedAt(admin, sms);
  if (conv.last_handled_inbound_at && Date.parse(conv.last_handled_inbound_at) >= Date.parse(receivedAt)) {
    return { replied: false, skipped: "already_handled" };
  }

  // Daily caps → the owner takes it from here.
  const counts = await countAiReplies(admin, key, now);
  if (counts.conversation >= limits.perConversationPerDay || counts.company >= limits.perCompanyPerDay) {
    const facts = await deps.loadFacts(admin, sms.companyId);
    const which = counts.conversation >= limits.perConversationPerDay ? "this conversation" : "today across your business";
    await handOff(admin, deps, facts, conv, contact, {
      reason: `the assistant hit its reply limit for ${which}`,
      customerText: body,
      tellCustomer: `Thanks for your patience. ${ownerLabel(facts) === "the owner" ? "Someone from the team" : ownerLabel(facts)} will follow up with you directly.`,
    });
    return { replied: true, skipped: "capped", handedOff: true };
  }

  const token = await claimTurn(admin, conv.id, now, limits.leaseMs);
  if (!token) return { replied: false, skipped: "busy" };

  let replied = false;
  let handedOff = false;
  let turns = 0;
  let currentToken: string | null = token;
  try {
    await deps.sleep(limits.coalesceMs);
    for (let round = 0; round < 3 && currentToken; round++) {
      const fresh = await findConversation(admin, key);
      if (!fresh) break;
      const freshState = effectiveState(fresh, deps.services.now(), limits.takeoverMs);
      if (freshState !== "ai" && freshState !== "closed") break; // the owner stepped in mid-wait
      const result = await runOneTurn(admin, deps, settings, fresh, contact);
      turns += result.ran ? 1 : 0;
      replied = replied || result.replied;
      handedOff = handedOff || result.handedOff;
      if (result.handedOff || result.failed) break;

      // Texts that arrived while we were working → another turn (unless someone else takes it).
      await releaseTurn(admin, conv.id, currentToken);
      currentToken = null;
      const after = await findConversation(admin, key);
      if (!after || !(await hasInboundAfter(admin, key, after.last_handled_inbound_at))) break;
      currentToken = await claimTurn(admin, conv.id, deps.services.now(), limits.leaseMs);
    }
  } finally {
    if (currentToken) await releaseTurn(admin, conv.id, currentToken);
  }
  return { replied, handedOff, turns };
}

interface TurnResult {
  ran: boolean;
  replied: boolean;
  handedOff: boolean;
  failed: boolean;
}

async function runOneTurn(
  admin: AdminClient,
  deps: SmsAgentDeps,
  settings: SmsAgentSettings,
  conv: ConversationRow,
  contact: AgentContact,
): Promise<TurnResult> {
  const limits = deps.limits();
  const history = await loadHistory(admin, { organizationId: conv.organization_id, contactId: conv.contact_id });
  const fresh = newCustomerMessages(history, conv.last_handled_inbound_at);
  if (fresh.length === 0) return { ran: false, replied: false, handedOff: false, failed: false };
  const newestAt = fresh[fresh.length - 1].at;
  const markHandled = (patch: Partial<ConversationRow> = {}) =>
    updateConversation(admin, conv.id, { last_handled_inbound_at: newestAt, last_inbound_at: newestAt, ...patch });

  // "ok thanks" after a statement (not a question) needs no answer.
  const lastOut = [...history].reverse().find((m) => m.from !== "customer");
  if (fresh.every((m) => isAcknowledgement(m.body) && m.pictures === 0) && !(lastOut?.body ?? "").includes("?")) {
    await markHandled();
    return { ran: false, replied: false, handedOff: false, failed: false };
  }

  let facts: BusinessFacts | null = null;
  const effects = newTurnEffects();
  let output: AgentTurnOutput | null = null;
  try {
    facts = await deps.loadFacts(admin, conv.company_id);
    const firstAiMessage = !conv.last_ai_reply_at && !history.some((m) => m.from === "assistant");
    const now = deps.services.now();
    const images = await deps.fetchImages(fresh.flatMap((m) => m.media));
    const turnState: TurnState = {
      admin,
      facts,
      settings,
      contact,
      conversation: conv,
      services: deps.services,
      approvalDeps: deps.approvalDeps,
      effects,
    };
    output = await runAgentTurn({
      state: turnState,
      system: buildSystemPrompt(facts, { autonomy: settings.autonomy, firstAiMessage, now }),
      userText: buildConversationTurn({
        customerName: displayName(contact) === contact.phone ? null : displayName(contact),
        customerPhone: contact.phone,
        collected: conv.collected,
        history,
        newMessages: fresh,
        summary: conv.summary,
      }),
      images,
      model: deps.model(),
      client: deps.modelClient(),
      maxIterations: limits.maxIterations,
      deadline: Date.now() + limits.turnTimeoutMs,
    });
    for (const u of output.usage) await deps.recordUsage({ organizationId: conv.organization_id, companyId: conv.company_id, ...u });

    if (output.stoppedReason !== "final") throw new Error(`agent stopped: ${output.stoppedReason}`);

    let reply = output.text?.trim() ?? "";
    const noReply = !reply || /^NO_REPLY\b/i.test(reply);
    if (noReply) reply = "";
    if (!reply && effects.handedOff) {
      reply = `Thanks for letting us know. ${ownerLabel(facts) === "the owner" ? "Someone from the team" : ownerLabel(facts)} will follow up with you directly.`;
    }
    if (!reply && (effects.links.length || effects.approvals.length)) {
      reply = effects.approvals.length ? `Let me check with ${ownerLabel(facts)} and get right back to you.` : "Here you go:";
    }

    if (reply) {
      reply = stripPlatformNames(toPlainText(reply), facts.businessName);
      // The money guard: only amounts the price list / tools / earlier business messages vouched for.
      const vouched = new Set<number>([...effects.allowedAmountsCents]);
      for (const m of history) if (m.from !== "customer") for (const c of extractAmountsCents(m.body)) vouched.add(c);
      if (settings.autonomy === "standard") for (const c of priceListAmounts(facts.priceList)) vouched.add(c);
      const badAmounts = unvouchedAmounts(reply, vouched);
      if ((badAmounts.length || mentionsPercentDeal(reply)) && effects.handedOff) {
        // Handing off anyway — don't let an invented number ride along.
        reply = `Thanks for letting us know. ${ownerLabel(facts) === "the owner" ? "Someone from the team" : ownerLabel(facts)} will follow up with you directly.`;
      } else if (badAmounts.length || mentionsPercentDeal(reply)) {
        const approval = await createApproval(
          admin,
          {
            organizationId: conv.organization_id,
            companyId: conv.company_id,
            contactId: contact.id,
            conversationId: conv.id,
            kind: "send_reply",
            summary: `${displayName(contact)}: OK to send "${preview(reply, 200)}"?`,
            payload: { replyText: reply, reason: badAmounts.length ? "price not on the price list" : "discount", customerName: displayName(contact) },
          },
          deps.approvalDeps,
        );
        effects.approvals.push({ id: approval.id, shortCode: approval.shortCode, kind: "send_reply" });
        effects.collected.approval_ids = [approval.id];
        effects.links = effects.links.filter((l) => !reply.includes(l));
        reply = `Good question - let me check with ${ownerLabel(facts)} and get right back to you.`;
      }
      if (firstAiMessage) reply = ensureDisclosure(reply, facts.businessName);
      reply = fitLength(ensureLinks(reply, effects.links), effects.links);
    }

    let sent = false;
    if (reply) {
      const delivery = await deps.services.textCustomer(admin, facts, contact, reply);
      if (delivery.status === "failed") throw new Error(`reply send failed: ${delivery.reason ?? "unknown"}`);
      sent = delivery.status === "sent";
      if (sent) {
        for (const q of effects.quotes) {
          await deps.services.recordQuoteEvent(admin, facts, q.quoteId, "deposit_link_sent", { channels: ["sms"], by: "sms_agent" });
        }
      }
    }

    const nowIso = deps.services.now().toISOString();
    const collected = mergeCollected(conv.collected, {
      ...effects.collected,
      photos: fresh.some((m) => m.pictures > 0) ? fresh.flatMap((m) => m.media.map((x) => x.url)) : undefined,
    });
    if (effects.handedOff) {
      await markHandled({
        state: "owner",
        owner_takeover_at: nowIso,
        ai_turns: conv.ai_turns + 1,
        last_ai_reply_at: sent ? nowIso : conv.last_ai_reply_at,
        collected,
        summary: summarize(contact, collected, effects, conv.summary),
        last_error: null,
      });
      await deps.services.alertOwner(
        admin,
        facts,
        `${effects.handedOff.urgent ? "URGENT - " : ""}${displayName(contact)} (${contact.phone ?? "no number"}) needs you: ${effects.handedOff.reason}. Their text: "${preview(fresh.map((m) => m.body).join(" / "))}". The assistant has stepped back for this customer.`,
      );
      return { ran: true, replied: sent, handedOff: true, failed: false };
    }

    await markHandled({
      state: effects.ended ? "closed" : "ai",
      ai_turns: conv.ai_turns + 1,
      last_ai_reply_at: sent ? nowIso : conv.last_ai_reply_at,
      collected,
      summary: summarize(contact, collected, effects, conv.summary),
      last_error: null,
    });
    if (effects.outcomes.length && withinOwnerHours(deps.services.now(), facts.timeZone)) {
      await deps.services.alertOwner(admin, facts, `${facts.businessName} assistant: ${effects.outcomes.join(" ")}`);
    }
    return { ran: true, replied: sent, handedOff: false, failed: false };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("[sms-agent] turn failed — handing to the owner:", reason);
    const ref: CompanyRef = facts ?? (await companyRef(admin, conv));
    await markHandled({ state: "owner", owner_takeover_at: deps.services.now().toISOString(), last_error: reason.slice(0, 500) }).catch(() => undefined);
    await deps.services.alertOwner(
      admin,
      ref,
      `${displayName(contact)} (${contact.phone ?? "no number"}) texted: "${preview(fresh.map((m) => m.body).join(" / "))}". The assistant couldn't answer this one, so it's yours - please reply to them.${effects.links.length ? ` (A link was made but not sent: ${effects.links.join(" ")})` : ""}`,
    );
    return { ran: true, replied: false, handedOff: true, failed: true };
  }
}

async function companyRef(admin: AdminClient, conv: ConversationRow): Promise<CompanyRef> {
  const { data } = await (admin as Db).from("companies").select("name").eq("id", conv.company_id).maybeSingle();
  return { organizationId: conv.organization_id, companyId: conv.company_id, businessName: (data as { name: string } | null)?.name ?? "Your business" };
}

/** Hand the conversation to the owner outside a model turn (caps). */
async function handOff(
  admin: AdminClient,
  deps: SmsAgentDeps,
  facts: BusinessFacts,
  conv: ConversationRow,
  contact: AgentContact,
  input: { reason: string; customerText: string; tellCustomer: string | null },
): Promise<void> {
  const nowIso = deps.services.now().toISOString();
  await updateConversation(admin, conv.id, { state: "owner", owner_takeover_at: nowIso, last_error: input.reason });
  if (input.tellCustomer) {
    try {
      await deps.services.textCustomer(admin, facts, contact, input.tellCustomer);
    } catch (err) {
      console.error("[sms-agent] hand-off text failed:", err instanceof Error ? err.message : err);
    }
  }
  await deps.services.alertOwner(
    admin,
    facts,
    `${displayName(contact)} (${contact.phone ?? "no number"}) needs you: ${input.reason}. Their text: "${preview(input.customerText)}".`,
  );
}

/** A short running summary for the owner channel and the weekly report. PURE. */
export function summarize(contact: AgentContact, collected: Record<string, unknown>, effects: TurnEffects, previous: string | null): string {
  const parts: string[] = [displayName(contact)];
  if (typeof collected.job === "string") parts.push(String(collected.job).slice(0, 80));
  if (typeof collected.address === "string") parts.push(String(collected.address).slice(0, 80));
  const q = effects.quotes.at(-1);
  if (q) parts.push(`quoted ${q.title} $${(q.subtotalCents / 100).toFixed(0)} + HST`);
  const b = effects.bookings.at(-1);
  if (b) parts.push(`booked ${b.label}`);
  for (const a of effects.approvals) parts.push(`waiting on owner (#${a.shortCode} ${a.kind})`);
  if (effects.handedOff) parts.push(`handed to owner: ${effects.handedOff.reason}`);
  if (effects.ended) parts.push("wrapped up");
  const line = parts.join(" · ");
  if (!q && !b && !effects.approvals.length && !effects.handedOff && previous) return previous;
  return line.slice(0, 400);
}
