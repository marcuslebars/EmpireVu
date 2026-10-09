import type { AdminClient, InboundOwnerSms } from "@/server/services/front-desk/contracts";

/**
 * Handle a text from a business owner: approvals ("Y", "N 2", "Y but $700") and commands
 * ("move Jones to Thursday", "what's on tomorrow"). Returns handled=false if it isn't
 * recognisably an owner text, so the router can fall back.
 *
 * STUB — implemented by the owner channel part.
 */
export async function handleOwnerInboundSms(_admin: AdminClient, _sms: InboundOwnerSms): Promise<{ handled: boolean }> {
  return { handled: false };
}
