import type { AdminClient, InboundCustomerSms } from "@/server/services/front-desk/contracts";

/**
 * Called by the inbound SMS router for every customer text on a company number (after STOP/START
 * handling and owner detection). The SMS agent decides whether to reply.
 * Must never throw: failures are logged and leave the conversation for the owner.
 *
 * STUB — implemented by the SMS agent part.
 */
export async function runSmsAgentForInbound(_admin: AdminClient, _sms: InboundCustomerSms): Promise<{ replied: boolean }> {
  return { replied: false };
}
