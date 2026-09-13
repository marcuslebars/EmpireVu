import type { Tables } from "@/server/db/database.types";
import { notifyBookingConflicts } from "@/server/services/push/conflicts";
import { defaultSenders, sendPushToOrganization, type PushMessage } from "@/server/services/push/dispatch";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

/**
 * Activity events → pushes. The web app's bell is the activity feed, so pushes fan out
 * from the same stream. Only events a person should be interrupted for are mapped; the
 * actor who caused an event is never notified about it.
 */
type ActivityEvent = Tables<"activity_events">;

function metadataString(event: ActivityEvent, key: string): string | null {
  const metadata = event.metadata_json as Record<string, unknown> | null;
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function pushMessageForEvent(event: ActivityEvent, contactName: string | null): PushMessage | null {
  const name = contactName ?? metadataString(event, "name") ?? metadataString(event, "contactName");
  const base = { organizationId: event.organization_id, companyId: event.company_id };

  switch (event.event_type) {
    case "contact.created":
      return {
        title: name ? `New lead — ${name}` : "New lead",
        body: metadataString(event, "source") ? `Came in via ${metadataString(event, "source")}.` : "Tap to see the details and reply.",
        category: "leads",
        data: { ...base, screen: "lead", recordId: event.entity_id },
      };
    case "call.urgent":
      return {
        title: name ? `Urgent call — ${name}` : "Urgent call",
        body: metadataString(event, "summary") ?? "Marina flagged this call as urgent.",
        category: "leads",
        urgent: true,
        data: { ...base, screen: "lead", recordId: event.entity_id },
      };
    case "contact.call_completed":
      return {
        title: name ? `Call finished — ${name}` : "Call finished",
        body: metadataString(event, "summary") ?? metadataString(event, "outcome") ?? "Marina took the call. Tap to review.",
        category: "leads",
        data: { ...base, screen: "lead", recordId: event.entity_id },
      };
    case "contact.sms_received":
      return {
        title: name ? `Text from ${name}` : "New text message",
        body: metadataString(event, "body") ?? "Tap to read and reply.",
        category: "leads",
        data: { ...base, screen: "lead", recordId: event.entity_id },
      };
    case "quote.approved":
    case "quote.paid":
    case "quote.deposit_paid":
      return {
        title: event.event_type === "quote.approved" ? "Quote approved" : "Deposit paid",
        body: [name, metadataString(event, "quoteNumber")].filter(Boolean).join(" · ") || "Tap to open the quote.",
        category: "payments",
        data: { ...base, screen: "quote", recordId: event.entity_id },
      };
    default:
      return null;
  }
}

/** Fire-and-forget from createActivityEvent. Never throws; a no-op without a push provider. */
/** Events after which a booking's crew may now be double-booked. */
const CONFLICT_EVENTS = new Set(["booking.created", "booking.rescheduled", "task.assignee_assigned"]);

async function checkConflictsFor(event: ActivityEvent): Promise<void> {
  if (!event.entity_id) return;
  let bookingId: string | null = event.entity_type === "booking" ? event.entity_id : null;
  if (event.entity_type === "task") {
    const { data } = await createSupabaseAdminClient()
      .from("tasks")
      .select("booking_id")
      .eq("organization_id", event.organization_id)
      .eq("id", event.entity_id)
      .maybeSingle();
    bookingId = data?.booking_id ?? null;
  }
  if (bookingId) await notifyBookingConflicts(event.organization_id, bookingId);
}

export async function notifyActivityEvent(event: ActivityEvent | null | undefined): Promise<void> {
  try {
    if (!event?.event_type || !event.organization_id) return;
    if (CONFLICT_EVENTS.has(event.event_type)) {
      const senders = defaultSenders();
      if (senders.ios || senders.android) await checkConflictsFor(event);
      return;
    }
    if (!pushMessageForEvent(event, null)) return;
    const senders = defaultSenders();
    if (!senders.ios && !senders.android) return;

    const admin = createSupabaseAdminClient();

    let contactName: string | null = null;
    if (event.entity_type === "contact" && event.entity_id) {
      const { data } = await admin.from("ui_contact_list_v").select("name").eq("id", event.entity_id).maybeSingle();
      contactName = data?.name ?? null;
    }
    const message = pushMessageForEvent(event, contactName)!;

    const { data: members } = await admin
      .from("organization_memberships")
      .select("profile_id")
      .eq("organization_id", event.organization_id);
    const recipients = (members ?? []).map((m) => m.profile_id).filter((id) => id !== event.actor_user_id);

    await sendPushToOrganization(admin, event.organization_id, message, { recipientUserIds: recipients, senders });
  } catch (error) {
    console.error("[push] activity notify failed:", error instanceof Error ? error.message : error);
  }
}
