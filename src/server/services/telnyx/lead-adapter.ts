import { handleLeadIntake } from "@/server/services/lead-intake/intake";
import { LEAD_SCHEMA_VERSION } from "@/server/services/lead-intake/envelope";
import {
  coerceBoatLengthFt,
  extractCalledNumber,
  extractConversationId,
  normalizePhoneLast10,
  readNumber,
  readString,
  readStringArray,
  toE164,
} from "./payload";
import { createTelnyxAdminClient, resolveTenantByCalledNumber } from "./tenant";

/** Marks every lead that came from the phone assistant. */
export const TELNYX_LEAD_SOURCE = "telnyx_voice_agent";

export interface TelnyxLeadFields {
  boatLengthFt: number | null;
  boatType: string | null;
  callbackPreference: string | null;
  calledNumber: string | null;
  conversationId: string | null;
  depositAmount: number | null;
  email: string | null;
  name: string | null;
  notes: string | null;
  phone: string | null;
  quoteTotal: number | null;
  servicesSelected: string[];
}

/** Pull the assistant's captured fields out of a payload of unconfirmed shape. */
export function readTelnyxLeadFields(payload: unknown): TelnyxLeadFields {
  return {
    boatLengthFt: coerceBoatLengthFt(
      readString(payload, ["boat_length", "boat_length_ft", "boatLength"]) ??
        readNumber(payload, ["boat_length", "boat_length_ft", "boatLength"]),
    ),
    boatType: readString(payload, ["boat_type", "boatType"]),
    callbackPreference: readString(payload, [
      "callback_preference",
      "callbackPreference",
      "preferred_callback",
    ]),
    calledNumber: readString(payload, ["called_number", "to"]) ?? extractCalledNumber(payload),
    conversationId: extractConversationId(payload),
    depositAmount: readNumber(payload, ["deposit_amount", "depositAmount"]),
    email: readString(payload, ["email", "customer_email", "contact.email"]),
    name: readString(payload, ["name", "customer_name", "full_name", "contact.name"]),
    notes: readString(payload, ["notes", "free_text_notes", "summary", "message"]),
    phone: readString(payload, ["phone", "customer_phone", "contact.phone", "from"]),
    quoteTotal: readNumber(payload, ["quote_total", "quoteTotal"]),
    servicesSelected: readStringArray(payload, [
      "services_selected",
      "servicesSelected",
      "services",
      "service_type",
    ]),
  };
}

/**
 * Map the call's fields onto the canonical lead envelope (schemaVersion 1) that
 * every other spoke emits, so a phone lead flows through the identical intake,
 * dedup and notification path as a web form.
 *
 * Returned untyped on purpose: intake re-validates with its own zod schema and
 * is designed to sort invalid payloads rather than reject them, so an
 * incomplete call still lands in raw_leads instead of being dropped here.
 */
export function buildLeadEnvelope(
  fields: TelnyxLeadFields,
  sourceSite: string,
  receivedAt: string = new Date().toISOString(),
): Record<string, unknown> {
  const messageParts: string[] = [];
  if (fields.notes) messageParts.push(fields.notes);
  if (fields.servicesSelected.length > 0) {
    messageParts.push(`Services discussed: ${fields.servicesSelected.join(", ")}.`);
  }
  if (fields.callbackPreference) {
    messageParts.push(`Callback preference: ${fields.callbackPreference}.`);
  }
  if (fields.quoteTotal != null) {
    const deposit = fields.depositAmount != null ? `, deposit $${fields.depositAmount}` : "";
    messageParts.push(`Quoted $${fields.quoteTotal}${deposit} on the call.`);
  }
  if (fields.conversationId) {
    messageParts.push(`Telnyx conversation: ${fields.conversationId}.`);
  }

  // One line carrying the quoted total: the assistant gives a single figure for
  // the call, so splitting it across services would be invented precision.
  const lineItems =
    fields.quoteTotal != null
      ? [
          {
            description:
              fields.servicesSelected.length > 0
                ? fields.servicesSelected.join(" + ")
                : "Phone quote",
            quantity: 1,
            unitPriceCents: Math.round(fields.quoteTotal * 100),
          },
        ]
      : undefined;

  const asset =
    fields.boatLengthFt != null || fields.boatType
      ? {
          ...(fields.boatLengthFt != null ? { lengthFt: fields.boatLengthFt } : {}),
          ...(fields.boatType ? { type: fields.boatType } : {}),
        }
      : undefined;

  return {
    ...(asset ? { asset } : {}),
    contact: {
      ...(fields.name ? { name: fields.name } : {}),
      ...(fields.email ? { email: fields.email } : {}),
      ...(fields.phone ? { phone: toE164(fields.phone) ?? fields.phone } : {}),
    },
    // "quote" when a price was given, otherwise a plain enquiry. Never "booking":
    // a callback preference is not a scheduled datetime, and formType "booking"
    // would have intake create a real booking from it.
    formType: fields.quoteTotal != null ? "quote" : "contact",
    ...(lineItems ? { lineItems } : {}),
    ...(messageParts.length > 0 ? { message: messageParts.join(" ") } : {}),
    receivedAt,
    schemaVersion: LEAD_SCHEMA_VERSION,
    source: TELNYX_LEAD_SOURCE,
    sourceSite,
  };
}

export interface TelnyxLeadResult {
  duplicate: boolean;
  leadId: string | null;
}

/**
 * Idempotent by `telnyx_conversation_id`: Telnyx may retry the end-of-call tool,
 * and a retry must attach to the existing lead rather than create a second one.
 * The conversation row in telnyx_call_insights is the anchor (unique id), and
 * the post-call Insights receiver later upserts its analysis onto the same row.
 */
export async function ingestTelnyxLead(payload: unknown): Promise<TelnyxLeadResult> {
  const fields = readTelnyxLeadFields(payload);
  const admin = createTelnyxAdminClient();
  const tenant = await resolveTenantByCalledNumber(admin, fields.calledNumber);

  if (fields.conversationId) {
    const { data: existing } = await admin
      .from("telnyx_call_insights")
      .select("lead_id")
      .eq("telnyx_conversation_id", fields.conversationId)
      .maybeSingle();

    if (existing?.lead_id) {
      return { duplicate: true, leadId: existing.lead_id };
    }
  }

  // sourceSite drives brand routing inside intake. An unmapped number yields
  // null, which intake stores raw and flags for attention rather than dropping.
  const envelope = buildLeadEnvelope(fields, tenant.sourceSite ?? "");
  const result = await handleLeadIntake(JSON.stringify(envelope), envelope);

  if (fields.conversationId) {
    try {
      await admin.from("telnyx_call_insights").upsert(
        {
          caller_phone_last10: normalizePhoneLast10(fields.phone),
          company_id: tenant.companyId,
          lead_id: result.leadId,
          organization_id: tenant.organizationId,
          telnyx_conversation_id: fields.conversationId,
        },
        { onConflict: "telnyx_conversation_id" },
      );
    } catch (error) {
      // The lead is already durable; losing the link only costs idempotency.
      console.error("[telnyx:lead] failed to record conversation link:", error);
    }
  }

  return { duplicate: false, leadId: result.leadId };
}
