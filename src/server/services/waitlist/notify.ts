/**
 * Operator notification when someone joins the empirevu.com waitlist.
 *
 * Best-effort, like lead-intake/notify.ts: a signup is already recorded by the
 * time this runs, so a failed notification must NEVER surface as a failed signup.
 * Every path is wrapped and nothing here throws.
 *
 * Fires whichever channels are configured — set either, both, or none:
 *   • email  — WAITLIST_NOTIFY_EMAIL  (uses the shared Resend sender)
 *   • Slack  — WAITLIST_SLACK_WEBHOOK_URL  (an incoming-webhook URL)
 */
import { isEmailSendConfigured, sendEmail } from "@/server/outbound/email";

export interface WaitlistSignup {
  email: string;
  business: string | null;
  source: string;
}

export async function notifyNewWaitlistSignup(signup: WaitlistSignup): Promise<void> {
  // allSettled: run both channels, and let neither one's failure affect the other
  // or the caller.
  await Promise.allSettled([notifyByEmail(signup), notifyBySlack(signup)]);
}

async function notifyByEmail(signup: WaitlistSignup): Promise<void> {
  const to = process.env.WAITLIST_NOTIFY_EMAIL;
  if (!to || !isEmailSendConfigured()) {
    return;
  }
  const who = signup.business ? `${signup.email} (${signup.business})` : signup.email;
  try {
    await sendEmail({
      to,
      fromName: "EmpireVu",
      subject: `New EmpireVu waitlist signup: ${signup.email}`,
      body:
        `${who} just joined the EmpireVu waitlist.\n\n` +
        `Email:    ${signup.email}\n` +
        `Business: ${signup.business ?? "—"}\n` +
        `Source:   ${signup.source}\n`,
    });
  } catch (err) {
    console.error("[waitlist/notify] email failed:", err instanceof Error ? err.message : err);
  }
}

async function notifyBySlack(signup: WaitlistSignup): Promise<void> {
  const url = process.env.WAITLIST_SLACK_WEBHOOK_URL;
  if (!url) {
    return;
  }
  const suffix = signup.business ? ` — ${signup.business}` : "";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `:tada: New EmpireVu waitlist signup: *${signup.email}*${suffix}` }),
    });
    if (!res.ok) {
      console.error(`[waitlist/notify] Slack webhook rejected (${res.status})`);
    }
  } catch (err) {
    console.error("[waitlist/notify] Slack failed:", err instanceof Error ? err.message : err);
  }
}
