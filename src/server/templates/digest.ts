/**
 * Owner daily digest templates (Task 15) — PURE render functions so the SMS and email can
 * be golden-tested without a database or a mail server. The digest is company-scoped and
 * owner-facing; it reuses the quote email house style (table-based, inline CSS) via `esc` /
 * `money` from quotes/emails.ts.
 *
 * SMS rule (Amendment 4): hard cap 320 chars, and the deep link is ALWAYS intact — we
 * truncate the content, never the link.
 */
import { esc, money } from "@/server/services/quotes/emails";

export interface DigestCallStats {
  total: number;
  booked: number;
  quotesSent: number;
  needsCallback: number;
}

export interface DigestUsage {
  smsSent: number;
  emailSent: number;
  voiceMinutes: number;
  /** Present only when the org's plan caps the shown feature. */
  cap: { feature: string; used: number; limit: number } | null;
}

export interface DigestAttribution {
  approvedCents: number;
  paidCents: number;
  currency: string;
}

export interface DigestData {
  companyName: string;
  /** Calendar date in the company's timezone this digest covers, YYYY-MM-DD. */
  localDate: string;
  calls: DigestCallStats;
  newLeads: number;
  messagesNeedingReply: number;
  quotesUnviewed48h: number;
  todaysBookings: number;
  usage: DigestUsage;
  attribution: DigestAttribution;
}

export const SMS_MAX_CHARS = 320;

/**
 * "Something happened overnight, or there's something for the owner today." Attribution and
 * usage are month-cumulative, so they don't by themselves make a night non-quiet.
 */
export function digestHasActivity(data: DigestData): boolean {
  return (
    data.calls.total > 0 ||
    data.newLeads > 0 ||
    data.messagesNeedingReply > 0 ||
    data.quotesUnviewed48h > 0 ||
    data.todaysBookings > 0
  );
}

function fmtMoney(cents: number, currency: string): string {
  return money(cents, (currency || "CAD").toUpperCase());
}

/**
 * Append the deep link verbatim and truncate ONLY the content so the total is ≤ 320 chars.
 * If the link alone already exceeds the cap, the link still goes out intact (never cut).
 */
function withDeepLink(content: string, deepLink: string): string {
  const suffix = ` ${deepLink}`;
  const room = SMS_MAX_CHARS - suffix.length;
  if (room <= 0) {
    return deepLink; // pathological: link alone is longer than the cap — still send it intact
  }
  if (content.length <= room) {
    return `${content}${suffix}`;
  }
  const clipped = `${content.slice(0, Math.max(0, room - 1)).trimEnd()}…`;
  return `${clipped}${suffix}`;
}

export function renderDigestSms(data: DigestData, deepLink: string): string {
  if (!digestHasActivity(data)) {
    return withDeepLink(`${data.companyName}: quiet night — nothing needs you.`, deepLink);
  }

  const parts = [
    `${data.calls.total} call${data.calls.total === 1 ? "" : "s"}`,
    data.calls.needsCallback > 0 ? `${data.calls.needsCallback} to call back` : null,
    data.newLeads > 0 ? `${data.newLeads} new lead${data.newLeads === 1 ? "" : "s"}` : null,
    data.messagesNeedingReply > 0 ? `${data.messagesNeedingReply} to reply` : null,
    data.calls.quotesSent > 0 ? `${data.calls.quotesSent} quote${data.calls.quotesSent === 1 ? "" : "s"} sent` : null,
    data.quotesUnviewed48h > 0 ? `${data.quotesUnviewed48h} quote${data.quotesUnviewed48h === 1 ? "" : "s"} unseen 48h+` : null,
    data.todaysBookings > 0 ? `${data.todaysBookings} booking${data.todaysBookings === 1 ? "" : "s"} today` : null,
  ].filter((part): part is string => Boolean(part));

  const moneyLine =
    data.attribution.paidCents > 0 ? ` ${fmtMoney(data.attribution.paidCents, data.attribution.currency)} collected this month.` : "";
  const content = `${data.companyName}: ${parts.join(", ")}.${moneyLine}`;
  return withDeepLink(content, deepLink);
}

// ── Email ─────────────────────────────────────────────────────────────────────

export interface DigestEmailOptions {
  deepLink: string;
  primaryColor?: string | null;
  fromName?: string | null;
}

const DEFAULT_PRIMARY = "#1f2937";

