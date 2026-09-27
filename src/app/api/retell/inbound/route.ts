import { NextResponse } from "next/server";

import { getBusinessTimezone } from "@/server/services/ai";
import { enforceWebhookBackstop } from "@/server/services/rate-limit";
import {
  DEFAULT_AGENT_NAME,
  loadGreetingContext,
  lookupCaller,
  toDynamicVariables,
  UNKNOWN_CALLER,
  type CallerProfile,
  type GreetingContext,
} from "@/server/services/retell/caller-lookup";
import { getRetellConfig } from "@/server/services/retell/config";
import { verifyRetellSignature } from "@/server/services/retell/signature";
import { createRetellAdminClient, resolveRetellTenant } from "@/server/services/retell/tenant";

export const dynamic = "force-dynamic";

/** Retell waits on this while the phone rings; stay well inside it. */
const BUDGET_MS = 1500;

interface InboundBody {
  event?: string;
  call_inbound?: { from_number?: string; to_number?: string; agent_id?: string };
}

function withinBudget<T>(work: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    work.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), BUDGET_MS)),
  ]);
}

/**
 * POST /api/retell/inbound — Retell's inbound-call webhook (set on the PHONE NUMBER, not
 * the agent). Looks the caller up in the called company's contacts and hands Marina the
 * returning-caller variables. Strictly fail-open: a bad signature, a disabled flag, an
 * unmapped number or a slow database all answer as a new caller, and the call connects.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const backstop = await enforceWebhookBackstop(request, "retell_inbound");
  if (backstop) return backstop;

  const cfg = getRetellConfig();
  const rawBody = await request.text();
  const newCaller = (g: GreetingContext = { companyName: "", agentName: DEFAULT_AGENT_NAME }) =>
    NextResponse.json({ call_inbound: { dynamic_variables: toDynamicVariables(UNKNOWN_CALLER, g) } });

  if (!verifyRetellSignature(rawBody, request.headers.get("x-retell-signature"), cfg.apiKey, cfg.toleranceMs)) {
    console.warn("[retell:inbound] unsigned or bad signature — answering as a new caller");
    return newCaller();
  }

  let body: InboundBody;
  try {
    body = JSON.parse(rawBody) as InboundBody;
  } catch {
    return newCaller();
  }

  const admin = createRetellAdminClient();
  const inbound = body.call_inbound ?? {};

  const result = await withinBudget(
    (async (): Promise<{ profile: CallerProfile; greeting: GreetingContext }> => {
      const tenant = await resolveRetellTenant(admin, {
        toNumber: inbound.to_number ?? null,
        agentId: inbound.agent_id ?? null,
        legacySourceSite: cfg.sourceSite,
      });
      // A legacy (env-guessed) brand may not be the one the caller dialled — greet
      // neutrally and don't look them up in the wrong company's contacts.
      if (tenant.resolvedBy === "legacy") {
        return { profile: UNKNOWN_CALLER, greeting: { companyName: "", agentName: DEFAULT_AGENT_NAME } };
      }
      const greeting = await loadGreetingContext(admin, tenant.companyId);
      if (!cfg.enabled || !tenant.organizationId || !tenant.companyId) {
        return { profile: UNKNOWN_CALLER, greeting };
      }
      const profile = await lookupCaller(admin, {
        organizationId: tenant.organizationId,
        companyId: tenant.companyId,
        phone: inbound.from_number ?? null,
        timeZone: greeting.timeZone ?? getBusinessTimezone(),
      });
      return { profile, greeting };
    })(),
    { profile: UNKNOWN_CALLER, greeting: { companyName: "", agentName: DEFAULT_AGENT_NAME } },
  );

  // PII discipline: no names or numbers in the log line.
  console.log(`[retell:inbound] ${result.profile.known ? "returning caller" : "new caller"}`);

  return NextResponse.json({
    call_inbound: {
      dynamic_variables: toDynamicVariables(result.profile, result.greeting),
      metadata: result.profile.quoteId ? { quoteId: result.profile.quoteId } : {},
    },
  });
}
