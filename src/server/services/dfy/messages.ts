/**
 * Done-for-you messages — PURE renderers (golden-tested in src/test/dfy-autolive.test.ts).
 * Owner-facing copy is short, contractor-voice, Canadian spelling, sent as CrankLeads (never
 * "EmpireVu"); no prices, no invented facts. Operator emails are plain text in a <pre>.
 */
import { prettyPhone, type ForwardingPlan } from "@/lib/carrier-forwarding";
import { CRANKLEADS_OFFER_NAME, CRANKLEADS_TIER_LABELS, type CrankleadsTier } from "@/server/services/crankleads/config";
import type { RenderedEmail } from "@/server/services/crankleads/emails";

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || "there";
}

function pre(body: string): string {
  return `<pre style="font-family:ui-monospace,monospace;white-space:pre-wrap">${escapeHtml(body)}</pre>`;
}

function button(href: string, label: string): string {
  return `<p><a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 20px;background:#111827;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600">${escapeHtml(label)}</a></p>`;
}

// ── Forwarding link (owner) ──────────────────────────────────────────────────

export interface ForwardingMessageInput {
  ownerName: string;
  businessName: string;
  forwardUrl: string;
  /** What the forwarded calls get: the text-back (catcher) or the AI receptionist. */
  phonePath: "missed_call_catcher" | "ai_receptionist";
  method: ForwardingPlan["method"];
}

function forwardingWhy(phonePath: ForwardingMessageInput["phonePath"]): string {
  return phonePath === "ai_receptionist"
    ? "so your AI receptionist picks up the calls you miss"
    : "so every call you miss gets a text back in seconds";
}

export function renderForwardingSms(input: ForwardingMessageInput): string {
  const how = input.method === "dial_code" ? "It's one tap" : "Here's how (2 min)";
  return (
    `${CRANKLEADS_OFFER_NAME}: Hi ${firstName(input.ownerName)}, ${input.businessName} is almost live. ` +
    `Last step: turn on call forwarding ${forwardingWhy(input.phonePath)}. ${how}: ${input.forwardUrl}\nReply STOP to stop these texts.`
  );
}

export function renderForwardingEmail(input: ForwardingMessageInput): RenderedEmail {
  const subject = `Last step for ${input.businessName}: turn on call forwarding`;
  const body = [
    `Hi ${firstName(input.ownerName)},`,
    "",
    `We've set up ${input.businessName}. One thing only you can do: turn on call forwarding on your business phone, ${forwardingWhy(input.phonePath)}.`,
    "",
    `Open this on your business phone: ${input.forwardUrl}`,
    "",
    "Your phone still rings first — only the calls you miss or can't take are forwarded. We test it automatically and text you when it works.",
    "",
    "Rather we did it? Open the link and tap \"Have us set it up\" — we'll call you.",
    "",
    `— The ${CRANKLEADS_OFFER_NAME} team`,
  ].join("\n");
  const html = [
    `<p>Hi ${escapeHtml(firstName(input.ownerName))},</p>`,
    `<p>We've set up ${escapeHtml(input.businessName)}. One thing only you can do: turn on call forwarding on your business phone, ${escapeHtml(forwardingWhy(input.phonePath))}.</p>`,
    button(input.forwardUrl, "Turn on forwarding"),
    "<p>Open it on your business phone. Your phone still rings first — only the calls you miss or can't take are forwarded. We test it automatically and text you when it works.</p>",
    "<p>Rather we did it? Open the link and tap “Have us set it up” — we'll call you.</p>",
    `<p>— The ${CRANKLEADS_OFFER_NAME} team</p>`,
  ].join("\n");
  return { subject, body, html, fromName: CRANKLEADS_OFFER_NAME };
}

// ── Operator ─────────────────────────────────────────────────────────────────

export interface OperatorCallInput {
  businessName: string;
  tier: CrankleadsTier;
  ownerName: string;
  ownerPhone: string;
  ownerEmail: string;
  organizationId: string;
  conciergeUrl: string;
  /** What we've done / what's left (from the setup checklist). */
  done: string[];
  left: string[];
  /** One line of context (why we're asking). */
  reason: string;
}

function operatorBody(subject: string, input: OperatorCallInput): string {
  return [
    subject,
    "",
    input.reason,
    "",
    `Owner: ${input.ownerName}  ${prettyPhone(input.ownerPhone)}  <${input.ownerEmail}>`,
    `Plan: ${CRANKLEADS_TIER_LABELS[input.tier]}`,
    "",
    "Done automatically:",
    ...(input.done.length ? input.done.map((d) => `  [x] ${d}`) : ["  (nothing yet)"]),
    "Still to do:",
    ...(input.left.length ? input.left.map((d) => `  [ ] ${d}`) : ["  (nothing — check the console)"]),
    "",
    `Finish it for them: ${input.conciergeUrl}`,
    `Organization: ${input.organizationId}`,
  ].join("\n");
}

/** 24h escalation: "Call <name> <phone> to finish setup". */
export function renderOperatorEscalationEmail(input: OperatorCallInput): RenderedEmail {
  const subject = `Call ${input.ownerName} ${prettyPhone(input.ownerPhone)} to finish setup — ${input.businessName}`;
  return { subject, body: operatorBody(subject, input), html: pre(operatorBody(subject, input)), fromName: CRANKLEADS_OFFER_NAME };
}

/** The owner tapped "Have us set it up" on the forwarding page. */
export function renderOperatorForwardingHelpEmail(input: OperatorCallInput): RenderedEmail {
  const subject = `Call ${input.ownerName} ${prettyPhone(input.ownerPhone)} — wants us to set up call forwarding (${input.businessName})`;
  return { subject, body: operatorBody(subject, input), html: pre(operatorBody(subject, input)), fromName: CRANKLEADS_OFFER_NAME };
}

export interface OperatorNumberFlaggedInput {
  businessName: string;
  organizationId: string;
  error: string;
  attempts: number;
  conciergeUrl: string;
}

export function renderOperatorNumberFlaggedEmail(input: OperatorNumberFlaggedInput): RenderedEmail {
  const subject = `ACTION NEEDED: couldn't buy a phone number for ${input.businessName}`;
  const body = [
    subject,
    "",
    `We tried ${input.attempts} times and gave up. Last error: ${input.error}`,
    "Fix the cause (Twilio / Retell config, area code availability), then buy it from the concierge console —",
    "or clear dfy_progress.number_flagged_at + number_attempts for the company and the sweep retries.",
    "",
    `Concierge: ${input.conciergeUrl}`,
    `Organization: ${input.organizationId}`,
  ].join("\n");
  return { subject, body, html: pre(body), fromName: CRANKLEADS_OFFER_NAME };
}
