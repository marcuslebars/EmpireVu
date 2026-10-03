/**
 * PURE renderer for the daily operator health email: report → subject / text / html.
 * Golden-tested (snapshots) in src/test/operator-health.test.ts.
 */
import { CRANKLEADS_OFFER_NAME } from "@/server/services/crankleads/config";
import {
  REPORT_TIME,
  type AllClearMode,
  type HealthItem,
  type HealthSection,
  type OperatorHealthReport,
  type Severity,
} from "@/server/services/operator-health/rules";

export interface RenderedOperatorHealthEmail {
  subject: string;
  text: string;
  html: string;
  fromName: string;
}

export interface RenderOptions {
  /** Footer wording: whether a Monday all-clear is sent when nothing is flagged. */
  allClearMode: AllClearMode;
}

const SEVERITY_LABEL: Record<Severity, string> = { critical: "CRITICAL", high: "HIGH", medium: "MEDIUM", low: "LOW" };
const SEVERITY_COLOR: Record<Severity, string> = { critical: "#b42318", high: "#b54708", medium: "#175cd3", low: "#475467" };

const CHECKED =
  "setup progress (5-business-day guarantee), call forwarding, payments, provisioning, silent accounts, support requests, job queues";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "Mon, Oct 5, 2026" for a YYYY-MM-DD date (calendar date, no timezone shift). */
export function formatReportDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(d);
}

export function operatorHealthSubject(report: OperatorHealthReport): string {
  if (report.totalItems === 0) return `${CRANKLEADS_OFFER_NAME} health: all clear`;
  const need = `${report.totalItems} ${report.totalItems === 1 ? "needs" : "need"} you`;
  const guarantee = report.guaranteeAtRisk > 0 ? ` (${report.guaranteeAtRisk} guarantee at risk)` : "";
  return `${CRANKLEADS_OFFER_NAME} health: ${need}${guarantee}`;
}

function headline(report: OperatorHealthReport): string {
  const bits = [`${report.totalItems} ${report.totalItems === 1 ? "thing needs" : "things need"} you`];
  if (report.criticalCount > 0) bits.push(`${report.criticalCount} critical`);
  if (report.guaranteeAtRisk > 0) bits.push(`${report.guaranteeAtRisk} guarantee at risk`);
  return `${bits.join(" · ")}.`;
}

function reportTime(): string {
  return `${String(REPORT_TIME.hour).padStart(2, "0")}:${String(REPORT_TIME.minute).padStart(2, "0")}`;
}

function footerLines(report: OperatorHealthReport, mode: AllClearMode): string[] {
  const allClear = mode === "weekly" ? " (plus a short all-clear on Mondays)" : "";
  return [
    `Sent daily after ${reportTime()} ${report.timeZone} only when something needs a human${allClear}.`,
    `Preview any time: npm run job:operator-health -- --dry-run`,
    `Ops: ${report.appBaseUrl}/internal/ops`,
  ];
}

function itemTitle(item: HealthItem): string {
  return item.tierLabel ? `${item.account} (${item.tierLabel})` : item.account;
}

function moreLine(section: HealthSection): string {
  return `+${section.hiddenCount} more — npm run job:operator-health -- --dry-run --all`;
}

// ── Text ─────────────────────────────────────────────────────────────────────

function textItem(item: HealthItem, index: number): string[] {
  const lines = [
    `${index}. [${SEVERITY_LABEL[item.severity]}] ${itemTitle(item)}`,
    `   What: ${item.problem}`,
    `   How long: ${item.howLong}`,
    `   Do: ${item.action}`,
  ];
  for (const link of item.links) lines.push(`   ${link.label}: ${link.url}`);
  return lines;
}

