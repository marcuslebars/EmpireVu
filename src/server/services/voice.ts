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
import { placeRetellCall, readRetellVoiceConfig } from "@/server/outbound/retell-voice";
import { getRetellConfig } from "@/server/services/retell/config";
import {
  effectiveVoiceForProfile,
  resolveCompanyVoiceProfile,
  type CompanyVoiceProfile,
} from "@/server/services/company-voice-profiles";

type MarinaProvider = "retell" | "cartesia";

/**
 * Which agent places outbound calls: Retell when RETELL_OUTBOUND_ENABLED is set and the
 * outbound voice config is present, otherwise the Cartesia fallback. Null when neither
 * is configured. (To fully retire Cartesia later: leave the flag on and delete the
 * Cartesia branch.)
 */
function selectMarinaProvider(): MarinaProvider | null {
  if (getRetellConfig().outboundEnabled && readRetellVoiceConfig()) return "retell";
  if (readVoiceConfig()) return "cartesia";
  return null;
}

export function isVoiceConfigured(): boolean {
  return selectMarinaProvider() !== null;
}

interface MarinaCallOutcome {
  agentCallId: string | null;
  provider: MarinaProvider;
  toNumber: string;
}

/**
 * Place a Marina call through whichever provider is active. `metadata` is echoed back on
 * Retell's call object so the `call_analyzed` webhook can attach the outcome to the
 * contact; the dynamic variables let the agent greet with the right customer + company
 * name — the fix for the old wrong-company greeting.
 */
async function placeMarinaCall(input: {
  toNumber: string;
  customerName?: string | null;
  companyName?: string | null;
  metadata: Record<string, unknown>;
  /** Per-company profile → the brand's agent (its KB + prompt), caller ID, and context. */
  voiceProfile?: CompanyVoiceProfile | null;
}): Promise<MarinaCallOutcome> {
  const provider = selectMarinaProvider();
  if (!provider) {
    throw new ValidationError(
      "Voice calling is not configured. Either enable Retell (RETELL_OUTBOUND_ENABLED with " +
        "RETELL_API_KEY + RETELL_FROM_NUMBER) or set CARTESIA_API_KEY, CARTESIA_AGENT_ID, and " +
        "CARTESIA_FROM_NUMBER_ID.",
    );
  }

  if (provider === "retell") {
    const globalCfg = readRetellVoiceConfig();
    if (!globalCfg) {
      throw new ValidationError("Retell outbound calling is not configured.");
    }
    // The company's profile overrides the agent (→ its knowledge base + prompt), the
    // caller-ID number, and the brand context; falls back to the global config.
    const { config, dynamicVariables } = effectiveVoiceForProfile(globalCfg, input.voiceProfile ?? null, {
      customerName: input.customerName,
      companyName: input.companyName,
    });
    const result = await placeRetellCall(
      { toNumber: input.toNumber, metadata: input.metadata, dynamicVariables },
      config,
    );
    return { agentCallId: result.callId, provider, toNumber: result.toNumber };
  }

  const result = await placeOutboundCall({ toNumber: input.toNumber, metadata: input.metadata });
  return { agentCallId: result.agentCallId, provider, toNumber: result.toNumber };
}

/** The brand name to greet as, for the outbound dynamic variables. */
async function resolveCompanyName(
  context: TenantServiceContext,
  companyId: string | null | undefined,
): Promise<string | null> {
  if (!companyId) return null;
  const { data } = await context.supabase
    .from("companies")
    .select("name")
    .eq("organization_id", context.organizationId)
    .eq("id", companyId)
    .maybeSingle();
  return (data as { name?: string } | null)?.name ?? null;
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
  // Route the call to THIS lead's brand — the company it came in from — so Marina uses
  // that company's Retell agent (its knowledge base + prompt) and greets correctly.
  const voiceProfile = await resolveCompanyVoiceProfile(context, contact.company_id);
  const companyName = await resolveCompanyName(context, contact.company_id);

  const outcome = await placeMarinaCall({
    toNumber,
    customerName: name || null,
    companyName,
    metadata: {
      contactId: contact.id,
      name: name || undefined,
      organizationId: context.organizationId,
      companyId: contact.company_id,
    },
    voiceProfile,
  });

  // Best-effort: log the placed call on the contact's timeline. The call is already
  // dialing, so a failed activity write must never look like a failed call. `provider`
  // lets the Cartesia poll skip Retell calls (those resolve via the webhook).
  try {
    await createActivityEvent(context, {
      companyId: contact.company_id,
      entityId: contact.id,
      entityType: "contact",
      eventType: "contact.call_placed",
      metadata: {
        agent: "marina",
        provider: outcome.provider,
        agentCallId: outcome.agentCallId,
        channel: "voice",
        toNumber: outcome.toNumber,
      },
    });
  } catch {
    // Recording the call is non-critical — never surface it as a call failure.
  }

  return { agentCallId: outcome.agentCallId, toNumber: outcome.toNumber };
}

/**
 * Ad-hoc call to a raw phone number — no contact record required. Backs the
 * top-bar "Quick call" so the owner can dial a lead (or test Marina) instantly.
 */
export async function callNumberWithMarina(
  context: TenantServiceContext,
  input: { toNumber: string; name?: string | null },
): Promise<PlaceCallResult> {
  const toNumber = toE164(input.toNumber);
  if (!toNumber) {
    throw new ValidationError("That doesn't look like a phone number Marina can call.");
  }

  const name = input.name?.trim() || undefined;
  const outcome = await placeMarinaCall({
    toNumber,
    customerName: name ?? null,
    companyName: null,
    metadata: {
      name,
      organizationId: context.organizationId,
      source: "quick_call",
    },
  });
  return { agentCallId: outcome.agentCallId, toNumber: outcome.toNumber };
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
    const meta = readEventMetadata(event);
    // Retell calls resolve via the call_analyzed webhook, not this Cartesia poll.
    if (meta.provider === "retell") return false;
    const id = meta.agentCallId;
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
