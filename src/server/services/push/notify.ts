import type { Tables } from "@/server/db/database.types";
import { defaultSenders, sendPushToOrganization, type PushMessage, type PushSenders } from "@/server/services/push/dispatch";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

/**
 * Pushes that do not come from an activity event: an AI draft waiting for approval and a
 * workflow run that failed. Like the activity fan-out, every function here is
 * fire-and-forget — it never throws and is a no-op without a push provider.
 */
type Admin = ReturnType<typeof createSupabaseAdminClient>;

interface NotifyOptions {
  /** Injected in tests; defaults to the real admin client and senders. */
  admin?: Admin;
  senders?: PushSenders;
}

async function withPush(options: NotifyOptions, run: (admin: Admin, senders: PushSenders) => Promise<void>, label: string): Promise<void> {
  try {
    const senders = options.senders ?? defaultSenders();
    if (!senders.ios && !senders.android) return;
    await run(options.admin ?? createSupabaseAdminClient(), senders);
  } catch (error) {
    console.error(`[push] ${label} failed:`, error instanceof Error ? error.message : error);
  }
}

async function memberIds(admin: Admin, organizationId: string, roles?: Array<Tables<"organization_memberships">["role"]>): Promise<string[]> {
  let query = admin.from("organization_memberships").select("profile_id, role").eq("organization_id", organizationId);
  if (roles) query = query.in("role", roles);
  const { data } = await query;
  return (data ?? []).map((m) => m.profile_id);
}

async function contactName(admin: Admin, contactId: string | null): Promise<string | null> {
  if (!contactId) return null;
  const { data } = await admin.from("ui_contact_list_v").select("name").eq("id", contactId).maybeSingle();
  return data?.name ?? null;
}

export function draftReadyMessage(draft: Pick<Tables<"ai_drafts">, "organization_id" | "company_id" | "contact_id" | "sms_body" | "email_subject">, name: string | null): PushMessage {
  const preview = (draft.sms_body ?? draft.email_subject ?? "").trim();
  return {
    title: name ? `Reply ready for ${name}` : "AI reply ready to approve",
    body: preview ? (preview.length > 120 ? `${preview.slice(0, 117)}…` : preview) : "Marina drafted a reply. Tap to review and send.",
    category: "drafts",
    data: { screen: "lead", recordId: draft.contact_id, organizationId: draft.organization_id, companyId: draft.company_id },
  };
}

/** A draft was saved. Everyone in the org except the person who asked for it. */
export function notifyDraftReady(
  draft: Pick<Tables<"ai_drafts">, "organization_id" | "company_id" | "contact_id" | "sms_body" | "email_subject" | "created_by">,
  options: NotifyOptions = {},
): Promise<void> {
  return withPush(
    options,
    async (admin, senders) => {
      const [name, members] = await Promise.all([contactName(admin, draft.contact_id), memberIds(admin, draft.organization_id)]);
      const recipients = members.filter((id) => id !== draft.created_by);
      await sendPushToOrganization(admin, draft.organization_id, draftReadyMessage(draft, name), { recipientUserIds: recipients, senders });
    },
    "draft notify",
  );
}

export function workflowFailedMessage(
  input: { organizationId: string; companyId: string | null; workflowName: string; failureReason: string; runId: string | null },
): PushMessage {
  const reason = input.failureReason.trim();
  return {
    title: `Workflow failed — ${input.workflowName}`,
    body: reason.length > 140 ? `${reason.slice(0, 137)}…` : reason || "A run errored. Tap to see the trace.",
    category: "workflow_failures",
    data: { screen: input.runId ? "run" : "notifications", recordId: input.runId, organizationId: input.organizationId, companyId: input.companyId },
  };
}

