/**
 * Front Desk: is there EVIDENCE that the business line forwards to the AI receptionist?
 * (docs/done-for-you.md → "Front Desk").
 *
 * The AI number is a Retell number, so our Twilio forwarding test can't watch the forwarded leg.
 * Retell's call webhook gives us `from_number`, `to_number` and `direction`, and no standard
 * forwarded-from / SIP Diversion field — but if a carrier's diversion info ever appears in the
 * stored payload we use it. The exact rule:
 *
 *   A Front Desk company's forwarding counts as verified when a call to the AI receptionist
 *   (retell_calls row for the company, to its active AI number when we know it, not outbound) is
 *   EITHER
 *     (a) marked forwarded from the business line — a `forwarded_from` / `diversion` /
 *         `redirecting_number` value (top level, under `call`, or in `sip_headers` /
 *         `custom_sip_headers` / `telephony_identifier`) whose last 10 digits equal the business
 *         line (brand_reply_phone ?? owner_phone_e164); OR
 *     (b) received AFTER the owner said they turned forwarding on (dfy_progress.forward_tapped_at)
 *         from a caller that is NOT the business line itself and NOT the AI number.
 *
 * A call that merely reached the AI number (an owner dialling the AI number directly from their
 * business phone, or a call before the tap) is NOT evidence. voice_numbers.forwarding_verified_at
 * on the AI number (set elsewhere) still counts on its own.
 */
import { toE164 } from "@/server/services/retell/payload";

export interface ReceptionistCallFacts {
  from_number: string | null;
  to_number: string | null;
  direction: string | null;
  created_at: string | null;
  start_timestamp?: string | null;
  raw_payload?: unknown;
}

const DIVERSION_KEYS = ["forwarded_from", "forwardedFrom", "ForwardedFrom", "diversion", "Diversion", "redirecting_number", "redirectingNumber"];
const NESTED = ["call", "sip_headers", "custom_sip_headers", "telephony_identifier"];

function last10(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/** Any forwarded-from / diversion number carried in the stored Retell payload. PURE. */
export function diversionNumbers(payload: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || depth > 2) return;
    const obj = value as Record<string, unknown>;
    for (const key of DIVERSION_KEYS) {
      const v = obj[key];
      if (typeof v === "string") {
        // A SIP Diversion header looks like "<sip:+17055550142@carrier>;reason=no-answer".
        const match = v.match(/\+?\d[\d\s().-]{8,}\d/);
        if (match) found.push(match[0]);
      }
    }
    for (const key of NESTED) visit(obj[key], depth + 1);
  };
  visit(payload, 0);
  return found;
}

/** PURE: does this call show the business line forwards to the AI receptionist? */
export function isForwardedReceptionistCall(
  call: ReceptionistCallFacts,
  context: { businessLine: string | null; aiNumber: string | null; forwardTappedAt: string | null },
): boolean {
  if ((call.direction ?? "inbound").toLowerCase() === "outbound") return false;
  const ai = last10(context.aiNumber);
  if (ai && last10(call.to_number) && last10(call.to_number) !== ai) return false;
  const business = last10(context.businessLine);
  // (a) explicit diversion from the business line
  if (business && diversionNumbers(call.raw_payload).some((n) => last10(n) === business)) return true;
  // (b) after the owner's tap, from someone other than the business line / the AI number
  if (!context.forwardTappedAt) return false;
  const tapped = Date.parse(context.forwardTappedAt);
  const startedRaw = call.start_timestamp ?? call.created_at;
  const started = startedRaw && /^\d+$/.test(startedRaw) ? Number(startedRaw) : Date.parse(startedRaw ?? "");
  if (!Number.isFinite(tapped) || !Number.isFinite(started) || started < tapped) return false;
  const caller = last10(call.from_number);
  if (!caller) return false;
  if (business && caller === business) return false;
  if (ai && caller === ai) return false;
  return true;
}

/** Business line (same rule as resolveBusinessLine in twilio/forwarding-test.ts). */
export function businessLineOf(company: { brand_reply_phone?: string | null; owner_phone_e164?: string | null } | null): string | null {
  return toE164(company?.brand_reply_phone) ?? toE164(company?.owner_phone_e164) ?? null;
}

// Minimal query surface shared by the RLS client and the service-role client.
type Db = {
  from: (table: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};

/**
 * Load the facts and apply the rule for one company. Every query is filtered by
 * organization_id + company_id. Errors → false (no evidence).
 */
export async function hasFrontDeskForwardingEvidence(
  db: Db,
  input: { organizationId: string; companyId: string; aiNumber: string | null; businessLine: string | null; forwardTappedAt?: string | null },
): Promise<boolean> {
  try {
    let tappedAt = input.forwardTappedAt;
    if (tappedAt === undefined) {
      const { data } = await db
        .from("dfy_progress")
        .select("forward_tapped_at")
        .eq("organization_id", input.organizationId)
        .eq("company_id", input.companyId)
        .maybeSingle();
      tappedAt = (data as { forward_tapped_at: string | null } | null)?.forward_tapped_at ?? null;
    }
    const { data, error } = await db
      .from("retell_calls")
      .select("from_number, to_number, direction, created_at, start_timestamp, raw_payload")
      .eq("organization_id", input.organizationId)
      .eq("company_id", input.companyId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) return false;
    return ((data ?? []) as ReceptionistCallFacts[]).some((call) =>
      isForwardedReceptionistCall(call, { businessLine: input.businessLine, aiNumber: input.aiNumber, forwardTappedAt: tappedAt ?? null }),
    );
  } catch {
    return false;
  }
}
