/**
 * Monthly results scorecard email — PURE render (golden-tested, no DB / mail server).
 * Table-based, inline CSS, single 560px column: renders on phones and in Outlook. Reuses the
 * quote/digest house style helpers (`esc`, `money`).
 *
 * Branding: the CLIENT's company name is the headline; the platform brand (sender display
 * name + footer) is passed in as `platformBrand`, which callers take from
 * `scorecardPlatformBrandName()` — the single place it is configured.
 */
import { esc, money } from "@/server/services/quotes/emails";
import { LEAD_SOURCE_LABELS, LEAD_SOURCES } from "@/server/services/monthly-scorecard/metrics";
import { monthLabel, previousMonthKey } from "@/server/services/monthly-scorecard/months";
import type { MetricDelta, MonthlyScorecard } from "@/server/services/monthly-scorecard/scorecard";

export interface ScorecardEmailOptions {
  platformBrand: string;
  /** Deep link to the in-app Monthly results page. */
  reportUrl: string;
  primaryColor?: string | null;
}

export interface RenderedScorecardEmail {
  subject: string;
  html: string;
  text: string;
}

const DEFAULT_PRIMARY = "#1f2937";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** 95 → "2 min", 30 → "under a minute", 5400 → "1.5 hours". */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return "under a minute";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const hours = seconds / 3600;
  return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} hours`;
}

function fmtMoney(cents: number, currency: string): string {
  return money(cents, (currency || "CAD").toUpperCase());
}

function shortMonth(key: string): string {
  return monthLabel(key).slice(0, 3);
}

/** "▲ 4 vs Sep" / "▼ 2 vs Sep" / "same as Sep". Money deltas formatted as money. */
export function deltaText(delta: MetricDelta | null, previousMonth: string, currency?: string): string | null {
  if (!delta) return null;
  const label = shortMonth(previousMonth);
  if (delta.change === 0) return `same as ${label}`;
  const magnitude = currency ? fmtMoney(Math.abs(delta.change), currency) : String(Math.abs(delta.change));
  return `${delta.change > 0 ? "▲" : "▼"} ${magnitude} vs ${label}`;
}

export function scorecardSubject(card: MonthlyScorecard): string {
  if (!card.hasActivity) return `Your ${card.monthLabel} results: a quiet month`;
  return `Your ${card.monthLabel} results: ${plural(card.metrics.leads.total, "lead", "leads")} caught, ${plural(
    card.metrics.jobsBooked,
    "job",
    "jobs",
  )} booked`;
}

interface Line {
  label: string;
  value: string;
  note?: string | null;
  indent?: boolean;
}

function buildLines(card: MonthlyScorecard): Line[] {
  const m = card.metrics;
  const d = card.deltas;
  const prev = previousMonthKey(card.month);
  const currency = m.quotes.currency;
  const lines: Line[] = [];

  lines.push({ label: "New leads", value: String(m.leads.total), note: deltaText(d?.leads ?? null, prev) });
  for (const source of LEAD_SOURCES) {
    const count = m.leads.bySource[source];
    if (count > 0) lines.push({ label: LEAD_SOURCE_LABELS[source], value: String(count), indent: true });
  }
  lines.push({
    label: "Missed calls caught",
    value: String(m.missedCalls.caught),
    note: m.missedCalls.caught > 0 ? `${m.missedCalls.textedBack} texted back` : null,
  });
  lines.push({
    label: "Replies sent",
    value: String(m.messages.sent),
    note: m.messages.automated > 0 ? `${m.messages.automated} automatic` : deltaText(d?.messagesSent ?? null, prev),
  });
  lines.push({
    label: "Median first response",
    value: formatDuration(m.firstResponse.medianSeconds),
    note:
      d?.medianResponseSeconds && d.medianResponseSeconds.change !== 0
        ? `was ${formatDuration(d.medianResponseSeconds.previous)} in ${shortMonth(prev)}`
        : null,
  });
  lines.push({ label: "Quotes sent", value: String(m.quotes.sent), note: deltaText(d?.quotesSent ?? null, prev) });
  lines.push({
    label: "Quotes approved",
    value: String(m.quotes.approved),
    note: m.quotes.approved > 0 ? fmtMoney(m.quotes.approvedCents, currency) : null,
  });
  lines.push({
    label: "Deposits collected",
    value: String(m.quotes.depositsCollected),
    note: m.quotes.depositsCollected > 0 ? fmtMoney(m.quotes.depositCents, currency) : null,
  });
  lines.push({ label: "Jobs booked", value: String(m.jobsBooked), note: deltaText(d?.jobsBooked ?? null, prev) });
  lines.push({ label: "Reviews requested", value: String(m.reviewsRequested) });
  const hadReceptionist = m.receptionist.callsHandled > 0 || (card.previous?.receptionist.callsHandled ?? 0) > 0;
  if (hadReceptionist) {
    lines.push({
      label: "AI receptionist calls",
      value: String(m.receptionist.callsHandled),
      note: `${m.receptionist.minutes} min on the phone`,
    });
  }
  lines.push({
    label: "Revenue we helped win",
    value: fmtMoney(m.attributedRevenue.paidCents, currency),
    note: `collected · ${fmtMoney(m.attributedRevenue.approvedCents, currency)} approved`,
  });
  return lines;
}

function comparisonIntro(card: MonthlyScorecard): string {
  if (card.firstMonth) {
    return `This is your first month on the scorecard — next month you'll see how ${card.monthLabel} compares.`;
  }
  if (!card.hasActivity) {
    return `It was a quiet ${card.monthLabel}. Here's what we saw and what we're doing about it.`;
  }
  return `Here's how ${card.monthLabel} went, compared with ${monthLabel(previousMonthKey(card.month))}.`;
}

