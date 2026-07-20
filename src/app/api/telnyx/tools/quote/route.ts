import { NextResponse } from "next/server";

import { logTelnyxPayload, verifyTelnyxSecret } from "@/server/services/telnyx/auth";
import {
  coerceBoatLengthFt,
  coerceEngineType,
  extractCalledNumber,
  extractCallerNumber,
  extractConversationId,
  normalizePhoneLast10,
  readNumber,
  readString,
} from "@/server/services/telnyx/payload";
import { centsToDollars, priceTelnyxQuote } from "@/server/services/telnyx/pricing";
import { createTelnyxAdminClient, resolveTenantByCalledNumber } from "@/server/services/telnyx/tenant";
import type { Json } from "@/server/db/database.types";

export const dynamic = "force-dynamic";

/**
 * Mid-call pricing tool. Telnyx maps `quote_total` / `deposit_amount` from this
 * response into dynamic variables, so the success shape stays flat.
 *
 * When the pricing engine needs an input the caller hasn't given, this answers
 * `missing_info` rather than erroring — the assistant asks for it and retries.
 * Prices are never invented here; see services/telnyx/pricing.ts.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!verifyTelnyxSecret(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
    logTelnyxPayload("tools/quote", payload);
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const serviceType = readString(payload, ["service_type", "serviceType", "service"]);
  const boatType = readString(payload, ["boat_type", "boatType", "hull_type"]);
  const tier = readString(payload, ["tier", "detailing_tier", "service_tier"]);
  const boatLengthFt = coerceBoatLengthFt(
    readString(payload, ["boat_length_ft", "boatLengthFt", "boat_length", "length"]) ??
      readNumber(payload, ["boat_length_ft", "boatLengthFt", "boat_length", "length"]),
  );
  const engineType = coerceEngineType(
    readString(payload, ["engine_type", "engineType", "engine"]),
  );
  const engineCount = readNumber(payload, ["engine_count", "engineCount", "engines"]);
  const conversationId = extractConversationId(payload);

  const outcome = priceTelnyxQuote({
    boatLengthFt,
    boatType,
    engineCount: engineCount != null ? Math.max(1, Math.round(engineCount)) : null,
    engineType,
    serviceType,
    tier,
  });

  // Logging is sales intelligence, not part of the caller's answer — never let
  // it delay or break the response the assistant is waiting on.
  const logQuote = async () => {
    try {
      const admin = createTelnyxAdminClient();
      const tenant = await resolveTenantByCalledNumber(
        admin,
        readString(payload, ["called_number", "to"]) ?? extractCalledNumber(payload),
      );
      if (!tenant.organizationId) return;

      await admin.from("telnyx_quotes").insert({
        boat_length_ft: boatLengthFt,
        boat_type: boatType,
        caller_phone_last10: normalizePhoneLast10(extractCallerNumber(payload)),
        company_id: tenant.companyId,
        currency: "CAD",
        deposit_cents: outcome.status === "quoted" ? outcome.depositCents : null,
        engine_type: engineType,
        error_message: outcome.status === "unsupported" ? outcome.reason : null,
        line_items: (outcome.status === "quoted" ? outcome.lineItems : []) as unknown as Json,
        missing_fields: outcome.status === "missing_info" ? outcome.missing : [],
        organization_id: tenant.organizationId,
        quote_total_cents: outcome.status === "quoted" ? outcome.quoteTotalCents : null,
        request_payload: (payload ?? {}) as Json,
        service_type: serviceType,
        spoken_summary: outcome.status === "quoted" ? outcome.spokenSummary : null,
        status: outcome.status === "quoted" ? "quoted" : outcome.status === "missing_info" ? "missing_info" : "error",
        telnyx_conversation_id: conversationId,
      });
    } catch (error) {
      console.error("[telnyx:quote] failed to log quote:", error);
    }
  };

  if (outcome.status === "missing_info") {
    await logQuote();
    return NextResponse.json({ missing: outcome.missing, status: "missing_info" });
  }

  if (outcome.status === "unsupported") {
    await logQuote();
    return NextResponse.json(
      { reason: outcome.reason, status: "unsupported" },
      { status: 200 },
    );
  }

  await logQuote();

  return NextResponse.json({
    currency: outcome.currency,
    deposit_amount: centsToDollars(outcome.depositCents),
    line_items: outcome.lineItems.map((line) => ({
      amount: centsToDollars(line.amountCents),
      label: line.label,
    })),
    quote_total: centsToDollars(outcome.quoteTotalCents),
    spoken_summary: outcome.spokenSummary,
    status: "quoted",
  });
}
