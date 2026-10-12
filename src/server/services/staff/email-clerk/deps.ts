/**
 * The outside world for the Email inbox, behind one seam so tests (and the e2e fakes) can swap it:
 * the inbound provider (Resend Inbound), the attachments bucket, and the model.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { notifyOwnerOfApproval } from "@/server/services/owner-channel/notify";
import { defaultEmailClerkModel, type EmailClerkModel } from "./ai";
import { resendInboundProvider, type InboundEmailProvider } from "./provider";
import { supabaseAttachmentStorage, type AttachmentStorage } from "./storage";

export interface EmailClerkDeps {
  provider: InboundEmailProvider;
  storage(admin: AdminClient): AttachmentStorage;
  model: EmailClerkModel;
  notify(admin: AdminClient, approvalId: string, nowMs: number): Promise<{ notified: boolean }>;
}

const defaults: EmailClerkDeps = {
  provider: resendInboundProvider,
  storage: (admin) => supabaseAttachmentStorage(admin),
  model: defaultEmailClerkModel,
  notify: (admin, id, nowMs) => notifyOwnerOfApproval(admin, id, { nowMs }),
};

let current: EmailClerkDeps = { ...defaults };

export function emailClerkDeps(): EmailClerkDeps {
  return current;
}

/** Test hook: replace some of the outside world. */
export function setEmailClerkDeps(over: Partial<EmailClerkDeps>): void {
  current = { ...current, ...over };
}

/** Test hook. */
export function resetEmailClerkDeps(): void {
  current = { ...defaults };
}
