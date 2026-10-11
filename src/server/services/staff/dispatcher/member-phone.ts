/**
 * Team members' cell numbers (organization_memberships.phone_e164) for the Dispatcher's crew
 * schedule texts. Members set their own; owners and admins set anyone's (the route checks).
 * The column isn't client-writable, so writes go through the service role, pinned to the org.
 */
import { ValidationError } from "@/server/organizations/context";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db } from "./db-types";

/** PURE: "705-555-0142" / "(705) 555 0142" / "+1 705…" → "+17055550142"; null when it can't be a phone. */
export function normalizeCellPhone(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    return /^[1-9]\d{7,14}$/.test(digits) && !(digits.startsWith("1") && digits.length !== 11) ? `+${digits}` : null;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10 && /^[2-9]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1") && /^[2-9]/.test(digits.slice(1))) return `+${digits}`;
  return null;
}

export async function listMemberPhones(admin: AdminClient, organizationId: string): Promise<Record<string, string | null>> {
  const { data, error } = await (admin as Db).from("organization_memberships").select("profile_id, phone_e164").eq("organization_id", organizationId).limit(1000);
  if (error) throw error;
  return Object.fromEntries(((data ?? []) as Array<{ profile_id: string; phone_e164: string | null }>).map((m) => [m.profile_id, m.phone_e164 ?? null]));
}

/** A member's role in the org (null when not a member). */
export async function memberRole(admin: AdminClient, organizationId: string, profileId: string): Promise<string | null> {
  const { data } = await (admin as Db).from("organization_memberships").select("role").eq("organization_id", organizationId).eq("profile_id", profileId).maybeSingle();
  return (data as { role: string } | null)?.role ?? null;
}

/** A 400 with a readable message (handleRoute passes it through). */
export class MemberPhoneError extends ValidationError {}

/** Set (or clear with null/"") a member's cell. Returns the stored value. */
export async function setMemberPhone(admin: AdminClient, organizationId: string, profileId: string, raw: string | null): Promise<string | null> {
  const phone = raw && raw.trim() ? normalizeCellPhone(raw) : null;
  if (raw && raw.trim() && !phone) throw new MemberPhoneError("That doesn't look like a cell number - use 10 digits, like 705-555-0142.");
  const { data, error } = await (admin as Db)
    .from("organization_memberships")
    .update({ phone_e164: phone })
    .eq("organization_id", organizationId)
    .eq("profile_id", profileId)
    .select("profile_id");
  if (error) throw error;
  if (((data ?? []) as unknown[]).length === 0) throw new MemberPhoneError("That person isn't on this team.");
  return phone;
}
