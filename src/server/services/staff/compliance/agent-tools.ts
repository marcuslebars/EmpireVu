/**
 * Compliance's tool for the customer-facing SMS agent: share_compliance_doc. Pinned to the
 * conversation's company and contact. It never sends anything: it asks the owner
 * (`share_compliance_doc` approval) and tells the agent what to say.
 */
import { z } from "zod";

import type { AgentTool, TurnState } from "@/server/services/sms-agent/tools";
import type { ComplianceKind } from "./db-types";
import { COMPLIANCE_KINDS } from "./kinds";
import { customerFirstName, proposeShare } from "./shares";

const SHAREABLE: readonly ComplianceKind[] = COMPLIANCE_KINDS.filter((k) => k !== "other");

function ownerName(state: TurnState): string {
  return state.facts.ownerFirstName ?? "the owner";
}

const shareComplianceDoc: AgentTool<{ document: ComplianceKind }> = {
  name: "share_compliance_doc",
  description:
    "The customer (or a general contractor / property manager) asks for the business's proof of insurance, certificate of insurance, WSIB clearance, licence or a bond. Asks the owner to OK texting them a link to that document. Never say you have a document or send anything yourself.",
  inputSchema: {
    type: "object",
    properties: {
      document: {
        type: "string",
        enum: [...SHAREABLE],
        description: "liability_insurance for \"insurance\" / \"COI\"; wsib_clearance for \"WSIB\" / \"clearance\"; trade_licence / business_licence for a licence; vehicle_insurance; certification; bond.",
      },
    },
    required: ["document"],
    additionalProperties: false,
  },
  parse: z.object({ document: z.enum(SHAREABLE as [ComplianceKind, ...ComplianceKind[]]) }),
  async run(state, input) {
    const contact = state.contact;
    const first = customerFirstName(contact.first_name);
    const name = [first, contact.last_name].filter(Boolean).join(" ") || contact.phone || "A customer";
    const result = await proposeShare(state.admin, {
      organizationId: state.facts.organizationId,
      companyId: state.facts.companyId,
      contactId: contact.id,
      conversationId: state.conversation.id,
      customerName: name,
      customerFirst: first,
      customerPhone: contact.phone,
      customerText: state.customerText ?? null,
      kind: input.document,
      nowMs: state.services.now().getTime(),
    });
    if (!result.ok) {
      if (result.reason === "already_asked") return { ok: true, already_asked: true, tell_customer: `Say you've already asked ${ownerName(state)} and they'll get it to them shortly.` };
      if (result.reason === "not_on_file")
        return { ok: false, error: `No current ${result.label} on file to send. Don't say whether the business has one. Tell them ${ownerName(state)} will get it to them, and use hand_off_to_owner (reason: "asked for ${result.label}").` };
      return { ok: false, error: `Documents aren't sent by text for this business. Tell them ${ownerName(state)} will get it to them, and use hand_off_to_owner.` };
    }
    const approvalId = result.approvalId as string;
    state.effects.approvals.push({ id: approvalId, shortCode: result.shortCode ?? 0, kind: "share_compliance_doc" });
    state.effects.collected.approval_ids = [approvalId];
    return {
      ok: true,
      approval_requested: true,
      tell_customer: `Say you're checking with ${ownerName(state)} and will text them the ${result.label} shortly. Don't promise it or send any link yourself.`,
    };
  },
};

export const complianceAgentTools = [shareComplianceDoc] as unknown as AgentTool<never>[];
