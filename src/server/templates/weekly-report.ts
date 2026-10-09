/**
 * Weekly "what your front desk did" report — PURE renders (no DB / mail server / Twilio).
 * Email: same house style as the monthly scorecard (table-based, inline CSS, single 560px
 * column, renders on phones and in Outlook). SMS: three short GSM-7 lines, at most two
 * segments, with a link to the full report in the app.
 *
 * Branding: the CLIENT's company name is the headline; `platformBrand` is the org's platform
 * brand name (CrankLeads for a CrankLeads org — never EmpireVu), from
 * `scorecardPlatformBrandName()`.
 */
import { esc } from "@/server/services/quotes/emails";
import { weekLabel } from "@/server/services/monthly-scorecard/weeks";
import { HOURS_SAVED_ASSUMPTIONS, hoursSavedAssumptionsText, type WeeklyReportMetrics } from "@/server/services/weekly-report/metrics";

export interface WeeklyReportRenderOptions {
  companyName: string;
  platformBrand: string;
  /** Deep link to the in-app weekly report page. */
  reportUrl: string;
  primaryColor?: string | null;
}

export interface RenderedWeeklyEmail {
  subject: string;
  html: string;
  text: string;
}

const DEFAULT_PRIMARY = "#1f2937";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** 125000 → "$1,250" (whole dollars, ASCII — safe for SMS). */
export function wholeDollars(cents: number): string {
  const dollars = Math.round(cents / 100);
  return `$${String(Math.abs(dollars)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

/** 6.5 → "6.5 hours", 1 → "1 hour", 0.3 → "20 min". */
export function hoursText(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours % 1 === 0 ? hours.toFixed(0) : hours.toFixed(1)} ${hours === 1 ? "hour" : "hours"}`;
}

// ── SMS ──────────────────────────────────────────────────────────────────────

// GSM 03.38 basic set (one septet each) and extension set (two septets each).
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€\f";

