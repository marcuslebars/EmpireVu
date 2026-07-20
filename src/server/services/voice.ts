import type { Tables } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";
import type { TenantServiceContext } from "@/server/services/shared";
import { createActivityEvent } from "@/server/services/activity-events";
import {
  fetchCallDetails,
  placeOutboundCall,
  readVoiceConfig,
  type PlaceCallResult,
} from "@/server/outbound/voice";

export function isVoiceConfigured(): boolean {
  return readVoiceConfig() !== null;
}

/**
 * Best-effort E.164 for the North-American-style numbers this business handles.
 * Returns null when we can't form a plausible number rather than risk dialing junk.
 */
export function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    return digits.length >= 8 ? `+${digits}` : null;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits.length >= 11 ? `+${digits}` : null;
}

export async function callContactWithMarina(
  context: TenantServiceContext,
  contactId: string,
): Promise<PlaceCallResult> {
  const config = readVoiceConfig();
  if (!config) {
    throw new ValidationError(
      "Voice calling is not configured. Set CARTESIA_API_KEY, CARTESIA_AGENT_ID, and CARTESIA_FROM_NUMBER_ID on the server.",
    );
  }

  const { data, error } = await context.supabase
    .from("contacts")
    .select("id, first_name, last_name, phone, company_id")
    .eq("organization_id", context.organizationId)
    .eq("id", contactId)
    .maybeSingle();

  if (error) throw error;
  const contact = data as Pick<
    Tables<"contacts">,
    "id" | "first_name" | "last_name" | "phone" | "company_id"
  > | null;
  if (!contact) throw new ValidationError("Contact not found.");
  if (!contact.phone?.trim()) throw new ValidationError("This lead has no phone number to call.");

  const toNumber = toE164(contact.phone);
  if (!toNumber) throw new ValidationError("This lead's phone number isn't a callable number.");

  const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim();
  const result = await placeOutboundCall(
    {
      toNumber,
      metadata: {
        contactId: contact.id,
        name: name || undefined,
        organizationId: context.organizationId,
        companyId: contact.company_id,
      },
    },
    config,
  );

  // Best-effort: log the placed call on the contact's timeline. The call is
  // already dialing, so a failed activity write must never look like a failed call.
  try {
    await createActivityEvent(context, {
      companyId: contact.company_id,
      entityId: contact.id,
      entityType: "contact",
      eventType: "contact.call_placed",
      metadata: {
        agent: "marina",
        agentCallId: result.agentCallId,
        channel: "voice",
        toNumber: result.toNumber,
      },
    });
  } catch {
    // Recording the call is non-critical — never surface it as a call failure.
  }

  return result;
}

/**
 * Ad-hoc call to a raw phone number — no contact record required. Backs the
 * top-bar "Quick call" so the owner can dial a lead (or test Marina) instantly.
 */
export async function callNumberWithMarina(
  context: TenantServiceContext,
  input: { toNumber: string; name?: string | null },
): Promise<PlaceCallResult> {
  const config = readVoiceConfig();
  if (!config) {
    throw new ValidationError(
      "Voice calling is not configured. Set CARTESIA_API_KEY, CARTESIA_AGENT_ID, and CARTESIA_FROM_NUMBER_ID on the server.",
    );
  }

  const toNumber = toE164(input.toNumber);
  if (!toNumber) {
    throw new ValidationError("That doesn't look like a phone number Marina can call.");
  }

  const name = input.name?.trim() || undefined;
  return placeOutboundCall(
    {
      toNumber,
      metadata: {
        name,
        organizationId: context.organizationId,
        source: "quick_call",
      },
    },
    config,
  );
}

/** Cartesia statuses that mean the call is over and its outcome is final. */
const TERMINAL_CALL_STATUSES = new Set(["completed", "failed"]);

function readEventMetadata(event: Tables<"activity_events">): Record<string, unknown> {
  return event.metadata_json && typeof event.metadata_json === "object" && !Array.isArray(event.metadata_json)
    ? (event.metadata_json as Record<string, unknown>)
    : {};
}

/**
 * Pull outcomes for this contact's placed calls that aren't resolved yet, and
 * record each as a `contact.call_completed` event carrying Marina's summary.
 *
 * Insert-only and idempotent: a placed call counts as resolved once a completed
 * event exists for its agentCallId, so re-running is safe and never duplicates.
 * Calls still ringing are simply skipped and picked up on the next sync.
 */
export async function syncCallOutcomesForContact(
  context: TenantServiceContext,
  contactId: string,
): Promise<{ synced: number }> {
  const config = readVoiceConfig();
  if (!config) {
    return { synced: 0 };
  }

  const { data, error } = await context.supabase
    .from("activity_events")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("entity_type", "contact")
    .eq("entity_id", contactId)
    .in("event_type", ["contact.call_placed", "contact.call_completed"])
    .order("occurred_at", { ascending: false })
    .limit(100);

  if (error) throw error;
  const events = data ?? [];

  const resolved = new Set(
    events
      .filter((event) => event.event_type === "contact.call_completed")
      .map((event) => readEventMetadata(event).agentCallId)
      .filter((id): id is string => typeof id === "string"),
  );

  const pending = events.filter((event) => {
    if (event.event_type !== "contact.call_placed") return false;
    const id = readEventMetadata(event).agentCallId;
    return typeof id === "string" && !resolved.has(id);
  });

  let synced = 0;

  for (const event of pending) {
    const meta = readEventMetadata(event);
    const agentCallId = meta.agentCallId as string;

    try {
      const details = await fetchCallDetails(agentCallId, config);
      if (!details.status || !TERMINAL_CALL_STATUSES.has(details.status)) {
        continue;
      }

      const durationSeconds =
        details.startTime && details.endTime &&
        !Number.isNaN(Date.parse(details.startTime)) &&
        !Number.isNaN(Date.parse(details.endTime))
          ? Math.max(0, Math.round((Date.parse(details.endTime) - Date.parse(details.startTime)) / 1000))
          : null;

      const endedAt =
        details.endTime && !Number.isNaN(Date.parse(details.endTime))
          ? new Date(details.endTime).toISOString()
          : undefined;

      await createActivityEvent(context, {
        companyId: event.company_id,
        entityId: contactId,
        entityType: "contact",
        eventType: "contact.call_completed",
        metadata: {
          agent: "marina",
          agentCallId,
          callStatus: details.status,
          channel: "voice",
          durationSeconds,
          endReason: details.endReason,
          errorMessage: details.errorMessage,
          summary: details.summary,
          toNumber: typeof meta.toNumber === "string" ? meta.toNumber : null,
        },
        occurredAt: endedAt,
      });

      synced += 1;
    } catch {
      // One failed lookup shouldn't block the others — retried on the next sync.
    }
  }

  return { synced };
}
