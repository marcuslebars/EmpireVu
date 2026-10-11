/**
 * The `ai_estimate` executor (owner-channel/approvals.ts runApproval → staff registry).
 *
 *   Y          → createQuote from the estimate's lines (source "estimator"), the link texted to
 *                the customer from the business number.
 *   Y $900     → the same, re-priced so the total before HST is exactly $900 (estimate.ts
 *                planOwnerPrice: price-list lines keep their price, estimated lines scale; else
 *                one line at $900).
 *   N          → "Dana will be in touch" to the customer; the conversation goes to the owner.
 *   expiry     → same as N, and the owner gets a text saying so (expiry is pushed to daytime
 *                when the approval is made, so neither text goes out at night).
 *   unclear    → nothing is done; a fresh code is issued and the owner is told how to reply.
 *
 * Idempotent: the estimate row is claimed (decision_claimed_at, conditional on the approval id)
 * before anything is sent; a repeat returns the stored owner line. The owner channel records
 * the returned result on the approval row.
 */
import { insertApproval } from "@/server/services/front-desk/approvals";
import type { AdminClient, ApprovalDecision, ExecuteResult, OwnerApprovalRow } from "@/server/services/front-desk/contracts";
import { parseOwnerNote } from "@/server/services/front-desk/owner-note";
import { findConversation, mergeCollected, updateConversation } from "@/server/services/sms-agent/conversation";
import type { BusinessFacts } from "@/server/services/sms-agent/facts";
import { finalizeCustomerText } from "@/server/services/sms-agent/guard";
import type { EstimateJson, EstimateRequestRow } from "@/server/services/staff/estimator/db-types";
import { estimatorDeps, type EstimatorContact, type EstimatorDeps } from "@/server/services/staff/estimator/deps";
import { planOwnerPrice } from "@/server/services/staff/estimator/estimate";
import { AI_ESTIMATE_KIND, ESTIMATE_APPROVAL_TTL_MS } from "@/server/services/staff/estimator/request-tool";
import { daytimeExpiry, displayName, dollars, firstName } from "@/server/services/staff/estimator/text";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

function isFullEstimate(e: EstimateRequestRow["estimate"]): e is EstimateJson {
  return Boolean(e && Array.isArray(e.lines) && e.lines.length > 0 && Array.isArray(e.services) && Array.isArray(e.customLines) && typeof e.subtotalCents === "number");
}

async function loadEstimate(admin: AdminClient, approval: OwnerApprovalRow): Promise<EstimateRequestRow | null> {
  const id = typeof approval.payload?.estimateId === "string" ? approval.payload.estimateId : null;
  if (!id) return null;
  const { data } = await (admin as Db)
    .from("estimate_requests")
    .select("*")
    .eq("organization_id", approval.organization_id)
    .eq("company_id", approval.company_id)
    .eq("id", id)
    .maybeSingle();
  return (data as EstimateRequestRow | null) ?? null;
}

async function loadContact(admin: AdminClient, row: EstimateRequestRow): Promise<EstimatorContact | null> {
  const { data } = await (admin as Db)
    .from("contacts")
    .select("id, organization_id, company_id, first_name, last_name, phone, sms_opt_out_at, email_opt_out_at, sms_consent_at, consent_source")
    .eq("organization_id", row.organization_id)
    .eq("company_id", row.company_id)
    .eq("id", row.contact_id)
    .maybeSingle();
  return (data as EstimatorContact | null) ?? null;
}

async function patchEstimate(admin: AdminClient, row: EstimateRequestRow, patch: Record<string, unknown>): Promise<void> {
  await (admin as Db).from("estimate_requests").update(patch).eq("id", row.id).eq("company_id", row.company_id);
}

function ownerName(facts: BusinessFacts | null): string {
  return facts?.ownerFirstName ?? "the owner";
}

/** Hand the conversation to the owner (the AI stays quiet) — or just record the quote. */
async function touchConversation(admin: AdminClient, row: EstimateRequestRow, nowIso: string, patch: { owner?: boolean; quoteId?: string; texted?: boolean }): Promise<void> {
  const conv = await findConversation(admin, { companyId: row.company_id, contactId: row.contact_id });
  if (!conv) return;
  await updateConversation(admin, conv.id, {
    ...(patch.owner ? { state: "owner" as const, owner_takeover_at: nowIso } : {}),
    ...(patch.quoteId ? { collected: mergeCollected(conv.collected, { quote_ids: [patch.quoteId] }) } : {}),
    ...(patch.texted ? { last_ai_reply_at: nowIso } : {}),
  });
}

