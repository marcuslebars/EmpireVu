/**
 * CrankLeads setup follow-up messages — PURE renderers (golden-tested in
 * src/test/crankleads-setup-followups.test.ts). Purchase-context, so they are sent as
 * CrankLeads (sender name CRANKLEADS_OFFER_NAME); the app the owner logs into stays EmpireVu.
 * No prices (Working Protocol #4). No employee names (Protocol #16) — "your AI receptionist".
 *
 * Short, friendly, specific: every reminder names the exact unfinished steps and links
 * straight to the next one.
 */
import { CRANKLEADS_OFFER_NAME, CRANKLEADS_TIER_LABELS, type CrankleadsTier } from "@/server/services/crankleads/config";
import { APP_PRODUCT_NAME, type RenderedEmail } from "@/server/services/crankleads/emails";
import type { ReminderStage } from "@/server/services/crankleads/followup-schedule";
import type { PhonePath } from "@/server/services/crankleads/setup-checklist";

export interface FollowupStepLine {
  title: string;
  action: string;
}

export interface ReminderMessageInput {
  stage: ReminderStage;
  ownerName: string;
  businessName: string;
  /** Unfinished required steps, in order (the first is the next step). Never empty. */
  remaining: FollowupStepLine[];
  /** One-click deep link to the next step's wizard screen. */
  nextStepUrl: string;
  /** Set when the owner has never signed in: a one-time set-password link that lands on the next step. */
  setPasswordUrl: string | null;
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

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function stepsLeft(n: number): string {
  return `${n} step${n === 1 ? "" : "s"} left`;
}

/** "A", "A and B" — longer lists collapse to "A (+2 more)" so a text stays short. */
function summarizeActions(remaining: FollowupStepLine[]): string {
  if (remaining.length === 1) return remaining[0].action;
  if (remaining.length === 2) return `${remaining[0].action} and ${remaining[1].action}`;
  return `${remaining[0].action} (+${remaining.length - 1} more)`;
}

const REMINDER_INTRO: Record<ReminderStage, string> = {
  day1: "You're almost there — a couple of quick steps and your system starts catching leads.",
  day3: "Quick nudge: your system isn't catching leads yet because setup isn't finished.",
  day5: "Your system still isn't live. Every missed call until then is a lead that doesn't get a text back.",
  day10: "Last nudge from us: setup still isn't finished. Want a hand? Reply to this email and we'll walk you through it.",
};

function reminderSubject(input: ReminderMessageInput): string {
  const left = stepsLeft(input.remaining.length);
  switch (input.stage) {
    case "day1":
      return `${capitalize(left)} to get ${input.businessName} live`;
    case "day3":
      return `${input.businessName}: ${left} — next, ${input.remaining[0].action}`;
    case "day5":
      return `Your ${CRANKLEADS_OFFER_NAME} system isn't live yet (${left})`;
    case "day10":
      return `Need a hand finishing setup? (${left})`;
  }
}

export function renderReminderEmail(input: ReminderMessageInput): RenderedEmail {
  const subject = reminderSubject(input);
  const loginNote = input.setPasswordUrl
    ? [
        "",
        `You haven't set your ${APP_PRODUCT_NAME} password yet — this link sets it and takes you straight to the next step:`,
        input.setPasswordUrl,
        `(It works once and expires. If it has, use "Forgot password" at ${input.appUrl}/forgot-password.)`,
      ]
    : [];
  const body = [
    `Hi ${firstName(input.ownerName)},`,
    "",
    REMINDER_INTRO[input.stage],
    "",
    `${capitalize(stepsLeft(input.remaining.length))}:`,
    ...input.remaining.map((step, i) => `  ${i + 1}. ${capitalize(step.action)}`),
    "",
    `Do the next one now (one click): ${input.nextStepUrl}`,
    ...loginNote,
    "",
    "Questions? Just reply to this email.",
    "",
    `— The ${CRANKLEADS_OFFER_NAME} team`,
    "",
    `Don't want these setup reminders? Stop them: ${input.stopUrl}`,
  ].join("\n");

  const button = (href: string, label: string) =>
    `<p><a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 20px;background:#111827;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600">${escapeHtml(label)}</a></p>`;
  const html = [
    `<p>Hi ${escapeHtml(firstName(input.ownerName))},</p>`,
    `<p>${escapeHtml(REMINDER_INTRO[input.stage])}</p>`,
    `<p><strong>${escapeHtml(capitalize(stepsLeft(input.remaining.length)))}:</strong></p>`,
    `<ol>${input.remaining.map((step) => `<li>${escapeHtml(capitalize(step.action))}</li>`).join("")}</ol>`,
    input.setPasswordUrl
      ? `${button(input.setPasswordUrl, `Set your password and ${input.remaining[0].title.charAt(0).toLowerCase()}${input.remaining[0].title.slice(1)}`)}<p style="font-size:12px;color:#6b7280">This link works once and expires. If it has, use “Forgot password” at ${escapeHtml(input.appUrl)}/forgot-password.</p>`
      : button(input.nextStepUrl, input.remaining[0].title),
    `<p>Questions? Just reply to this email.</p><p>— The ${CRANKLEADS_OFFER_NAME} team</p>`,
    `<p style="font-size:12px;color:#6b7280">Don't want these setup reminders? <a href="${escapeHtml(input.stopUrl)}">Stop them</a>.</p>`,
  ].join("\n");

  return { subject, body, html, fromName: CRANKLEADS_OFFER_NAME };
}

/**
 * The reminder text. Always ends with the deep link + the STOP line (Twilio's carrier-level
 * STOP handling stops further texts from the platform number).
 */
export function renderReminderSms(input: ReminderMessageInput): string {
  const left = stepsLeft(input.remaining.length);
  const lead =
    input.stage === "day10"
      ? `${CRANKLEADS_OFFER_NAME}: Hi ${firstName(input.ownerName)}, last nudge — ${input.businessName} still has ${left}: ${summarizeActions(input.remaining)}. Reply to our email if you want a hand.`
      : `${CRANKLEADS_OFFER_NAME}: Hi ${firstName(input.ownerName)}, ${left} to get ${input.businessName} live: ${summarizeActions(input.remaining)}.`;
  return `${lead} ${input.nextStepUrl}\nReply STOP to stop these texts.`;
}

// ── "You're live" ─────────────────────────────────────────────────────────────

export interface LiveMessageInput {
  ownerName: string;
  businessName: string;
  phonePath: PhonePath;
  appUrl: string;
}

function liveWhat(phonePath: PhonePath): string {
  return phonePath === "ai_receptionist"
    ? "your AI receptionist answers every call, and website leads land in your inbox"
    : "missed callers get a text back in seconds, and website leads land in your inbox";
}

export function renderLiveEmail(input: LiveMessageInput): RenderedEmail {
  const subject = `🎉 You're live — ${input.businessName} is catching leads`;
  const body = [
    `Hi ${firstName(input.ownerName)},`,
    "",
    `🎉 You're live! Setup is done: ${liveWhat(input.phonePath)}.`,
    "",
    `Every new lead shows up in ${APP_PRODUCT_NAME}: ${input.appUrl}`,
    "",
    "No more setup reminders from us. Questions? Just reply to this email.",
    "",
    `— The ${CRANKLEADS_OFFER_NAME} team`,
  ].join("\n");
  const html = [
    `<p>Hi ${escapeHtml(firstName(input.ownerName))},</p>`,
    `<p>🎉 <strong>You're live!</strong> Setup is done: ${escapeHtml(liveWhat(input.phonePath))}.</p>`,
    `<p>Every new lead shows up in ${APP_PRODUCT_NAME}: <a href="${escapeHtml(input.appUrl)}">${escapeHtml(input.appUrl)}</a></p>`,
    `<p>No more setup reminders from us. Questions? Just reply to this email.</p><p>— The ${CRANKLEADS_OFFER_NAME} team</p>`,
  ].join("\n");
  return { subject, body, html, fromName: CRANKLEADS_OFFER_NAME };
}

export function renderLiveSms(input: LiveMessageInput): string {
  return `${CRANKLEADS_OFFER_NAME}: 🎉 You're live! ${input.businessName} is set up — ${liveWhat(input.phonePath)}. ${input.appUrl}`;
}

// ── Operator: buyer stuck after the day-10 reminder ──────────────────────────

export interface OperatorStuckEmailInput {
  businessName: string;
  tier: CrankleadsTier;
  ownerName: string;
  ownerEmail: string;
  ownerPhone: string;
  organizationId: string;
  provisionedAt: string;
  steps: Array<{ title: string; done: boolean }>;
  appUrl: string;
}

export function renderOperatorStuckEmail(input: OperatorStuckEmailInput): RenderedEmail {
  const left = input.steps.filter((s) => !s.done).length;
  const subject = `${CRANKLEADS_OFFER_NAME} buyer stuck: ${input.businessName} (${CRANKLEADS_TIER_LABELS[input.tier]}) — ${stepsLeft(left)} after 10 business days`;
  const body = [
    subject,
    "",
    "They got the day-1/3/5/10 reminders (email + text) and still haven't finished setup. A personal call usually fixes it.",
    "",
    `Owner: ${input.ownerName} <${input.ownerEmail}> ${input.ownerPhone}`,
    `Organization: ${input.organizationId}`,
    `Provisioned: ${input.provisionedAt}`,
    "",
    "Setup checklist:",
    ...input.steps.map((s) => `  [${s.done ? "x" : " "}] ${s.title}`),
    "",
    `Ops: ${input.appUrl}/internal/ops`,
  ].join("\n");
  return { subject, body, html: `<pre style="font-family:ui-monospace,monospace">${escapeHtml(body)}</pre>`, fromName: CRANKLEADS_OFFER_NAME };
}
