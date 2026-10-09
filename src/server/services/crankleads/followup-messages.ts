/**
 * CrankLeads setup follow-up messages — PURE renderers (golden-tested in
 * src/test/crankleads-setup-followups.test.ts). Purchase-context, so they are sent as
 * CrankLeads (sender name CRANKLEADS_OFFER_NAME), and the app the owner logs into is CrankLeads
 * too (appUrl = the CrankLeads app host). Never "EmpireVu" (docs/crankleads-branding.md).
 * No prices (Working Protocol #4). No employee names (Protocol #16) — "your AI receptionist".
 *
 * Done-for-you (docs/done-for-you.md): we set everything up, so a reminder asks for exactly
 * ONE thing with ONE no-login link — finish the 60-second quick setup, or tap the forwarding
 * link. Never a wizard step, never "connect Stripe".
 */
import { CRANKLEADS_OFFER_NAME } from "@/server/services/crankleads/config";
import type { RenderedEmail } from "@/server/services/crankleads/emails";
import type { ReminderStage } from "@/server/services/crankleads/followup-schedule";
import type { PhonePath } from "@/server/services/crankleads/setup-checklist";
import { prettyPhone } from "@/lib/carrier-forwarding";

export interface FollowupStepLine {
  title: string;
  action: string;
}

export type ReminderAction = "quick_setup" | "forwarding" | "other";

export interface ReminderMessageInput {
  stage: ReminderStage;
  ownerName: string;
  businessName: string;
  /** What the owner should do next: finish the 60-second quick setup, tap the forwarding link, or (rare) something else. */
  action: ReminderAction;
  /** The no-login link for that action (/setup/<token>, /forward/<token>, or the in-app step). */
  actionUrl: string;
  phonePath: PhonePath;
  /** Unfinished REQUIRED steps, in order. Never empty. */
  remaining: FollowupStepLine[];
  appUrl: string;
  /** "Stop these reminders" link (email footer). */
  stopUrl: string;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || "there";
}

function forwardingWhy(phonePath: PhonePath): string {
  return phonePath === "ai_receptionist" ? "so your AI receptionist picks up the calls you miss" : "so every call you miss gets a text back";
}

/** The one sentence that says what to do (shared by the text and the email). */
function actionSentence(input: ReminderMessageInput): string {
  switch (input.action) {
    case "quick_setup":
      return `We're ready to set up ${input.businessName} for you — we just need 60 seconds of info (your website or Google listing, and your business phone).`;
    case "forwarding":
      return `${input.businessName} is one step from live: turn on call forwarding on your business phone ${forwardingWhy(input.phonePath)}. It's one tap.`;
    case "other":
      return `${input.businessName} is almost live — next: ${input.remaining[0].action}.`;
  }
}

function doneForYouLine(action: ReminderAction): string {
  return action === "quick_setup"
    ? "We do the rest for you — your number, your automations and your page."
    : "We've done the rest for you — your number and your automations are ready.";
}

/** "Quick nudge: " + sentence ("We're…" → "we're…" after a prefix). */
function withLead(stage: ReminderStage, sentence: string): string {
  const lead = REMINDER_LEAD[stage];
  // Only our own opening word is lower-cased — never the business name.
  if (!lead || lead.endsWith(". ") || !/^We\b/.test(sentence)) return `${lead}${sentence}`;
  return `${lead}${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`;
}

function actionLabel(action: ReminderAction): string {
  return action === "quick_setup" ? "Finish the 60-second setup" : action === "forwarding" ? "Turn on forwarding" : "Finish setup";
}

const REMINDER_LEAD: Record<ReminderStage, string> = {
  day1: "",
  day3: "Quick nudge: ",
  day5: "Your system still isn't live — every missed call until then is a lead that slips away. ",
  day10: "Last nudge from us: ",
};

function reminderSubject(input: ReminderMessageInput): string {
  if (input.stage === "day10") return `Want us to finish ${input.businessName}'s setup with you?`;
  switch (input.action) {
    case "quick_setup":
      return `60 seconds to finish setting up ${input.businessName}`;
    case "forwarding":
      return `${input.businessName} is one tap from live`;
    case "other":
      return `${input.businessName} is almost live`;
  }
}

export function renderReminderEmail(input: ReminderMessageInput): RenderedEmail {
  const subject = reminderSubject(input);
  const helpLine =
    input.stage === "day10" || input.stage === "day5"
      ? "Rather we did it with you? Reply to this email with a good time to call and we'll finish it together."
      : "Questions? Just reply to this email.";
  const body = [
    `Hi ${firstName(input.ownerName)},`,
    "",
    withLead(input.stage, actionSentence(input)),
    "",
    `${actionLabel(input.action)}: ${input.actionUrl}`,
    "",
    doneForYouLine(input.action),
    helpLine,
    "",
    `— The ${CRANKLEADS_OFFER_NAME} team`,
    "",
    `Don't want these setup reminders? Stop them: ${input.stopUrl}`,
  ].join("\n");

  const html = [
    `<p>Hi ${escapeHtml(firstName(input.ownerName))},</p>`,
    `<p>${escapeHtml(withLead(input.stage, actionSentence(input)))}</p>`,
    `<p><a href="${escapeHtml(input.actionUrl)}" style="display:inline-block;padding:12px 20px;background:#111827;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600">${escapeHtml(actionLabel(input.action))}</a></p>`,
    `<p>${escapeHtml(doneForYouLine(input.action))}</p>`,
    `<p>${escapeHtml(helpLine)}</p><p>— The ${CRANKLEADS_OFFER_NAME} team</p>`,
    `<p style="font-size:12px;color:#6b7280">Don't want these setup reminders? <a href="${escapeHtml(input.stopUrl)}">Stop them</a>.</p>`,
  ].join("\n");

  return { subject, body, html, fromName: CRANKLEADS_OFFER_NAME };
}