function renderText(report: OperatorHealthReport, options: RenderOptions): string {
  const title = `${CRANKLEADS_OFFER_NAME} health — ${formatReportDate(report.reportDate)}`;
  if (report.totalItems === 0) {
    return [
      title,
      "",
      "All clear — nothing needs you today.",
      `Checked: ${CHECKED}.`,
      "",
      ...footerLines(report, options.allClearMode),
    ].join("\n");
  }
  const lines = [title, headline(report), ""];
  for (const section of report.sections) {
    lines.push(`== ${section.title} (${section.total}) ==`);
    section.items.forEach((item, i) => {
      lines.push(...textItem(item, i + 1));
      lines.push("");
    });
    if (section.hiddenCount > 0) {
      lines.push(moreLine(section));
      lines.push("");
    }
  }
  lines.push("--", ...footerLines(report, options.allClearMode));
  return lines.join("\n");
}

// ── HTML ─────────────────────────────────────────────────────────────────────

function htmlItem(item: HealthItem): string {
  const color = SEVERITY_COLOR[item.severity];
  const links = item.links
    .map((link) => `<a href="${escapeHtml(link.url)}" style="color:#175cd3">${escapeHtml(link.label)}</a>`)
    .join(" · ");
  return [
    `<li style="margin:0 0 14px 0">`,
    `<div><span style="display:inline-block;padding:1px 6px;border-radius:4px;background:${color};color:#fff;font-size:11px;font-weight:700">${SEVERITY_LABEL[item.severity]}</span> `,
    `<strong>${escapeHtml(itemTitle(item))}</strong></div>`,
    `<div style="margin-top:4px">${escapeHtml(item.problem)}</div>`,
    `<div style="color:#475467;font-size:13px">How long: ${escapeHtml(item.howLong)}</div>`,
    `<div style="margin-top:4px"><strong>Do:</strong> <span style="font-family:ui-monospace,Menlo,monospace;font-size:13px">${escapeHtml(item.action)}</span></div>`,
    links ? `<div style="margin-top:4px;font-size:13px">${links}</div>` : "",
    `</li>`,
  ].join("");
}

function htmlFooter(report: OperatorHealthReport, mode: AllClearMode): string {
  return `<p style="color:#667085;font-size:12px;border-top:1px solid #eaecf0;padding-top:10px;margin-top:20px">${footerLines(report, mode)
    .map(escapeHtml)
    .join("<br>")}</p>`;
}

function renderHtml(report: OperatorHealthReport, options: RenderOptions): string {
  const open = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#101828;max-width:680px;line-height:1.45">`;
  const title = `<h1 style="font-size:18px;margin:0 0 4px 0">${escapeHtml(CRANKLEADS_OFFER_NAME)} health — ${escapeHtml(formatReportDate(report.reportDate))}</h1>`;
  if (report.totalItems === 0) {
    return [
      open,
      title,
      `<p style="font-size:16px;margin:8px 0"><strong>All clear</strong> — nothing needs you today.</p>`,
      `<p style="color:#475467;font-size:13px">Checked: ${escapeHtml(CHECKED)}.</p>`,
      htmlFooter(report, options.allClearMode),
      `</div>`,
    ].join("");
  }
  const parts = [open, title, `<p style="margin:0 0 16px 0;font-weight:600">${escapeHtml(headline(report))}</p>`];
  for (const section of report.sections) {
    parts.push(`<h2 style="font-size:15px;margin:18px 0 8px 0;border-bottom:1px solid #eaecf0;padding-bottom:4px">${escapeHtml(section.title)} (${section.total})</h2>`);
    parts.push(`<ol style="padding-left:20px;margin:0">${section.items.map(htmlItem).join("")}</ol>`);
    if (section.hiddenCount > 0) parts.push(`<p style="color:#475467;font-size:13px">${escapeHtml(moreLine(section))}</p>`);
  }
  parts.push(htmlFooter(report, options.allClearMode), `</div>`);
  return parts.join("");
}

/** PURE. The operator email for a report (all-clear wording when nothing is flagged). */
export function renderOperatorHealthEmail(report: OperatorHealthReport, options: RenderOptions): RenderedOperatorHealthEmail {
  return {
    subject: operatorHealthSubject(report),
    text: renderText(report, options),
    html: renderHtml(report, options),
    fromName: `${CRANKLEADS_OFFER_NAME} ops`,
  };
}
