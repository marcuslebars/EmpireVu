/**
 * Which numbers a port may touch (docs/ai-staff.md → "Keep your number"). One Twilio account
 * serves every tenant, so — like provision.ts assertNumberClaimable for catcher numbers — a port
 * must never re-point a number that is already ours:
 *   • never the platform number (PLATFORM_SMS_NUMBER / TWILIO_FROM_NUMBER — the owner channel and
 *     a house business's line, which may have no voice_numbers row at all);
 *   • never a number with ANY voice_numbers row, unless it is already this company's business_line
 *     (a catcher row is never converted);
 *   • in the sweep, never a number FriendlyName-tagged for a catcher or another company, nor one
 *     whose webhooks point anywhere but our business-line route (unset ones are fine);
 *   • and only numbers that were NOT in the Twilio account when the port was submitted (the
 *     snapshot taken by markSubmitted) — a number that arrives is the ported one.
 */
import { platformNumber } from "@/server/outbound/platform-number";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { toE164 } from "@/server/services/retell/payload";
import { BUSINESS_LINE_MODE } from "@/server/services/staff/porting/db-types";
import { findVoiceNumberOwner } from "@/server/services/twilio/missed-call";
import type { TwilioIncomingNumber } from "@/server/services/twilio/provision";

export const CATCHER_TAG_PREFIX = "EmpireVu catcher ";
export const LINE_TAG_PREFIX = "EmpireVu line ";

/** The platform's own numbers (E.164), from the env. */
export function platformNumbers(env: Record<string, string | undefined> = process.env): Set<string> {
  const out = new Set<string>();
  for (const raw of [platformNumber(), env.PLATFORM_SMS_NUMBER, env.TWILIO_FROM_NUMBER, env.TWILIO_FORWARDING_TEST_FROM]) {
    const e = toE164(raw ?? null);
    if (e) out.add(e);
  }
  return out;
}

export interface PortableVerdict {
  ok: boolean;
  reason: "platform" | "connected" | null;
}

/** May this company port `phone` in? (Form + sweep.) */
export async function checkPortable(admin: AdminClient, scope: { organizationId: string; companyId: string }, phone: string): Promise<PortableVerdict> {
  const e164 = toE164(phone) ?? phone;
  if (platformNumbers().has(e164)) return { ok: false, reason: "platform" };
  const owner = await findVoiceNumberOwner(admin, e164);
  if (!owner) return { ok: true, reason: null };
  const ownLine = owner.organization_id === scope.organizationId && owner.company_id === scope.companyId && owner.provider === "twilio" && owner.mode === BUSINESS_LINE_MODE;
  return ownLine ? { ok: true, reason: null } : { ok: false, reason: "connected" };
}

export function portableMessage(reason: "platform" | "connected"): string {
  return reason === "platform"
    ? "That number can't be moved here. Enter your own business number."
    : "That number is already connected to us (for example your text-back number). Enter the business number your customers call.";
}

function configured(url: string | null | undefined): boolean {
  const v = url?.trim();
  return Boolean(v) && !/^https?:\/\/demo\.twilio\.com\//i.test(v ?? "");
}

/** The Twilio-side checks before the sweep touches a landed number. PURE. */
export function twilioSideOk(number: TwilioIncomingNumber, companyId: string, businessLineUrl: string): boolean {
  const tag = number.friendly_name ?? "";
  if (tag.startsWith(CATCHER_TAG_PREFIX)) return false;
  if (tag.startsWith(LINE_TAG_PREFIX) && tag !== `${LINE_TAG_PREFIX}${companyId}`) return false;
  if (!configured(number.voice_url) && !configured(number.sms_url)) return true;
  return number.voice_url === businessLineUrl;
}