/**
 * The reminder text: one action, one no-login link, and the STOP line (Twilio's carrier-level
 * STOP handling stops further texts from the platform number).
 */
export function renderReminderSms(input: ReminderMessageInput): string {
  const hi = `${CRANKLEADS_OFFER_NAME}: Hi ${firstName(input.ownerName)}, `;
  let lead: string;
  switch (input.action) {
    case "quick_setup":
      lead = `${input.stage === "day10" ? "last nudge — " : ""}finish your 60-second setup and we'll switch ${input.businessName} on for you:`;
      break;
    case "forwarding":
      lead = `${input.stage === "day10" ? "last nudge — " : ""}${input.businessName} is one tap from live. Turn on call forwarding ${forwardingWhy(input.phonePath)}:`;
      break;
    case "other":
      lead = `${input.businessName} is almost live — next: ${input.remaining[0].action}:`;
      break;
  }
  return `${hi}${lead} ${input.actionUrl}\nReply STOP to stop these texts.`;
}

// ── "You're live" ─────────────────────────────────────────────────────────────

export interface LiveMessageInput {
  ownerName: string;
  businessName: string;
  phonePath: PhonePath;
  appUrl: string;
  /** The text-back / AI receptionist number (E.164), when known. */
  number: string | null;
  /** Their generated page (company_sites, published), when there is one. */
  siteUrl: string | null;
  /** Email only: a one-time set-password link for an owner who has never signed in (null → appUrl). */
  setPasswordUrl: string | null;
}

/** What's now working, one line each (email bullets; the text uses the first). */
export function liveWorking(input: Pick<LiveMessageInput, "phonePath" | "number" | "siteUrl">): string[] {
  const number = input.number ? ` at ${prettyPhone(input.number)}` : "";
  const lines =
    input.phonePath === "ai_receptionist"
      ? [`Calls you miss go to your AI receptionist${number}. It answers, takes the details and texts you a summary.`]
      : [`Calls you miss are forwarded to your text-back number${number}. The caller gets a text from you in seconds.`];
  lines.push("Every new lead lands in your inbox, and the follow-ups and reminders are switched on.");
  if (input.siteUrl) lines.push(`Your new page is live: ${input.siteUrl}`);
  return lines;
}

export function renderLiveEmail(input: LiveMessageInput): RenderedEmail {
  const subject = `🎉 You're live — ${input.businessName} is catching leads`;
  const working = liveWorking(input);
  const login = input.setPasswordUrl
    ? [`Set your password and log in (works once): ${input.setPasswordUrl}`, `Afterwards, log in any time at ${input.appUrl}`]
    : [`Log in any time: ${input.appUrl}`];
  const body = [
    `Hi ${firstName(input.ownerName)},`,
    "",
    "🎉 You're live! Here's what's working now:",
    ...working.map((line) => `  • ${line}`),
    "",
    ...login,
    "",
    "Questions? Just reply to this email.",
    "",
    `— The ${CRANKLEADS_OFFER_NAME} team`,
  ].join("\n");
  const linkify = (line: string) =>
    escapeHtml(line).replace(/(https?:\/\/[^\s<]+)/g, (url) => `<a href="${url}">${url}</a>`);
  const html = [
    `<p>Hi ${escapeHtml(firstName(input.ownerName))},</p>`,
    `<p>🎉 <strong>You're live!</strong> Here's what's working now:</p>`,
    `<ul>${working.map((line) => `<li>${linkify(line)}</li>`).join("")}</ul>`,
    input.setPasswordUrl
      ? `<p><a href="${escapeHtml(input.setPasswordUrl)}" style="display:inline-block;padding:12px 20px;background:#111827;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600">Set your password and log in</a></p><p style="font-size:12px;color:#6b7280">The button works once. Afterwards, log in at ${escapeHtml(input.appUrl)}.</p>`
      : `<p>Log in any time: <a href="${escapeHtml(input.appUrl)}">${escapeHtml(input.appUrl)}</a></p>`,
    `<p>Questions? Just reply to this email.</p><p>— The ${CRANKLEADS_OFFER_NAME} team</p>`,
  ].join("\n");
  return { subject, body, html, fromName: CRANKLEADS_OFFER_NAME };
}

/** Never carries a set-password link (texts get forwarded and previewed) — the plain app URL only. */
export function renderLiveSms(input: LiveMessageInput): string {
  const number = input.number ? ` ${prettyPhone(input.number)}` : "";
  const what =
    input.phonePath === "ai_receptionist"
      ? `calls you miss now go to your AI receptionist${number}`
      : `missed callers now get a text back from${number || " your text-back number"}`;
  const site = input.siteUrl ? ` Your new page: ${input.siteUrl}` : "";
  return `${CRANKLEADS_OFFER_NAME}: 🎉 You're live! ${input.businessName}: ${what}.${site} Log in: ${input.appUrl}`;
}