/** SMS segment count: GSM-7 (160 / 153 per part) or, with any other character, UCS-2 (70 / 67). */
export function smsSegments(body: string): { encoding: "GSM-7" | "UCS-2"; units: number; segments: number } {
  let septets = 0;
  let gsm = true;
  for (const ch of body) {
    if (GSM_BASIC.includes(ch)) septets += 1;
    else if (GSM_EXTENDED.includes(ch)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return { encoding: "GSM-7", units: septets, segments: septets <= 160 ? 1 : Math.ceil(septets / 153) };
  const units = [...body].reduce((sum, ch) => sum + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  return { encoding: "UCS-2", units, segments: units <= 70 ? 1 : Math.ceil(units / 67) };
}

/** Replace anything outside GSM-7 (curly quotes, dashes, accents we can fold, emoji) so the text stays cheap. */
export function toGsmSafe(text: string): string {
  const folded = text
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  let out = "";
  for (const ch of folded) out += GSM_BASIC.includes(ch) || GSM_EXTENDED.includes(ch) ? ch : "";
  return out;
}

export const SMS_MAX_SEGMENTS = 2;

/** The headline items, most valuable first (only non-zero ones). */
function smsItems(m: WeeklyReportMetrics): string[] {
  const items: string[] = [];
  if (m.calls.answered > 0) {
    items.push(
      `${plural(m.calls.answered, "call", "calls")} answered${m.calls.afterHours ? ` (${m.calls.afterHours} after hours)` : ""}`,
    );
  }
  if (m.textConversations > 0) items.push(plural(m.textConversations, "text chat", "text chats"));
  if (m.jobsBooked > 0) items.push(`${plural(m.jobsBooked, "job", "jobs")} booked`);
  if (m.quotes.sent > 0) items.push(`${plural(m.quotes.sent, "quote", "quotes")} sent`);
  if (m.collected.cents > 0) items.push(`${wholeDollars(m.collected.cents)} collected`);
  if (m.missedCalls.textedBack > 0) items.push(`${plural(m.missedCalls.textedBack, "missed call", "missed calls")} texted back`);
  if (m.reviewsRequested > 0) items.push(`${plural(m.reviewsRequested, "review", "reviews")} requested`);
  return items;
}

/** "Northshore Lawn and Snow Removal Inc." → "Northshore Lawn and Snow" (word boundary, ≤ max). */
function shortName(name: string, max: number): string {
  if (name.length <= max) return name;
  const cut = name.slice(0, max + 1);
  const atWord = cut.slice(0, cut.lastIndexOf(" ")).replace(/[\s,&\-–]+$/, "");
  return atWord.length >= 8 ? atWord : name.slice(0, max).trim();
}

/**
 * Three short lines from the platform number: who/when, what happened, hours saved + link.
 * Always GSM-7 and at most SMS_MAX_SEGMENTS segments (drops the least important items, then
 * shortens the company name, to fit).
 */
export function renderWeeklySms(m: WeeklyReportMetrics, options: WeeklyReportRenderOptions): string {
  const label = weekLabel(m.weekStart, { ascii: true });
  const brand = toGsmSafe(options.platformBrand) || "Your front desk";
  const build = (name: string, items: string[]) => {
    const head = `${brand} weekly report for ${name}, ${label}:`;
    const middle = m.hasActivity
      ? items.length > 0
        ? `${items.join(", ")}.`
        : "Your front desk was on all week."
      : "Quiet week - nothing new came in. Your front desk is on and answering.";
    const saved = m.hoursSaved.minutes > 0 ? `About ${hoursText(m.hoursSaved.minutes)} of front desk work saved (est). ` : "";
    return [head, middle, `${saved}Full report: ${options.reportUrl}`].join("\n");
  };

  const fullName = toGsmSafe(options.companyName).trim() || "your business";
  let maxName = 32;
  let items = smsItems(m).slice(0, 4);
  let body = build(shortName(fullName, maxName), items);
  // Fit in two segments: drop the least important items first, then shorten the name.
  while (smsSegments(body).segments > SMS_MAX_SEGMENTS && items.length > 1) {
    items = items.slice(0, -1);
    body = build(shortName(fullName, maxName), items);
  }
  while (smsSegments(body).segments > SMS_MAX_SEGMENTS && maxName > 12) {
    maxName -= 6;
    body = build(shortName(fullName, maxName), items);
  }
  return body;
}

// ── Email ────────────────────────────────────────────────────────────────────

export function weeklySubject(m: WeeklyReportMetrics): string {
  if (!m.hasActivity) return "Your front desk last week: a quiet week";
  const parts: string[] = [];
  if (m.calls.answered > 0) parts.push(`${plural(m.calls.answered, "call", "calls")} answered`);
  if (m.textConversations > 0) parts.push(plural(m.textConversations, "text conversation", "text conversations"));
  if (m.jobsBooked > 0) parts.push(`${plural(m.jobsBooked, "job", "jobs")} booked`);
  if (parts.length === 0 && m.quotes.sent > 0) parts.push(`${plural(m.quotes.sent, "quote", "quotes")} sent`);
  if (parts.length === 0 && m.leads > 0) parts.push(`${plural(m.leads, "new lead", "new leads")}`);
  const head = parts.slice(0, 2).join(", ") || "here's what happened";
  return `Your front desk last week: ${head}`;
}

interface Line {
  label: string;
  value: string;
  note?: string | null;
}

function buildLines(m: WeeklyReportMetrics): Line[] {
  const lines: Line[] = [];
  lines.push({
    label: "Calls answered by your AI",
    value: String(m.calls.answered),
    note:
      m.calls.answered > 0
        ? [m.calls.afterHours !== null ? `${m.calls.afterHours} after hours` : null, m.calls.minutes > 0 ? `${m.calls.minutes} min on the phone` : null]
            .filter(Boolean)
            .join(" · ") || null
        : null,
  });
  lines.push({ label: "Customer text conversations handled", value: String(m.textConversations) });
  if (m.approvals.asked > 0 || m.approvals.approved > 0) {
    lines.push({ label: "Things it checked with you first", value: String(m.approvals.asked), note: `${m.approvals.approved} approved` });
  }
  lines.push({
    label: "Missed calls caught",
    value: String(m.missedCalls.caught),
    note: m.missedCalls.caught > 0 ? `${m.missedCalls.textedBack} texted back` : null,
  });
  lines.push({ label: "New leads", value: String(m.leads) });
  lines.push({ label: "Quotes sent", value: String(m.quotes.sent) });
  lines.push({
    label: "Quotes approved",
    value: String(m.quotes.approved),
    note: m.quotes.approved > 0 ? wholeDollars(m.quotes.approvedCents) : null,
  });
  lines.push({ label: "Jobs booked", value: String(m.jobsBooked) });
  lines.push({
    label: "Deposits & payments collected",
    value: wholeDollars(m.collected.cents),
    note: m.collected.deposits + m.collected.payments > 0 ? plural(m.collected.deposits + m.collected.payments, "payment", "payments") : null,
  });
  lines.push({ label: "Reviews requested", value: String(m.reviewsRequested) });
  return lines;
}

function tile(label: string, value: string, primary: string): string {
  return `<td width="33%" align="center" valign="top" style="padding:12px 4px;background:#f6f7f9;border-radius:10px">
<div style="font-size:28px;font-weight:800;line-height:1.1;color:${esc(primary)}">${esc(value)}</div>
<div style="font-size:12px;font-weight:600;color:#111827;margin-top:4px">${esc(label)}</div>
</td>`;
}

export function renderWeeklyEmail(m: WeeklyReportMetrics, options: WeeklyReportRenderOptions): RenderedWeeklyEmail {
  const primary = options.primaryColor || DEFAULT_PRIMARY;
  const subject = weeklySubject(m);
  const label = weekLabel(m.weekStart, { withYear: true });
  const lines = buildLines(m);
  const brand = options.platformBrand;
  const company = options.companyName;
  const intro = m.hasActivity
    ? "Here's what your front desk handled last week — calls, texts, quotes and bookings you didn't have to."
    : "A quiet week — nothing new came in. Your front desk is still on: it answers calls and texts the moment they arrive.";
  const wage = `$${(HOURS_SAVED_ASSUMPTIONS.receptionistHourlyWageCents / 100).toFixed(0)}/hour`;
  const savedHeadline =
    m.hoursSaved.minutes > 0 ? `About ${hoursText(m.hoursSaved.minutes)} of front desk work handled` : null;
  const savedNote =
    m.hoursSaved.minutes > 0
      ? `Roughly ${wholeDollars(m.hoursSaved.wageValueCents)} of receptionist time at ${wage}. Estimate — see how we count below.`
      : null;
  const assumptions = hoursSavedAssumptionsText();

  // ── HTML ──
  const saved = savedHeadline
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0 4px">
<tr><td style="padding:14px 16px;background:#f6f7f9;border-left:4px solid ${esc(primary)};border-radius:8px">
<div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em">Time saved (estimate)</div>
<div style="font-size:20px;font-weight:800;line-height:1.3;color:#111827;margin-top:4px">${esc(savedHeadline)}</div>
<div style="font-size:13px;line-height:1.5;color:#6b7280;margin-top:6px">${esc(savedNote)}</div>
</td></tr></table>`
    : "";

  const tiles = `<table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="margin:8px 0 16px">
<tr>
${tile("Calls answered", String(m.calls.answered), primary)}
${tile("Text conversations", String(m.textConversations), primary)}
${tile("Jobs booked", String(m.jobsBooked), primary)}
</tr></table>`;

  const rows = lines
    .map(
      (line) => `<tr>
<td style="padding:8px 0;border-bottom:1px solid #f3f4f6;color:#111827">${esc(line.label)}</td>
<td align="right" style="padding:8px 0;border-bottom:1px solid #f3f4f6;white-space:nowrap"><span style="font-weight:700">${esc(line.value)}</span>${
        line.note ? `<br><span style="font-size:12px;color:#6b7280">${esc(line.note)}</span>` : ""
      }</td>
</tr>`,
    )
    .join("");

  const button = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 8px">
<tr><td style="border-radius:8px;background:${esc(primary)}">
<a href="${esc(options.reportUrl)}" style="display:inline-block;padding:13px 26px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none">See the full report</a>
</td></tr></table>`;

  const html = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f6f7f9">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
<tr><td style="height:4px;background:${esc(primary)};font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td style="padding:24px 24px 4px"><div style="font-size:13px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280">Your front desk · ${esc(label)}</div>
<h1 style="margin:6px 0 0;font-size:26px;line-height:1.2;color:#111827">${esc(company)}</h1></td></tr>
<tr><td style="padding:8px 24px 24px;font-size:16px;line-height:1.6">
<p style="margin:8px 0">${esc(intro)}</p>
${saved}
${tiles}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;margin:8px 0 16px">${rows}</table>
${button}
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #f3f4f6;font-size:12px;line-height:1.5;color:#6b7280">${esc(assumptions)}<br><br>Sent by ${esc(brand)} for ${esc(company)} every Monday. Turn it off or change where it goes in Settings → AI front desk. Questions? Just reply to this email.</td></tr>
</table>
</td></tr></table>
</body></html>`;

  // ── Text ──
  const text = [
    `${company} — your front desk, ${label}`,
    "",
    intro,
    ...(savedHeadline ? ["", `${savedHeadline} (estimate). ${savedNote}`] : []),
    "",
    ...lines.map((line) => `- ${line.label}: ${line.value}${line.note ? ` (${line.note})` : ""}`),
    "",
    `See the full report: ${options.reportUrl}`,
    "",
    assumptions,
    "",
    `Sent by ${brand} for ${company} every Monday. Turn it off in Settings → AI front desk. Questions? Just reply to this email.`,
  ].join("\n");

  return { subject, html, text };
}