async function textCustomer(
  deps: EstimatorDeps,
  admin: AdminClient,
  row: EstimateRequestRow,
  contact: EstimatorContact | null,
  facts: BusinessFacts | null,
  body: string,
  links: string[] = [],
): Promise<{ status: string; reason?: string }> {
  if (!contact || !facts) return { status: "blocked", reason: "no_contact" };
  const text = finalizeCustomerText(body, { businessName: facts.businessName, links, allowed: links });
  const result = await deps.textCustomer(admin, { organizationId: row.organization_id, companyId: row.company_id }, contact, text);
  return { status: result.status, reason: result.reason };
}

/** Issue a fresh code for the same estimate (the owner's reply was unclear). */
async function reissue(deps: EstimatorDeps, admin: AdminClient, approval: OwnerApprovalRow, row: EstimateRequestRow, why: string, who: string, facts: BusinessFacts | null): Promise<ExecuteResult> {
  const now = deps.now();
  const { data: company } = await (admin as Db)
    .from("companies")
    .select("owner_phone_e164, owner_phone_verified_at, timezone")
    .eq("organization_id", row.organization_id)
    .eq("id", row.company_id)
    .maybeSingle();
  const c = company as { owner_phone_e164: string | null; owner_phone_verified_at: string | null; timezone: string | null } | null;
  const phone = c?.owner_phone_e164 && c.owner_phone_verified_at ? c.owner_phone_e164 : null;
  const fresh = await insertApproval(admin, {
    organizationId: row.organization_id,
    companyId: row.company_id,
    contactId: row.contact_id,
    conversationId: approval.conversation_id,
    kind: AI_ESTIMATE_KIND,
    summary: approval.summary,
    payload: approval.payload,
    requestedBy: "estimator",
    createdAt: now,
    expiresAt: daytimeExpiry(now, ESTIMATE_APPROVAL_TTL_MS, facts?.timeZone ?? c?.timezone ?? "America/Toronto"),
    // The owner is asked in this reply, so the new code counts for replies from their phone.
    notifiedAt: phone ? now : null,
    notifiedTo: phone,
  });
  const code = fresh.short_code ?? "?";
  const subtotal = isFullEstimate(row.estimate) ? `${dollars(row.estimate.subtotalCents)} + HST` : "the estimate";
  const message = `I didn't send ${who}'s quote: ${why}. Reply Y ${code} to send it at ${subtotal}, Y ${code} $price (before HST) for a different total, or N ${code}.`;
  await patchEstimate(admin, row, { approval_id: fresh.id, decision_claimed_at: null, status: "awaiting_owner", owner_result: message });
  return { ok: false, message, detail: { reissuedApprovalId: fresh.id, needsClarification: true } };
}