function tile(label: string, value: string, note: string | null, primary: string): string {
  return `<td width="33%" align="center" valign="top" style="padding:12px 4px;background:#f6f7f9;border-radius:10px">
<div style="font-size:28px;font-weight:800;line-height:1.1;color:${esc(primary)}">${esc(value)}</div>
<div style="font-size:12px;font-weight:600;color:#111827;margin-top:4px">${esc(label)}</div>
${note ? `<div style="font-size:11px;color:#6b7280;margin-top:2px">${esc(note)}</div>` : ""}
</td>`;
}

export function renderScorecardEmail(card: MonthlyScorecard, options: ScorecardEmailOptions): RenderedScorecardEmail {
  const primary = options.primaryColor || DEFAULT_PRIMARY;
  const m = card.metrics;
  const prev = previousMonthKey(card.month);
  const subject = scorecardSubject(card);
  const lines = buildLines(card);
  const intro = comparisonIntro(card);
  const brand = options.platformBrand;

  // ── HTML ──
  const tiles = `<table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="margin:8px 0 16px">
<tr>
${tile("Leads caught", String(m.leads.total), deltaText(card.deltas?.leads ?? null, prev), primary)}
${tile("Replies sent", String(m.messages.sent), deltaText(card.deltas?.messagesSent ?? null, prev), primary)}
${tile("Jobs booked", String(m.jobsBooked), deltaText(card.deltas?.jobsBooked ?? null, prev), primary)}
</tr></table>`;

  const rows = lines
    .map(
      (line) => `<tr>
<td style="padding:8px 0;border-bottom:1px solid #f3f4f6;${line.indent ? "padding-left:16px;color:#6b7280;font-size:14px" : "color:#111827"}">${esc(line.label)}</td>
<td align="right" style="padding:8px 0;border-bottom:1px solid #f3f4f6;white-space:nowrap"><span style="font-weight:700">${esc(line.value)}</span>${
        line.note ? `<br><span style="font-size:12px;color:#6b7280">${esc(line.note)}</span>` : ""
      }</td>
</tr>`,
    )
    .join("");

  const tuning =
    card.suggestions.length > 0
      ? `<ol style="margin:0;padding-left:20px">${card.suggestions
          .map((s) => `<li style="margin:0 0 10px"><strong>${esc(s.title)}.</strong> ${esc(s.detail)}</li>`)
          .join("")}</ol>`
      : `<p style="margin:0">Everything's running well — we'll keep watching response times and follow-ups.</p>`;
  const note = card.operatorNote
    ? `<div style="margin:12px 0 0;padding:12px 14px;background:#f6f7f9;border-left:3px solid ${esc(primary)};border-radius:6px">
<div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em">A note from your ${esc(brand)} team</div>
<div style="margin-top:4px;white-space:pre-line">${esc(card.operatorNote)}</div></div>`
    : "";

  const button = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 8px">
<tr><td style="border-radius:8px;background:${esc(primary)}">
<a href="${esc(options.reportUrl)}" style="display:inline-block;padding:13px 26px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none">See your full results</a>
</td></tr></table>`;

  const html = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f6f7f9">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
<tr><td style="height:4px;background:${esc(primary)};font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td style="padding:24px 24px 4px"><div style="font-size:13px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280">Monthly results · ${esc(card.monthLabelLong)}</div>
<h1 style="margin:6px 0 0;font-size:26px;line-height:1.2;color:#111827">${esc(card.companyName)}</h1></td></tr>
<tr><td style="padding:8px 24px 24px;font-size:16px;line-height:1.6">
<p style="margin:8px 0">${esc(intro)}</p>
${tiles}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;margin:8px 0 16px">${rows}</table>
<h2 style="margin:20px 0 8px;font-size:18px">What we're tuning next</h2>
${tuning}
${note}
${button}
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #f3f4f6;font-size:12px;color:#6b7280">Sent by ${esc(brand)} for ${esc(card.companyName)}. Questions about these numbers? Just reply to this email.</td></tr>
</table>
</td></tr></table>
</body></html>`;

  // ── Text ──
  const text = [
    `${card.companyName} — ${card.monthLabelLong} results`,
    "",
    intro,
    "",
    `Leads caught: ${m.leads.total} · Replies sent: ${m.messages.sent} · Jobs booked: ${m.jobsBooked}`,
    "",
    ...lines.map((line) => `${line.indent ? "    " : "- "}${line.label}: ${line.value}${line.note ? ` (${line.note})` : ""}`),
    "",
    "What we're tuning next:",
    ...(card.suggestions.length > 0
      ? card.suggestions.map((s, index) => `${index + 1}. ${s.title}. ${s.detail}`)
      : ["Everything's running well — we'll keep watching response times and follow-ups."]),
    ...(card.operatorNote ? ["", `A note from your ${brand} team:`, card.operatorNote] : []),
    "",
    `See your full results: ${options.reportUrl}`,
    "",
    `Sent by ${brand} for ${card.companyName}. Questions? Just reply to this email.`,
  ].join("\n");

  return { subject, html, text };
}
