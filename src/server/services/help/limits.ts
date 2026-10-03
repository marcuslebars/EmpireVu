import type { NextResponse } from "next/server";

import { enforceRateLimit } from "@/server/services/rate-limit";

/**
 * Help assistant abuse/cost caps (docs/help-assistant.md). Keyed on the AUTHENTICATED user
 * id and the org id the caller proved membership of — never on anything in the request body.
 * Uses the shared DB-backed limiter (services/rate-limit.ts), which fails OPEN on a limiter
 * outage like every other caller.
 */

const DAY = 24 * 60 * 60;

function intFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface HelpLimits {
  askPerUserPerMinute: number;
  askPerUserPerDay: number;
  askPerOrgPerDay: number;
  escalatePerUserPerDay: number;
  escalatePerOrgPerDay: number;
}

export function helpLimits(): HelpLimits {
  return {
    askPerUserPerMinute: 6,
    askPerUserPerDay: intFromEnv("HELP_ASK_DAILY_LIMIT_PER_USER", 40),
    askPerOrgPerDay: intFromEnv("HELP_ASK_DAILY_LIMIT_PER_ORG", 150),
    escalatePerUserPerDay: 5,
    escalatePerOrgPerDay: 15,
  };
}

/** The first limit tripped, as a ready 429 — or null to proceed. Per-user checks run first. */
export async function enforceHelpAskLimits(
  request: Request,
  ids: { userId: string; organizationId: string },
): Promise<NextResponse | null> {
  const limits = helpLimits();
  const logContext = { organizationId: ids.organizationId };
  return (
    (await enforceRateLimit(request, {
      scope: "help_ask_user_min",
      limit: limits.askPerUserPerMinute,
      windowSeconds: 60,
      keyParts: [ids.userId],
      logContext,
    })) ??
    (await enforceRateLimit(request, {
      scope: "help_ask_user_day",
      limit: limits.askPerUserPerDay,
      windowSeconds: DAY,
      keyParts: [ids.userId],
      logContext,
    })) ??
    (await enforceRateLimit(request, {
      scope: "help_ask_org_day",
      limit: limits.askPerOrgPerDay,
      windowSeconds: DAY,
      keyParts: [ids.organizationId],
      logContext,
    }))
  );
}

export async function enforceHelpEscalateLimits(
  request: Request,
  ids: { userId: string; organizationId: string },
): Promise<NextResponse | null> {
  const limits = helpLimits();
  const logContext = { organizationId: ids.organizationId };
  return (
    (await enforceRateLimit(request, {
      scope: "help_escalate_user_day",
      limit: limits.escalatePerUserPerDay,
      windowSeconds: DAY,
      keyParts: [ids.userId],
      logContext,
    })) ??
    (await enforceRateLimit(request, {
      scope: "help_escalate_org_day",
      limit: limits.escalatePerOrgPerDay,
      windowSeconds: DAY,
      keyParts: [ids.organizationId],
      logContext,
    }))
  );
}
