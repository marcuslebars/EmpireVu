/**
 * CrankLeads purchase emails — PURE renderers (golden-tested in src/test/crankleads-purchase.test.ts).
 *
 * The buyer bought CrankLeads, and CrankLeads is what they log into: their account is a
 * CrankLeads-branded org (organizations.platform_brand = 'crankleads') on the CrankLeads app
 * host (appBaseUrlFor("crankleads"): CRANKLEADS_APP_BASE_URL once set, else APP_BASE_URL). Copy
 * names the host of the actual link (appHostOf), never a hard-coded one. These emails never say
 * "EmpireVu" (docs/crankleads-branding.md). No prices in here (Working Protocol #4).
 */
import { PLATFORM_BRANDS } from "@/lib/platform-brand";
import { CRANKLEADS_OFFER_NAME, CRANKLEADS_TIER_LABELS, type CrankleadsTier } from "@/server/services/crankleads/config";

/** The app the buyer logs into. */
export const APP_PRODUCT_NAME = PLATFORM_BRANDS.crankleads.name;

/** The host of the app URL, for copy ("log in at <host>"). */
export function appHostOf(appUrl: string): string {
  try {
    return new URL(appUrl).host;
  } catch {
    return appUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

export interface RenderedEmail {
  subject: string;
  body: string;
  html: string;
  fromName: string;
}

export interface WelcomeEmailInput {
  ownerName: string;
  businessName: string;
  tier: CrankleadsTier;
  /** Set-password link (new user) — null for someone who already had a login. */
  setPasswordUrl: string | null;
  /** The 60-second quick-setup link (/setup/:token) — null if it couldn't be made. */
  setupUrl?: string | null;
  /** Sign-in / onboarding link. */
  appUrl: string;
  /** Hosted website-form link, when the form key exists. */
  formUrl: string | null;
  /** Name of the industry pack applied, if any. */
  packName: string | null;
  servicesNeedingPrices: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || "there";
}

/** What is already done for them (same list in text + HTML). */
function doneList(input: WelcomeEmailInput): string[] {
  const done = [
    `Your ${APP_PRODUCT_NAME} account and business profile for ${input.businessName}`,
  ];
  if (input.packName) {
    done.push(`Your ${input.packName} starter pack: services and messages written for your trade`);
  }
  if (input.formUrl) done.push("Your website lead form (link below)");
  return done;
}

/** What we build for them once they answer the quick setup (no DIY steps). */
function buildList(input: WelcomeEmailInput): string[] {
  return [
    "Your hours, service area, logo and Google review link",
    "Your services and prices (only the ones you give us or that are on your website — nothing made up)",
    input.tier === "front_desk"
      ? "Your text-back number, missed-call text-back and your AI receptionist"
      : "Your text-back number and missed-call text-back",
    "A web page for your business with your services, any prices you give us and a quote form",
  ];
}

export function renderWelcomeEmail(input: WelcomeEmailInput): RenderedEmail {
  const tierLabel = CRANKLEADS_TIER_LABELS[input.tier];
  const subject = `You're in — we're setting up ${CRANKLEADS_OFFER_NAME} for you`;
  const done = doneList(input);
  const build = buildList(input);
  const host = appHostOf(input.appUrl);
  const setupLines = input.setupUrl
    ? [
        "Check your texts: we just sent you a link to a 60-second quick setup — 3 questions, no login. Here it is too:",
        input.setupUrl,
      ]
    : ["Check your texts: we're sending you a link to a 60-second quick setup — 3 questions, no login."];
  const loginLine = input.setPasswordUrl
    ? `You can still log in to ${APP_PRODUCT_NAME} at ${host} any time — set your password here:\n${input.setPasswordUrl}\n(This link works once and expires — if it has, use "Forgot password" at ${input.appUrl}/forgot-password with this email address.)`
    : `You can still log in to ${APP_PRODUCT_NAME} at ${host} with your existing login — ${input.businessName} is now in your account list:\n${input.appUrl}/onboarding`;

  const body = [
    `Hi ${firstName(input.ownerName)},`,
    "",
    `Thanks for buying ${CRANKLEADS_OFFER_NAME} ${tierLabel}. You don't have to set anything up — we're setting up ${input.businessName} for you.`,
    "",
    ...setupLines,
    "",
    "Once you answer, we build the rest:",
    ...build.map((line) => `  • ${line}`),
    "",
    "Then we text you one link to turn on call forwarding on your business phone. We test it and text you when you're live.",
    "",
    "Already done:",
    ...done.map((line) => `  • ${line}`),
    "",
    loginLine,
    ...(input.formUrl ? ["", `Your website lead form: ${input.formUrl}`, "(Share it on Google, Facebook or by text — leads land in your inbox right away.)"] : []),
    "",
    "Questions? Just reply to this email.",
    "",
    `— The ${CRANKLEADS_OFFER_NAME} team`,
  ].join("\n");

  const li = (items: string[]) => items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const button = (href: string, label: string) =>
    `<p><a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 20px;background:#111827;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600">${escapeHtml(label)}</a></p>`;
  const html = [
    `<p>Hi ${escapeHtml(firstName(input.ownerName))},</p>`,
    `<p>Thanks for buying ${CRANKLEADS_OFFER_NAME} ${escapeHtml(tierLabel)}. You don't have to set anything up — we're setting up <strong>${escapeHtml(input.businessName)}</strong> for you.</p>`,
    input.setupUrl
      ? `<p><strong>Check your texts:</strong> we just sent you a link to a 60-second quick setup — 3 questions, no login. Here it is too:</p>${button(input.setupUrl, "Start the 60-second setup")}`
      : "<p><strong>Check your texts:</strong> we're sending you a link to a 60-second quick setup — 3 questions, no login.</p>",
    `<p>Once you answer, we build the rest:</p><ul>${li(build)}</ul>`,
    `<p>Then we text you one link to turn on call forwarding on your business phone. We test it and text you when you're live.</p>`,
    `<p><strong>Already done:</strong></p><ul>${li(done)}</ul>`,
    input.setPasswordUrl
      ? `<p>You can still log in to ${APP_PRODUCT_NAME} at <a href="${escapeHtml(input.appUrl)}">${escapeHtml(host)}</a> any time: <a href="${escapeHtml(input.setPasswordUrl)}">set your password</a>.</p><p style="font-size:12px;color:#6b7280">That link works once and expires. If it has, use “Forgot password” at ${escapeHtml(input.appUrl)}/forgot-password with this email address.</p>`
      : `<p>You can still log in to ${APP_PRODUCT_NAME} at <a href="${escapeHtml(`${input.appUrl}/onboarding`)}">${escapeHtml(host)}</a> with your existing login — ${escapeHtml(input.businessName)} is now in your account list.</p>`,
    input.formUrl
      ? `<p>Your website lead form: <a href="${escapeHtml(input.formUrl)}">${escapeHtml(input.formUrl)}</a><br><span style="font-size:12px;color:#6b7280">Share it on Google, Facebook or by text — leads land in your inbox right away.</span></p>`
      : "",
    `<p>Questions? Just reply to this email.</p><p>— The ${CRANKLEADS_OFFER_NAME} team</p>`,
  ].join("\n");

  return { subject, body, html, fromName: CRANKLEADS_OFFER_NAME };
}

export interface OperatorEmailInput {
  businessName: string;
  businessType: string;
  tier: CrankleadsTier;
  ownerName: string;
  ownerEmail: string;
  ownerPhone: string;
  organizationId: string | null;
  sessionId: string | null;
  existingUser: boolean | null;
  packId: string | null;
  welcomeEmailError: string | null;
  appUrl: string;
}

export function renderOperatorNewPurchaseEmail(input: OperatorEmailInput): RenderedEmail {
  const tierLabel = CRANKLEADS_TIER_LABELS[input.tier];
  const subject = `New ${CRANKLEADS_OFFER_NAME} purchase: ${input.businessName} (${tierLabel})`;
  const lines = [
    subject,
    "",
    `Owner: ${input.ownerName} <${input.ownerEmail}> ${input.ownerPhone}`,
    `Business type: ${input.businessType} → pack ${input.packId ?? "(none — generic)"}`,
    `Organization: ${input.organizationId ?? "-"}${input.existingUser ? " (added to an EXISTING user)" : ""}`,
    `Checkout session: ${input.sessionId ?? "-"}`,
    input.welcomeEmailError
      ? `WELCOME EMAIL FAILED: ${input.welcomeEmailError} — resend from the welcome page or send them a reset link.`
      : "Welcome email sent.",
    "",
    `Ops: ${input.appUrl}/internal/ops`,
  ];
  const body = lines.join("\n");
  return { subject, body, html: `<pre style="font-family:ui-monospace,monospace">${escapeHtml(body)}</pre>`, fromName: CRANKLEADS_OFFER_NAME };
}

export interface OperatorFailureEmailInput {
  businessName: string;
  tier: CrankleadsTier | null;
  ownerEmail: string;
  sessionId: string | null;
  error: string;
}

export function renderOperatorFailureEmail(input: OperatorFailureEmailInput): RenderedEmail {
  const subject = `ACTION NEEDED: ${CRANKLEADS_OFFER_NAME} provisioning failed — ${input.businessName} (${input.tier ? CRANKLEADS_TIER_LABELS[input.tier] : "unknown tier"})`;
  const body = [
    "A paid CrankLeads purchase could not be set up automatically. The payment is safe and recorded",
    "(crankleads_purchases.status = 'failed'); nothing is lost.",
    "",
    `Buyer: ${input.ownerEmail}`,
    `Checkout session: ${input.sessionId ?? "-"}`,
    `Error: ${input.error}`,
    "",
    "Fix the cause, then re-run (PowerShell, from the repo):",
    `  npm run job:crankleads-provision -- --session ${input.sessionId ?? "<cs_...>"}`,
  ].join("\n");
  return { subject, body, html: `<pre style="font-family:ui-monospace,monospace">${escapeHtml(body)}</pre>`, fromName: CRANKLEADS_OFFER_NAME };
}
