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
import { SMS_AGENT_SENDER, type AdminClient, type InboundCustomerSms } from "@/server/services/front-desk/contracts";
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
  updateConversationIf,
  type ConversationRow,
} from "@/server/services/sms-agent/conversation";
import { loadBusinessFacts, priceListAmounts, type BusinessFacts } from "@/server/services/sms-agent/facts";
import { buildApprovalSummary, MAX_APPROVAL_REPLY_CHARS } from "@/server/services/front-desk/approval-text";
import {
  ensureDisclosure,
  ensureLinks,
  extractAmountsCents,
  fitLength,
  isAcknowledgement,
  isAutoReply,
  moneyGuard,
  stripPlatformNames,
  toPlainText,
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

function laterOf(a: string | null, b: string): string {
  return a && Date.parse(a) >= Date.parse(b) ? a : b;
}

/** Record that a customer text arrived (last_inbound_at only moves forward). */
async function stampInbound(admin: AdminClient, conv: ConversationRow, receivedAt: string): Promise<ConversationRow> {
  if (conv.last_inbound_at && Date.parse(conv.last_inbound_at) >= Date.parse(receivedAt)) return conv;
  await updateConversation(admin, conv.id, { last_inbound_at: receivedAt });
  return { ...conv, last_inbound_at: receivedAt };
}

/** The full flow with injectable deps (tests). Never throws. */
export async function runSmsAgent(admin: AdminClient, sms: InboundCustomerSms, deps: SmsAgentDeps): Promise<SmsAgentOutcome> {
  try {
    return await runInner(admin, sms, deps);
  } catch (err) {
    console.error("[sms-agent] failed before the turn:", err instanceof Error ? err.message : err);
    // Leave a trace the recovery sweep can pick up (when the agent is on for this company).
    try {
      const settings = await loadSmsAgentSettings(admin, sms.companyId);
      if (settings && smsAgentActive(settings)) {
        const conv = await ensureConversation(admin, { organizationId: sms.organizationId, companyId: sms.companyId, contactId: sms.contactId });
        await stampInbound(admin, conv, sms.receivedAt);
      }
    } catch {
      /* the sweep can't help if the DB is down; the error is logged above */
    }
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
  const receivedAt = await inboundCreatedAt(admin, sms);
  // Stamp the text as waiting BEFORE anything can fail or lose the lease race: the recovery
  // sweep (sweepUnansweredTexts) re-runs any 'ai' conversation whose newest text was never handled.
  conv = await stampInbound(admin, conv, receivedAt);
  const markSkipped = () => updateConversation(admin, conv.id, { last_handled_inbound_at: laterOf(conv.last_handled_inbound_at, receivedAt) });

  const state = effectiveState(conv, now, limits.takeoverMs);
  if (state === "owner") return { replied: false, skipped: "owner" };
  if (state === "paused") return { replied: false, skipped: "paused" };
  if (!hasMedia && (!body.trim() || isAutoReply(body))) {
    await markSkipped();
    return { replied: false, skipped: "not_for_agent" };
  }
  if (state === "closed") {
    if (!hasMedia && isAcknowledgement(body)) {
      await markSkipped();
      return { replied: false, skipped: "closed" };
    }
  }
  if (conv.state !== state || state === "closed") {
    // A lapsed takeover, or a closed conversation the customer re-opened with a real message.
    await updateConversation(admin, conv.id, { state: "ai", owner_takeover_at: null });
    conv = { ...conv, state: "ai", owner_takeover_at: null };
  }

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
      // More texts came in. Take the lease again (if another worker took it, that worker answers
      // them). After the last round, anything still unanswered is stamped (last_inbound_at >
      // last_handled_inbound_at) and the recovery sweep picks it up — it is never just dropped.
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
  /** The owner may have taken over while the model was thinking: never overwrite that. */
  const ownerTookOver = async (): Promise<boolean> => {
    const now = await findConversation(admin, { companyId: conv.company_id, contactId: conv.contact_id });
    if (!now) return true;
    return now.state !== conv.state || (now.owner_takeover_at ?? null) !== (conv.owner_takeover_at ?? null);
  };
  /** Record the turn only if the conversation is still the AI's; otherwise just mark the texts handled. */
  const finishIfStillOurs = async (patch: Partial<ConversationRow>): Promise<boolean> => {
    const ok = await updateConversationIf(admin, conv.id, conv, { last_handled_inbound_at: newestAt, last_inbound_at: newestAt, ...patch });
    if (!ok) {
      await updateConversation(admin, conv.id, {
        last_handled_inbound_at: newestAt,
        ...(patch.last_ai_reply_at ? { last_ai_reply_at: patch.last_ai_reply_at } : {}),
        ...(patch.collected ? { collected: patch.collected } : {}),
      });
    }
    return ok;
  };

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
    // The texting AI's first text discloses it's automated — even after a phone-AI follow-up
    // (that one went out under the business's name after a call that disclosed it).
    const firstAiMessage = !conv.last_ai_reply_at && !history.some((m) => m.from === "assistant" && m.sentBy === SMS_AGENT_SENDER);
    const now = deps.services.now();
    const images = await deps.fetchImages(fresh.flatMap((m) => m.media));
    const historyAmounts = settings.autonomy === "ask_first" ? [] : history.filter((m) => m.from !== "customer").flatMap((m) => extractAmountsCents(m.body));
    const turnState: TurnState = {
      admin,
      facts,
      settings,
      contact,
      conversation: conv,
      services: deps.services,
      approvalDeps: deps.approvalDeps,
      effects,
      customerText: fresh.map((m) => m.body).filter(Boolean).join(" / ") || null,
      historyAmountsCents: historyAmounts,
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
      const handOffLine = `Thanks for letting us know. ${ownerLabel(facts) === "the owner" ? "Someone from the team" : ownerLabel(facts)} will follow up with you directly.`;
      // The money guard: only amounts the price list / tools / earlier business messages vouched
      // for, and no deal of any kind. Ask-first: no price statement at all without the owner.
      const vouched = new Set<number>();
      if (settings.autonomy === "standard") {
        for (const c of effects.allowedAmountsCents) vouched.add(c);
        for (const c of historyAmounts) vouched.add(c);
        for (const c of priceListAmounts(facts.priceList)) vouched.add(c);
      }
      const money = moneyGuard(reply, vouched);
      if (money.reasons.length && effects.handedOff) {
        // Handing off anyway — don't let an invented number ride along.
        reply = handOffLine;
      } else if (money.reasons.length) {
        const allowed = [...effects.links, facts.bookingUrl, facts.website].filter((x): x is string => Boolean(x));
        const draft = ensureLinks(reply, effects.links.filter((l) => reply.includes(l)), allowed);
        if (draft.length > MAX_APPROVAL_REPLY_CHARS) {
          // Too long to put in front of the owner word for word — it's theirs to answer.
          effects.handedOff = {
            reason: `the assistant wanted to send a price or deal it can't vouch for (${money.reasons.join("; ")}). Its draft: "${preview(draft, 200)}"`,
            urgent: false,
          };
          reply = handOffLine;
        } else {
          const approval = await createApproval(
            admin,
            {
              organizationId: conv.organization_id,
              companyId: conv.company_id,
              contactId: contact.id,
              conversationId: conv.id,
              kind: "send_reply",
              summary: buildApprovalSummary({
                kind: "send_reply",
                customerName: displayName(contact),
                customerPhone: contact.phone,
                customerText: fresh.map((m) => m.body).join(" / "),
                replyText: draft,
                moneyFlags: money.reasons,
              }),
              payload: { replyText: draft, reason: money.reasons.join("; "), moneyFlags: money.reasons, customerName: displayName(contact) },
            },
            deps.approvalDeps,
          );
          effects.approvals.push({ id: approval.id, shortCode: approval.shortCode, kind: "send_reply" });
          effects.collected.approval_ids = [approval.id];
          effects.links = effects.links.filter((l) => !draft.includes(l));
          reply = `Good question - let me check with ${ownerLabel(facts)} and get right back to you.`;
        }
      }
      if (firstAiMessage) reply = ensureDisclosure(reply, facts.businessName);
      const allowedLinks = [facts.bookingUrl, facts.website].filter((x): x is string => Boolean(x));
      reply = fitLength(ensureLinks(reply, effects.links, allowedLinks), effects.links);
    }

    // The owner stepped in while the model was working (they texted the customer, or hit
    // "Take over"): drop the AI's reply silently and leave the conversation with them.
    if (await ownerTookOver()) {
      await updateConversation(admin, conv.id, { last_handled_inbound_at: newestAt });
      return { ran: true, replied: false, handedOff: false, failed: false };
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

    // Conditional: a takeover that landed between the send and here wins (state stays 'owner').
    await finishIfStillOurs({
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
  // Keep what the phone AI recorded about the customer's calls (voice/post-call.ts seedConversation).
  const callLines = (previous ?? "").split("\n").filter((l) => l.startsWith("Phone call ")).slice(-2);
  return [...callLines, line.slice(0, 400)].join("\n");
}

// ── Recovery: no customer text is silently lost ─────────────────────────────────

/** A text unanswered this long (and with no turn running) is retried by the sweep. */
export const RECOVERY_GRACE_MS = 2 * 60_000;
/** Retries per unanswered text before the owner is told instead. */
export const RECOVERY_MAX_ATTEMPTS = 2;

interface RecoveryRow extends ConversationRow {
  recovery_attempts?: number | null;
  recovery_inbound_at?: string | null;
  recovery_alerted_at?: string | null;
}

/**
 * Scheduler pass: conversations in state 'ai' whose newest customer text was never handled
 * (last_inbound_at > last_handled_inbound_at), with no turn running (lease expired) and older
 * than ~2 minutes — a crashed worker, a pre-turn error, a turn loop that ran out of rounds. Each
 * gets the turn re-run (claimed per text, at most RECOVERY_MAX_ATTEMPTS times); after that the
 * owner is told once and the conversation is theirs. Never throws.
 */
export async function sweepUnansweredTexts(admin: AdminClient, nowMs: number = Date.now(), deps: SmsAgentDeps = defaultSmsAgentDeps): Promise<{ retried: number; alerted: number }> {
  let retried = 0;
  let alerted = 0;
  try {
    const nowIso = new Date(nowMs).toISOString();
    const { data, error } = await (admin as Db)
      .from("sms_conversations")
      .select("*")
      .eq("state", "ai")
      .not("last_inbound_at", "is", null)
      .lt("last_inbound_at", new Date(nowMs - RECOVERY_GRACE_MS).toISOString())
      .gt("last_inbound_at", new Date(nowMs - 24 * 3_600_000).toISOString())
      .lt("lock_until", nowIso)
      .order("last_inbound_at", { ascending: true })
      .limit(25);
    if (error) throw error;
    const rows = ((data ?? []) as RecoveryRow[]).filter(
      (r) => r.last_inbound_at && (!r.last_handled_inbound_at || Date.parse(r.last_handled_inbound_at) < Date.parse(r.last_inbound_at)),
    );
    for (const row of rows) {
      const sameText = row.recovery_inbound_at === row.last_inbound_at;
      const attempts = sameText ? Number(row.recovery_attempts ?? 0) : 0;
      if (attempts >= RECOVERY_MAX_ATTEMPTS) {
        if (sameText && row.recovery_alerted_at) continue;
        // Claim the alert so two workers don't both tell the owner.
        const { data: claimed } = await (admin as Db)
          .from("sms_conversations")
          .update({ recovery_alerted_at: nowIso, state: "owner", owner_takeover_at: nowIso, last_error: "assistant couldn't answer (recovery gave up)" })
          .eq("id", row.id)
          .eq("state", "ai")
          .is("recovery_alerted_at", null)
          .select("id");
        if (((claimed ?? []) as unknown[]).length !== 1) continue;
        const ref = await companyRef(admin, row);
        const { data: contact } = await (admin as Db).from("contacts").select("first_name, last_name, phone").eq("id", row.contact_id).maybeSingle();
        const c = contact as { first_name: string | null; last_name: string | null; phone: string | null } | null;
        const who = [c?.first_name && !/^\+?\d/.test(c.first_name) ? c.first_name : null, c?.last_name].filter(Boolean).join(" ") || c?.phone || "A customer";
        await deps.services.alertOwner(admin, ref, `${who}${c?.phone ? ` (${c.phone})` : ""} texted and the assistant couldn't answer, so it's yours - please reply to them.`);
        alerted++;
        continue;
      }
      // Claim this retry (attempt counter for THIS text) with a conditional update.
      let claim = (admin as Db)
        .from("sms_conversations")
        .update({ recovery_attempts: attempts + 1, recovery_inbound_at: row.last_inbound_at, ...(sameText ? {} : { recovery_alerted_at: null }) })
        .eq("id", row.id)
        .lt("lock_until", nowIso);
      claim = sameText ? claim.eq("recovery_attempts", row.recovery_attempts ?? 0) : claim;
      const { data: got } = await claim.select("id");
      if (((got ?? []) as unknown[]).length !== 1) continue;
      const { data: msgs } = await (admin as Db)
        .from("message_log")
        .select("id, body, created_at, provider_ref")
        .eq("organization_id", row.organization_id)
        .eq("contact_id", row.contact_id)
        .eq("direction", "inbound")
        .order("created_at", { ascending: false })
        .limit(1);
      const last = ((msgs ?? []) as Array<{ id: string; body: string | null; created_at: string }>)[0];
      if (!last) continue;
      await runSmsAgent(
        admin,
        {
          organizationId: row.organization_id,
          companyId: row.company_id,
          contactId: row.contact_id,
          messageLogId: last.id,
          from: "",
          to: "",
          body: last.body ?? "",
          media: [],
          receivedAt: last.created_at,
        },
        deps,
      );
      retried++;
    }
  } catch (err) {
    console.error("[sms-agent] recovery sweep failed:", err instanceof Error ? err.message : err);
  }
  return { retried, alerted };
}
