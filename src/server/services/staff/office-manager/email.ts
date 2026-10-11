/**
 * The briefing's optional email copy (setting channels: ["sms", "email"]): the same text plus the
 * detail that doesn't fit in a text — every job by crew member, the weather numbers, who's late
 * paying, and every approval waiting. PURE rendering; sent with deliverMessage (Resend).
 */
import type { BriefingDetails } from "./gather";
import { REPLY_HINT } from "./compose";

export interface BriefingEmail {
  subject: string;
  text: string;
  html: string;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** "Details" sections (titles + lines), skipping empty ones. PURE. */
export function detailSections(details: BriefingDetails): Array<{ title: string; lines: string[] }> {
  return [
    { title: "Today's jobs", lines: details.jobs },
    { title: "Weather", lines: details.weather },
    { title: "Overdue", lines: details.owing },
    { title: "Waiting on you (reply Y or N with the number)", lines: details.waiting },
  ].filter((s) => s.lines.length > 0);
}

/** The owner tool's compact detail text. PURE. */
export function detailsText(details: BriefingDetails): string {
  return detailSections(details)
    .map((s) => `${s.title}:\n${s.lines.map((l) => `- ${l}`).join("\n")}`)
    .join("\n\n");
}

export function renderBriefingEmail(input: { businessName: string; dayLabel: string; briefing: string; details: BriefingDetails }): BriefingEmail {
  const summary = input.briefing.replace(REPLY_HINT, "").trim();
  const sections = detailSections(input.details);
  const subject = `${input.businessName}: your morning briefing for ${input.dayLabel}`;
  const text = [summary, ...sections.map((s) => `${s.title}\n${s.lines.map((l) => `- ${l}`).join("\n")}`), "Text your assistant any time for more."].join("\n\n");
  const html = [
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">`,
    `<p>${summary.split("\n").map(esc).join("<br>")}</p>`,
    ...sections.map((s) => `<h3 style="font-size:15px;margin:18px 0 6px">${esc(s.title)}</h3><ul style="margin:0;padding-left:20px">${s.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`),
    `<p style="color:#666;font-size:13px;margin-top:18px">Text your assistant any time for more.</p>`,
    `</div>`,
  ].join("");
  return { subject, text, html };
}
