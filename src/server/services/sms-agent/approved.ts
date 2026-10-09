/**
 * Runs an approval once the owner has decided. Approved → do it (send the quote, book the job,
 * send the reply…) and text the customer; rejected → a polite message to the customer and the
 * conversation goes to the owner. Called by the owner channel.
 *
 * Idempotent per approval id: the first call claims the row (execution_claimed_at, a
 * conditional update) and records the outcome on it (status executed / failed / rejected /
 * expired + result); a repeat call returns the recorded message without doing anything again.
 *
 * Owner notes are read conservatively: "$700", "700", "Y but $700 + HST" set a price; anything
 * that isn't clearly one price ("700 or 800", "$50/hr", "10% off", "700 incl tax") → ok:false
 * with a question back to the owner, and the approval stays pending so they can answer again.
 */
import type { AdminClient, ApprovalDecision, ExecuteResult, OwnerApprovalRow } from "@/server/services/front-desk/contracts";
import { updateConversation, findConversation, mergeCollected } from "@/server/services/sms-agent/conversation";
import { loadBusinessFacts, type BusinessFacts } from "@/server/services/sms-agent/facts";
import { extractUrls, finalizeCustomerText } from "@/server/services/sms-agent/guard";
import { defaultAgentServices, type AgentContact, type AgentServices, type QuoteLine } from "@/server/services/sms-agent/services";
import { ownerLabel } from "@/server/services/sms-agent/tools";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export interface ApprovedActionDeps {
  services: AgentServices;
  loadFacts(admin: AdminClient, companyId: string): Promise<BusinessFacts>;
}

export const defaultApprovedActionDeps: ApprovedActionDeps = {
  services: defaultAgentServices,
  loadFacts: loadBusinessFacts,
};

// ── owner-note parsing ──────────────────────────────────────────────────────────

export type ParsedNote =
  | { kind: "none" }
  | { kind: "price"; cents: number }
  | { kind: "ambiguous"; why: string }
  | { kind: "text"; text: string };

