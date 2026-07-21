import { NextResponse } from "next/server";

import { logTelnyxPayload, verifyTelnyxSecret } from "@/server/services/telnyx/auth";
import {
  fallbackDynamicVariables,
  raceWithFallback,
  resolveDynamicVariables,
  TELNYX_LOOKUP_BUDGET_MS,
} from "@/server/services/telnyx/dynamic-variables";

export const dynamic = "force-dynamic";

/**
 * Call-start customer lookup. Telnyx personalizes the greeting from this and
 * gives up after 1 second.
 *
 * THIS ROUTE NEVER RETURNS AN ERROR STATUS. A bad lookup should cost us a
 * personalized greeting, never the call — so every failure path (timeout, bad
 * JSON, database down) returns HTTP 200 with fallback variables. The only
 * non-200 is 401, because an unauthenticated caller isn't Telnyx at all.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!verifyTelnyxSecret(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let payload: unknown = null;
  try {
    payload = await request.json();
    logTelnyxPayload("dynamic-variables", payload);
  } catch {
    // Unparseable body — greet generically rather than failing.
    return NextResponse.json(fallbackDynamicVariables());
  }

  const response = await raceWithFallback(
    () => resolveDynamicVariables(payload),
    fallbackDynamicVariables(),
    TELNYX_LOOKUP_BUDGET_MS,
  );

  return NextResponse.json(response);
}