/** A workflow run failed. Owners and admins — the people who can fix a workflow. */
export function notifyWorkflowFailed(
  input: { organizationId: string; companyId: string | null; workflowName: string; failureReason: string; runId: string | null },
  options: NotifyOptions = {},
): Promise<void> {
  return withPush(
    options,
    async (admin, senders) => {
      const recipients = await memberIds(admin, input.organizationId, ["owner", "admin"]);
      await sendPushToOrganization(admin, input.organizationId, workflowFailedMessage(input), { recipientUserIds: recipients, senders });
    },
    "workflow failure notify",
  );
}

/** You were put on a job. Only the people just added. */
export function notifyJobAssigned(
  input: { organizationId: string; companyId: string | null; bookingId: string; title: string; body: string; recipientIds: string[] },
  options: NotifyOptions = {},
): Promise<void> {
  if (input.recipientIds.length === 0) return Promise.resolve();
  return withPush(
    options,
    async (admin, senders) => {
      await sendPushToOrganization(
        admin,
        input.organizationId,
        {
          title: input.title,
          body: input.body,
          // Schedule changes share the "conflicts" (scheduling) channel and its opt-out.
          category: "conflicts",
          data: { screen: "booking", recordId: input.bookingId, organizationId: input.organizationId, companyId: input.companyId },
        },
        { recipientUserIds: input.recipientIds, senders },
      );
    },
    "job assignment notify",
  );
}

/** A customer asked for work from their portal. Owners and admins. */
export function notifyPortalRequest(
  input: { organizationId: string; companyId: string; contactId: string; name: string; message: string },
  options: NotifyOptions = {},
): Promise<void> {
  return withPush(
    options,
    async (admin, senders) => {
      const recipients = await memberIds(admin, input.organizationId, ["owner", "admin"]);
      const preview = input.message.trim();
      await sendPushToOrganization(
        admin,
        input.organizationId,
        {
          title: `Work request from ${input.name}`,
          body: preview.length > 120 ? `${preview.slice(0, 117)}…` : preview,
          category: "leads",
          data: { screen: "lead", recordId: input.contactId, organizationId: input.organizationId, companyId: input.companyId },
        },
        { recipientUserIds: recipients, senders },
      );
    },
    "portal request notify",
  );
}

/** A customer moved or cancelled their visit from its link. Owners, admins and the visit's crew. */
export function notifyVisitChange(
  input: { organizationId: string; companyId: string | null; bookingId: string; title: string; body: string; crewIds: string[] },
  options: NotifyOptions = {},
): Promise<void> {
  return withPush(
    options,
    async (admin, senders) => {
      const managers = await memberIds(admin, input.organizationId, ["owner", "admin"]);
      const recipients = [...new Set([...managers, ...input.crewIds])];
      if (recipients.length === 0) return;
      await sendPushToOrganization(
        admin,
        input.organizationId,
        {
          title: input.title,
          body: input.body.length > 160 ? `${input.body.slice(0, 157)}…` : input.body,
          category: "conflicts",
          data: { screen: "booking", recordId: input.bookingId, organizationId: input.organizationId, companyId: input.companyId },
        },
        { recipientUserIds: recipients, senders },
      );
    },
    "visit change notify",
  );
}

/** A customer booked online (or their deposit came in). Owners and admins. */
export function notifyOnlineBooking(
  input: { organizationId: string; companyId: string | null; bookingId: string; title: string; body: string },
  options: NotifyOptions = {},
): Promise<void> {
  return withPush(
    options,
    async (admin, senders) => {
      const recipients = await memberIds(admin, input.organizationId, ["owner", "admin"]);
      if (recipients.length === 0) return;
      await sendPushToOrganization(
        admin,
        input.organizationId,
        {
          title: input.title,
          body: input.body.length > 160 ? `${input.body.slice(0, 157)}…` : input.body,
          category: "leads",
          data: { screen: "booking", recordId: input.bookingId, organizationId: input.organizationId, companyId: input.companyId },
        },
        { recipientUserIds: recipients, senders },
      );
    },
    "online booking notify",
  );
}