const FILLER = /\b(y|yes|yep|ok|okay|sure|but|make it|do|at|for|price|total|charge|it's|its|it|is|send|quote|them|the|go with|plus|hst|tax|before|pre|please|pls|instead)\b/gi;

/**
 * PURE. "$700" / "700" / "but $1,200.50 + HST" → a price in cents (before HST). Several numbers,
 * rates ("/hr", "per"), percentages, "incl tax", or a non-price instruction → ambiguous.
 */
export function parseOwnerNote(note: string | null | undefined): ParsedNote {
  const text = (note ?? "").trim();
  if (!text) return { kind: "none" };
  const numbers = text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  if (/%|percent|\bper\b|\/\s?(hr|hour|h|ft|sq|visit|month|mo)\b|an hour|hourly|\bincl|including|includes|tax in|\bor\b|\d\s?-\s?\$?\d|\bto\s+\$?\d|between|range|approx|about|around|~/i.test(text)) {
    return numbers.length ? { kind: "ambiguous", why: "it isn't one clear price" } : { kind: "text", text };
  }
  if (numbers.length === 0) return { kind: "text", text };
  if (numbers.length > 1) return { kind: "ambiguous", why: "it has more than one number" };
  const leftover = text
    .replace(/\$?\s?\d[\d,]*(?:\.\d+)?\s?(k\b)?/i, " ")
    .replace(FILLER, " ")
    .replace(/[.,!:;$+-]/g, " ")
    .trim();
  if (leftover) return { kind: "ambiguous", why: `I'm not sure what "${text}" means` };
  const raw = (numbers[0] ?? "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return { kind: "ambiguous", why: "the amount looks off" };
  let cents = Math.round(Number(raw) * 100);
  if (/\d\s?k\b/i.test(text)) cents *= 1000;
  if (!Number.isFinite(cents) || cents < 100 || cents > 100_000_000) return { kind: "ambiguous", why: "the amount looks off" };
  return { kind: "price", cents };
}

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

function firstName(contact: AgentContact | null): string {
  const f = contact?.first_name?.trim();
  return f && !/^\+?\d/.test(f) ? f : "there";
}

function displayName(contact: AgentContact | null): string {
  if (!contact) return "the customer";
  const f = contact.first_name && !/^\+?\d/.test(contact.first_name) ? contact.first_name : "";
  return [f, contact.last_name].filter(Boolean).join(" ") || contact.phone || "the customer";
}

function asLines(value: unknown): QuoteLine[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => v as Record<string, unknown>)
    .filter((v) => typeof v.service_key === "string")
    .map((v) => ({
      service_key: v.service_key as string,
      ...(typeof v.quantity === "number" ? { quantity: v.quantity } : {}),
      ...(typeof v.measure === "number" ? { measure: v.measure } : {}),
      ...(v.choices && typeof v.choices === "object" ? { choices: v.choices as Record<string, string> } : {}),
    }));
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// ── execution ───────────────────────────────────────────────────────────────────

type Plan =
  | {
      ok: true;
      customerText: string | null;
      /** Links that must reach the customer exactly once (a quote link). */
      links?: string[];
      ownerMessage: string;
      detail?: Record<string, unknown>;
      conversation?: "owner" | "ai" | "keep";
      collected?: Record<string, unknown>;
    }
  | { ok: false; clarify: true; ownerMessage: string }
  | { ok: false; clarify: false; ownerMessage: string; detail?: Record<string, unknown> };

async function loadApprovalRow(admin: AdminClient, id: string): Promise<Record<string, unknown> | null> {
  const { data } = await (admin as Db).from("owner_approvals").select("*").eq("id", id).maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

async function loadContact(admin: AdminClient, approval: OwnerApprovalRow): Promise<AgentContact | null> {
  if (!approval.contact_id) return null;
  const { data } = await (admin as Db)
    .from("contacts")
    .select("id, organization_id, company_id, first_name, last_name, phone, email, notes, metadata, sms_opt_out_at, email_opt_out_at, sms_consent_at, consent_source")
    .eq("organization_id", approval.organization_id)
    .eq("id", approval.contact_id)
    .maybeSingle();
  return (data as AgentContact | null) ?? null;
}

export async function executeApprovedAction(
  admin: AdminClient,
  approval: OwnerApprovalRow,
  decision: ApprovalDecision,
  deps: ApprovedActionDeps = defaultApprovedActionDeps,
): Promise<ExecuteResult> {
  const db = admin as Db;
  try {
    // Idempotency: claim the row once.
    const nowIso = deps.services.now().toISOString();
    const { data: claimed, error: claimError } = await db
      .from("owner_approvals")
      .update({ execution_claimed_at: nowIso })
      .eq("id", approval.id)
      .eq("company_id", approval.company_id)
      .is("execution_claimed_at", null)
      .select("id");
    if (claimError) throw claimError;
    if (((claimed ?? []) as unknown[]).length !== 1) {
      const row = await loadApprovalRow(admin, approval.id);
      const result = (row?.result ?? null) as { message?: string } | null;
      return { ok: true, message: result?.message ?? "Already on it.", detail: { duplicate: true } };
    }

    const plan = await planFor(admin, approval, decision, deps);
    const contact = await loadContact(admin, approval);
    const facts = await deps.loadFacts(admin, approval.company_id).catch(() => null);

    if (plan.ok === false && plan.clarify === true) {
      // Ask the owner again; leave it pending so "Y 2 $700" can come back in.
      // Back to pending is the only "un-decide": clear the decision so the next "Y 2 $700" is
      // a fresh claim by the owner channel's decideApproval.
      await db
        .from("owner_approvals")
        .update({
          execution_claimed_at: null,
          status: "pending",
          decided_at: null,
          decided_via: null,
          decided_by: null,
          result: { message: plan.ownerMessage, needsClarification: true },
        })
        .eq("id", approval.id);
      return { ok: false, message: plan.ownerMessage, detail: { needsClarification: true } };
    }

    let customerSent: string | null = null;
    if (plan.ok && plan.customerText && contact && facts) {
      // Platform names out (never inside a link), then each link exactly once.
      const links = plan.links ?? [];
      const text = finalizeCustomerText(plan.customerText, { businessName: facts.businessName, links, allowed: [...extractUrls(plan.customerText), ...links] });
      const delivery = await deps.services.textCustomer(admin, facts, contact, text);
      customerSent = delivery.status;
      if (delivery.status !== "sent") {
        const message = `Couldn't text ${displayName(contact)} (${delivery.reason ?? delivery.status}). ${plan.ownerMessage}`;
        await finish(db, approval.id, "failed", decision, { message, delivery: delivery.status, ...(plan.detail ?? {}) });
        return { ok: false, message, detail: plan.detail };
      }
    }

    // The conversation: hand to the owner on a "no", keep the AI on after a done "yes".
    if (approval.contact_id && plan.ok && plan.conversation !== "keep") {
      const conv = await findConversation(admin, { companyId: approval.company_id, contactId: approval.contact_id });
      if (conv) {
        await updateConversation(admin, conv.id, {
          ...(plan.conversation === "owner" ? { state: "owner" as const, owner_takeover_at: nowIso } : {}),
          ...(plan.collected ? { collected: mergeCollected(conv.collected, plan.collected) } : {}),
          ...(customerSent === "sent" ? { last_ai_reply_at: nowIso } : {}),
        });
      }
    }

    const status = !plan.ok ? "failed" : decision.decidedVia === "expiry" ? "expired" : decision.approved ? "executed" : "rejected";
    await finish(db, approval.id, status, decision, { message: plan.ownerMessage, customerText: plan.ok === true ? plan.customerText : null, ...("detail" in plan ? plan.detail ?? {} : {}) });
    return { ok: plan.ok, message: plan.ownerMessage, detail: "detail" in plan ? plan.detail : undefined };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("[sms-agent] executeApprovedAction failed:", reason);
    const message = `That didn't go through (${reason.slice(0, 80)}). Please follow up with the customer yourself.`;
    await finish(db, approval.id, "failed", decision, { message, error: reason.slice(0, 500) }).catch(() => undefined);
    return { ok: false, message };
  }
}

/**
 * Record the outcome (status + result). The decision itself (decided_at / via / by) belongs to
 * whoever claimed the row — the owner channel's decideApproval / expireApproval — so it is only
 * filled in here when nobody has (a direct call without the decide path).
 */
async function finish(db: Db, id: string, status: string, decision: ApprovalDecision, result: Record<string, unknown>): Promise<void> {
  await db.from("owner_approvals").update({ status, result }).eq("id", id);
  await db
    .from("owner_approvals")
    .update({ decided_at: new Date().toISOString(), decided_via: decision.decidedVia, decided_by: decision.decidedBy })
    .eq("id", id)
    .is("decided_at", null);
}

async function planFor(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision, deps: ApprovedActionDeps): Promise<Plan> {
  const contact = await loadContact(admin, approval);
  const facts = await deps.loadFacts(admin, approval.company_id);
  const owner = ownerLabel(facts);
  const who = displayName(contact);
  const hi = `Hi ${firstName(contact)}`;
  const payload = (approval.payload ?? {}) as Record<string, unknown>;
  const followUp = `${owner === "the owner" ? `Someone from ${facts.businessName}` : owner} will be in touch with you directly.`;

  if (decision.decidedVia === "expiry") {
    return { ok: true, customerText: null, conversation: "owner", ownerMessage: `No answer on #${approval.short_code ?? "?"} for ${who}, so I've left it with you.` };
  }

  if (!decision.approved) {
    const note = decision.ownerNote?.trim();
    const kept = note ? ` (I didn't pass on your note — reply to ${who} yourself if you want to add anything.)` : "";
    const customerText =
      approval.kind === "book_job"
        ? `${hi}, sorry - that time won't work after all. ${followUp}`
        : `${hi}, thanks for your patience. ${followUp}`;
    return { ok: true, customerText: contact ? customerText : null, conversation: "owner", ownerMessage: `OK — told ${who} you'll be in touch. The conversation is yours now.${kept}` };
  }

  const note = parseOwnerNote(decision.ownerNote);
  if (note.kind === "ambiguous") {
    return { ok: false, clarify: true, ownerMessage: `I didn't act on #${approval.short_code ?? "?"} for ${who}: ${note.why}. Reply like "Y ${approval.short_code ?? ""} $700" (price before HST) or N.`.replace(/\s+/g, " ") };
  }
  if (!contact) return { ok: false, clarify: false, ownerMessage: `I can't find the customer for #${approval.short_code ?? "?"} any more.` };

  switch (approval.kind) {
    case "send_quote":
    case "custom_price": {
      const lines = asLines(payload.lines);
      // The label the owner was shown (approval-text.ts) is the label the quote line carries.
      const label = str(payload.label) ?? str(payload.title) ?? str(payload.description) ?? "Quoted work";
      const proposed = typeof payload.proposedPriceCents === "number" ? payload.proposedPriceCents : null;
      const priceCents = note.kind === "price" ? note.cents : approval.kind === "custom_price" ? proposed : null;
      if (!priceCents && (approval.kind === "custom_price" || lines.length === 0)) {
        return { ok: false, clarify: true, ownerMessage: `What price should I quote ${who}? Reply "Y ${approval.short_code ?? ""} $700" (before HST), or N.`.replace(/\s+/g, " ") };
      }
      if (note.kind === "text") {
        return { ok: false, clarify: true, ownerMessage: `I didn't act on #${approval.short_code ?? "?"}: I can only take a price as a note (like "Y ${approval.short_code ?? ""} $700"). Reply Y, N, or text ${who} yourself.`.replace(/\s+/g, " ") };
      }
      let quote;
      if (priceCents) {
        quote = await deps.services.createAndSendQuote(admin, facts, { contactId: contact.id, customLines: [{ label, amountCents: priceCents }], title: label });
      } else {
        // Exactly what the owner was shown: re-price and refuse if the price list moved since.
        const shownSubtotal = typeof payload.subtotalCents === "number" ? payload.subtotalCents : null;
        if (shownSubtotal != null) {
          const now = await deps.services.priceServices(approval.company_id, lines);
          if (now.subtotalCents !== shownSubtotal) {
            return {
              ok: false,
              clarify: false,
              ownerMessage: `Your price list changed since I asked (${dollars(shownSubtotal)} then, ${dollars(now.subtotalCents)} now), so I didn't send it. Reply to ${who} yourself or let the assistant quote again.`,
            };
          }
        }
        quote = await deps.services.createAndSendQuote(admin, facts, { contactId: contact.id, lines, title: label });
      }
      const customerText = `${hi}, it's ${facts.businessName}. Here's your quote for ${quote.title}: ${dollars(quote.subtotalCents)} + HST. You can review and approve it here:`;
      await deps.services.recordQuoteEvent(admin, facts, quote.quoteId, "deposit_link_sent", { channels: ["sms"], by: "sms_agent", approvalId: approval.id });
      return {
        ok: true,
        customerText,
        links: [quote.url],
        conversation: "ai",
        collected: { quote_ids: [quote.quoteId] },
        detail: { quoteId: quote.quoteId },
        ownerMessage: `Sent ${who} the ${dollars(quote.subtotalCents)} + HST quote.`,
      };
    }

    case "book_job": {
      if (note.kind !== "none") {
        return { ok: false, clarify: true, ownerMessage: `I can't change the booking from a note. Reply Y ${approval.short_code ?? ""} to book it as asked, or N and text ${who} yourself.`.replace(/\s+/g, " ") };
      }
      const result = await deps.services.bookSlot(admin, facts, {
        contact,
        date: str(payload.date),
        window: str(payload.window),
        startsAt: str(payload.startsAt),
        quoteId: str(payload.quoteId),
        lines: asLines(payload.lines),
        note: str(payload.note),
      });
      if (result.ok === false) {
        return {
          ok: false,
          clarify: false,
          ownerMessage: `Couldn't book ${who}: ${result.message} Please set it up with them directly.`,
          detail: { reason: result.reason },
        };
      }
      const link = result.quote?.url;
      const customerText = `${hi}, good news - you're booked for ${result.label}. ${facts.businessName} will confirm the details.${link ? " Your quote:" : ""}`;
      return {
        ok: true,
        customerText,
        links: link ? [link] : [],
        conversation: "ai",
        collected: { booking_ids: [result.bookingId], ...(result.quote ? { quote_ids: [result.quote.quoteId] } : {}) },
        detail: { bookingId: result.bookingId },
        ownerMessage: `Booked ${who} for ${result.label}.`,
      };
    }

    case "send_reply": {
      const text = str(payload.replyText);
      if (!text) return { ok: false, clarify: false, ownerMessage: `There was no message saved for #${approval.short_code ?? "?"}.` };
      if (note.kind !== "none") {
        return { ok: false, clarify: true, ownerMessage: `I'd rather not guess at the change. Reply Y ${approval.short_code ?? ""} to send it as written, or N and text ${who} yourself.`.replace(/\s+/g, " ") };
      }
      return { ok: true, customerText: text, conversation: "ai", ownerMessage: `Sent it to ${who}.` };
    }

    case "callback": {
      return {
        ok: true,
        customerText: `${hi}, ${owner === "the owner" ? `someone from ${facts.businessName}` : owner} will give you a call.`,
        conversation: "owner",
        ownerMessage: `Told ${who} you'll call them${contact.phone ? ` at ${contact.phone}` : ""}.`,
      };
    }

    default:
      return { ok: false, clarify: false, ownerMessage: `Nothing set up to run "${approval.kind}" yet.` };
  }
}
