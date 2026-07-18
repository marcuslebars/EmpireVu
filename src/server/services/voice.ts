import type { Tables } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";
import type { TenantServiceContext } from "@/server/services/shared";
import { placeOutboundCall, readVoiceConfig, type PlaceCallResult } from "@/server/outbound/voice";

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
  return placeOutboundCall(
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
}