function statRow(label: string, value: string, muted = false): string {
  return `<tr>
<td style="padding:8px 0;border-bottom:1px solid #f3f4f6;color:${muted ? "#6b7280" : "#111827"}">${esc(label)}</td>
<td align="right" style="padding:8px 0;border-bottom:1px solid #f3f4f6;font-weight:600;white-space:nowrap">${esc(value)}</td>
</tr>`;
}

export function renderDigestEmail(data: DigestData, options: DigestEmailOptions): { subject: string; html: string; text: string } {
  const primary = options.primaryColor || DEFAULT_PRIMARY;
  const quiet = !digestHasActivity(data);

  const rows = [
    statRow("Calls", `${data.calls.total}${data.calls.needsCallback > 0 ? ` (${data.calls.needsCallback} need a callback)` : ""}`),
    statRow("New leads", String(data.newLeads)),
    statRow("Messages needing reply", String(data.messagesNeedingReply)),
    statRow("Quotes sent", String(data.calls.quotesSent)),
    statRow("Quotes unseen 48h+", String(data.quotesUnviewed48h)),
    statRow("Bookings today", String(data.todaysBookings)),
  ].join("");

  const capLine = data.usage.cap
    ? `<p style="font-size:13px;color:#6b7280;margin:4px 0 0">Plan usage: ${data.usage.cap.used} / ${data.usage.cap.limit} ${esc(data.usage.cap.feature)} this month.</p>`
    : "";

  const button = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0">
<tr><td style="border-radius:8px;background:${esc(primary)}">
<a href="${esc(options.deepLink)}" style="display:inline-block;padding:13px 26px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none">Open your inbox</a>
</td></tr></table>`;

  const bodyHtml = quiet
    ? `<p>Good morning. It was a quiet night at <strong>${esc(data.companyName)}</strong> — nothing needs you right now.</p>
<p style="color:#4b5563">Captured this month: <strong>${esc(fmtMoney(data.attribution.paidCents, data.attribution.currency))}</strong> collected, ${esc(fmtMoney(data.attribution.approvedCents, data.attribution.currency))} approved.</p>
${button}`
    : `<p>Good morning — here's what happened at <strong>${esc(data.companyName)}</strong> in the last 24 hours.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;margin:16px 0">${rows}</table>
<p style="color:#4b5563">Captured this month: <strong>${esc(fmtMoney(data.attribution.paidCents, data.attribution.currency))}</strong> collected, ${esc(fmtMoney(data.attribution.approvedCents, data.attribution.currency))} approved.</p>
${capLine}
${button}`;

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f7f9">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
<tr><td style="height:4px;background:${esc(primary)};font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td style="padding:24px 24px 8px"><div style="font-size:13px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280">Daily digest · ${esc(data.localDate)}</div></td></tr>
<tr><td style="padding:0 24px 24px;font-size:16px;line-height:1.6">${bodyHtml}</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const textLines = quiet
    ? [
        `Good morning. It was a quiet night at ${data.companyName} — nothing needs you.`,
        "",
        `Captured this month: ${fmtMoney(data.attribution.paidCents, data.attribution.currency)} collected, ${fmtMoney(data.attribution.approvedCents, data.attribution.currency)} approved.`,
        "",
        options.deepLink,
      ]
    : [
        `Good morning — the last 24 hours at ${data.companyName}:`,
        "",
        `- Calls: ${data.calls.total}${data.calls.needsCallback > 0 ? ` (${data.calls.needsCallback} need a callback)` : ""}`,
        `- New leads: ${data.newLeads}`,
        `- Messages needing reply: ${data.messagesNeedingReply}`,
        `- Quotes sent: ${data.calls.quotesSent}`,
        `- Quotes unseen 48h+: ${data.quotesUnviewed48h}`,
        `- Bookings today: ${data.todaysBookings}`,
        "",
        `Captured this month: ${fmtMoney(data.attribution.paidCents, data.attribution.currency)} collected, ${fmtMoney(data.attribution.approvedCents, data.attribution.currency)} approved.`,
        ...(data.usage.cap ? [`Plan usage: ${data.usage.cap.used} / ${data.usage.cap.limit} ${data.usage.cap.feature} this month.`] : []),
        "",
        options.deepLink,
      ];

  return {
    subject: quiet
      ? `${data.companyName}: quiet night`
      : `${data.companyName}: your morning digest`,
    html,
    text: textLines.join("\n"),
  };
}
