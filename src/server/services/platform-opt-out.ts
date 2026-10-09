/**
 * Platform-number SMS opt-out (platform_sms_opt_outs, migration 20261009121000): a STOP texted
 * to TWILIO_FROM_NUMBER stops every platform text to that phone — owner-channel replies and
 * approvals, CrankLeads setup reminders, done-for-you forwarding / page texts, the weekly report.
 * deliverMessage(smsFrom: "platform") checks it, so every platform sender respects it.
 *
 * The table is service-role only. With a non-service client the read returns nothing and this
 * fails open (Twilio's own opt-out still blocks the carrier send).
 */
import { normalizePhoneLast10 } from "@/server/services/lead-intake/matching";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export async function isPlatformOptedOut(db: unknown, phone: string | null | undefined): Promise<boolean> {
  const raw = phone?.trim();
  if (!raw) return false;
  try {
    const last10 = normalizePhoneLast10(raw);
    const candidates = [...new Set([raw, last10 ? `+1${last10}` : null].filter((p): p is string => Boolean(p)))];
    const { data } = await (db as Db).from("platform_sms_opt_outs").select("phone_e164, opted_out_at").in("phone_e164", candidates);
    return ((data ?? []) as Array<{ opted_out_at: string | null }>).some((row) => Boolean(row.opted_out_at));
  } catch {
    return false;
  }
}