export async function executeAiEstimate(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision): Promise<ExecuteResult> {
  const deps = estimatorDeps();
  const row = await loadEstimate(admin, approval);
  if (!row) return { ok: false, message: `I can't find the estimate for #${approval.short_code ?? "?"} any more.` };

  const nowIso = deps.now().toISOString();
  const { data: claimed } = await (admin as Db)
    .from("estimate_requests")
    .update({ decision_claimed_at: nowIso })
    .eq("id", row.id)
    .eq("company_id", row.company_id)
    .eq("approval_id", approval.id)
    .is("decision_claimed_at", null)
    .select("id");
  if (((claimed ?? []) as unknown[]).length !== 1) {
    const { data: current } = await (admin as Db).from("estimate_requests").select("owner_result").eq("id", row.id).maybeSingle();
    return { ok: true, message: (current as { owner_result: string | null } | null)?.owner_result ?? "Already on it.", detail: { duplicate: true } };
  }

  const contact = await loadContact(admin, row);
  const facts = await deps.loadFacts(admin, row.company_id).catch(() => null);
  const who = displayName(contact);
  const owner = ownerName(facts);
  const code = approval.short_code ?? "?";
  const title = isFullEstimate(row.estimate) ? row.estimate.title : "the work";

  try {
    if (!decision.approved) {
      const followUp = `${owner === "the owner" ? `Someone from ${facts?.businessName ?? "the team"}` : owner} will be in touch with you directly about the ${title}.`;
      const sent = await textCustomer(deps, admin, row, contact, facts, `Hi ${firstName(contact)}, thanks for your patience. ${followUp}`);
      await touchConversation(admin, row, nowIso, { owner: true, texted: sent.status === "sent" });
      const expired = decision.decidedVia === "expiry";
      const kept = !expired && decision.ownerNote?.trim() ? ` (I didn't pass on your note - reply to ${who} yourself if you want to add anything.)` : "";
      const told = sent.status === "sent" ? `told ${who} you'll be in touch` : `couldn't text ${who} (${sent.reason ?? sent.status})`;
      const message = expired
        ? `No answer on #${code} (the ${title} estimate for ${who}), so I ${told}. The conversation is yours now.`
        : `OK - ${told} about the estimate. The conversation is yours now.${kept}`;
      await patchEstimate(admin, row, { status: "declined", owner_result: message });
      if (expired) await deps.textOwner(admin, { organizationId: row.organization_id, companyId: row.company_id }, message).catch(() => ({ sent: false }));
      return { ok: true, message, detail: { estimateId: row.id, customerText: sent.status } };
    }

    const note = parseOwnerNote(decision.ownerNote);
    if (note.kind === "ambiguous") return await reissue(deps, admin, approval, row, note.why, who, facts);
    if (note.kind === "text") return await reissue(deps, admin, approval, row, "I can only take a price as a note", who, facts);
    if (!isFullEstimate(row.estimate)) {
      const message = `The estimate for #${code} is incomplete, so nothing was sent. Please price it for ${who} yourself.`;
      await patchEstimate(admin, row, { status: "failed", owner_result: message });
      return { ok: false, message };
    }
    if (!contact || !facts) {
      const message = `I can't find ${who} any more, so nothing was sent.`;
      await patchEstimate(admin, row, { status: "failed", owner_result: message });
      return { ok: false, message };
    }
    const estimate = row.estimate;

    let services = estimate.services;
    let customLines = estimate.customLines;
    let method: string = "as_estimated";
    if (note.kind === "price") {
      const catalog = services.length ? (await deps.priceQuote(row.company_id, { services, customLines: [] })).subtotalCents : 0;
      const plan = planOwnerPrice(estimate, note.cents, catalog);
      services = plan.services;
      customLines = plan.customLines;
      method = plan.method;
    } else {
      // Exactly what the owner was shown: refuse if the price list moved since.
      const now = await deps.priceQuote(row.company_id, { services, customLines });
      if (now.subtotalCents !== estimate.subtotalCents) {
        const message = `Your price list changed since the estimate (${dollars(estimate.subtotalCents)} then, ${dollars(now.subtotalCents)} now), so I didn't send it. Reply to ${who} yourself, or ask for a new estimate.`;
        await patchEstimate(admin, row, { status: "failed", owner_result: message });
        return { ok: false, message };
      }
    }

    const quote = await deps.createAndSendQuote(admin, facts, { contactId: contact.id, services, customLines, title: estimate.title });
    await deps.recordQuoteEvent(admin, row.organization_id, quote.quoteId, "deposit_link_sent", { channels: ["sms"], by: "estimator", approvalId: approval.id });
    const sent = await textCustomer(
      deps,
      admin,
      row,
      contact,
      facts,
      `Hi ${firstName(contact)}, it's ${facts.businessName}. Here's your quote for ${estimate.title}: ${dollars(quote.subtotalCents)} + HST. You can look it over and approve it here:`,
      [quote.url],
    );
    await touchConversation(admin, row, nowIso, { quoteId: quote.quoteId, texted: sent.status === "sent" });
    const ok = sent.status === "sent";
    const message = ok
      ? `Sent ${who} the ${dollars(quote.subtotalCents)} + HST quote for ${estimate.title}.`
      : `Made the ${dollars(quote.subtotalCents)} + HST quote but couldn't text ${who} (${sent.reason ?? sent.status}). Send them this link: ${quote.url}`;
    await patchEstimate(admin, row, { status: "sent", quote_id: quote.quoteId, owner_result: message, error: ok ? null : `text ${sent.status}` });
    return { ok, message, detail: { estimateId: row.id, quoteId: quote.quoteId, pricing: method } };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("[estimator] ai_estimate failed:", reason);
    const message = `That didn't go through (${reason.slice(0, 80)}). Please follow up with ${who} yourself.`;
    await patchEstimate(admin, row, { status: "failed", error: reason.slice(0, 500), owner_result: message }).catch(() => undefined);
    return { ok: false, message };
  }
}
