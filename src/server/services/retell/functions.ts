/**
 * Shared plumbing for Marina's mid-call tools (/api/retell/functions/*).
 *
 * Retell invokes a custom function with a shared-secret header (tool calls carry no
 * webhook HMAC — see auth.ts). With "Payload: args only" OFF, Retell wraps the model's
 * arguments as `{ name, args, call }`, where `call` is the TRUSTED call context from
 * Retell's telephony layer (call_id, from/to numbers, agent id) — not something the
 * model can write. Tenant resolution reads ONLY `call`, never `args`.
 *
 * Every failure body carries a `say` sentence: Retell hands the response to the model
 * whatever the status code, so a failure is something Marina can read out gracefully
 * instead of going silent.
 */
import { NextResponse } from "next/server";

import { logRetellPayload, verifyRetellFunctionSecret } from "./auth";
import { getRetellConfig } from "./config";
import { enforceWebhookBackstop } from "@/server/services/rate-limit";

export interface RetellCallContext {
  callId: string | null;
  fromNumber: string | null;
  toNumber: string | null;
  agentId: string | null;
  direction: string | null;
}

export interface RetellFunctionRequest<TArgs = Record<string, unknown>> {
  name: string | null;
  args: TArgs;
  call: RetellCallContext;
  /** The body exactly as received, for helpers that take the raw Retell shape. */
  raw: unknown;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Accepts both `{ name, args, call }` and a bare-args body (args-only ON). */
export function parseRetellFunctionBody<TArgs = Record<string, unknown>>(
  body: unknown,
): RetellFunctionRequest<TArgs> {
  const obj = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const hasEnvelope = Boolean(obj.args && typeof obj.args === "object");
  const args = (hasEnvelope ? obj.args : obj) as TArgs;
  const call = (obj.call && typeof obj.call === "object" ? obj.call : {}) as Record<string, unknown>;
  return {
    name: str(obj.name),
    args,
    call: {
      callId: str(call.call_id),
      fromNumber: str(call.from_number),
      toNumber: str(call.to_number),
      agentId: str(call.agent_id),
      direction: str(call.direction),
    },
    raw: body,
  };
}

export const SAY_NOT_AVAILABLE =
  "I can't do that from here right now — I'll have someone from the team follow up with you.";

/**
 * Gate + parse for every tool route. Returns a ready response on failure, or the
 * parsed request. Order matters: the rate-limit backstop and the secret run before
 * the body is read, so an unauthenticated caller costs nothing.
 */
export async function readRetellFunctionRequest<TArgs = Record<string, unknown>>(
  request: Request,
  label: string,
): Promise<{ ok: true; data: RetellFunctionRequest<TArgs> } | { ok: false; response: NextResponse }> {
  const backstop = await enforceWebhookBackstop(request, `retell_${label.replace(/-/g, "_")}`);
  if (backstop) return { ok: false, response: backstop };

  if (!verifyRetellFunctionSecret(request)) {
    return { ok: false, response: NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 }) };
  }

  if (!getRetellConfig().enabled) {
    return {
      ok: false,
      response: NextResponse.json({ ok: false, reason: "not_enabled", say: SAY_NOT_AVAILABLE }, { status: 200 }),
    };
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, response: NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 }) };
  }
  logRetellPayload(label, body);
  return { ok: true, data: parseRetellFunctionBody<TArgs>(body) };
}
