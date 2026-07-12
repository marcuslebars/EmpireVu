/** Lead notification email via Resend. Never throws — the caller treats it as best-effort. */

import type { LeadLineItem } from "./envelope";

export interface ReturningInfo {
  priorCount: number;
  priorSummaries: string[];
}

export interface NotifyLead {
  leadId: string;
  source: string | null;
  sourceSite: string | null;
  formType: string | null;
  schemaValid: boolean;
  companyName: string | null;
  contact: { name?: string; email?: string; phone?: string };
  message: string | null;
  lineItems: LeadLineItem[] | null;
  returning: ReturningInfo | null;
  /** Other A1 brands where this same person already exists (cross-brand overlap). */
  crossBrandBrands: string[];
}

function buildText(lead: NotifyLead): string {
  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const parts: Array<string | null> = [
    `Lead ID: ${lead.leadId}`,
    `Source: ${lead.source ?? "?"} (brand: ${lead.sourceSite ?? "?"})`,
    `Type: ${lead.formType ?? "?"}`,
    lead.companyName ? `Company: ${lead.companyName}` : null,
    "",
    `Name:  ${lead.contact.name ?? "—"}`,
    `Email: ${lead.contact.email ?? "—"}`,
    `Phone: ${lead.contact.phone ?? "—"}`,
    lead.message ? `\nMessage:\n${lead.message}` : null,
  ];
  if (lead.lineItems?.length) {
    parts.push("", "Line items:");
    for (const li of lead.lineItems) {
      parts.push(`  - ${li.quantity} × ${li.description} @ ${money(li.unitPriceCents)}`);
    }
  }
  if (lead.returning && lead.returning.priorCount > 0) {
    parts.push("", `↩ RETURNING CONTACT — ${lead.returning.priorCount} prior ${lead.sourceSite ?? "brand"} lead(s)`);
    for (const s of lead.returning.priorSummaries) parts.push(`  - ${s}`);
  }
  if (lead.crossBrandBrands.length) {
    parts.push("", `⚑ ALSO A CUSTOMER OF: ${lead.crossBrandBrands.join(", ")} — cross-brand, handle as a warm lead`);
  }
  if (!lead.schemaValid) {
    parts.push("", "⚠ NEEDS ATTENTION — this payload did not match the lead schema and was stored raw. Review it in raw_leads.");
  }
  return parts.filter((p) => p !== null).join("\n");
}

export async function sendLeadNotification(lead: NotifyLead): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.LEAD_NOTIFY_EMAIL ?? process.env.OWNER_EMAIL;
  const from = process.env.LEAD_FROM_EMAIL ?? "EmpireVu Leads <leads@a1marinecare.ca>";

  if (!apiKey || !to) {
    console.warn("[intake] RESEND_API_KEY or LEAD_NOTIFY_EMAIL not set — skipping notification email");
    return false;
  }

  const who = lead.contact.name || lead.contact.email || lead.contact.phone || "Unknown";
  const markers = [
    !lead.schemaValid ? "⚠ NEEDS ATTENTION" : null,
    lead.crossBrandBrands.length ? "⚑ CROSS-BRAND" : null,
    lead.returning && lead.returning.priorCount > 0 ? "↩ RETURNING" : null,
  ]
    .filter(Boolean)
    .join(" ");
  const subject = `[${lead.sourceSite ?? "lead"}] ${lead.formType ?? "lead"} — ${who}${markers ? ` ${markers}` : ""}`;
  const text = buildText(lead);

  // Retry a couple of times; a failed email never fails the intake.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, text }),
      });
      if (res.ok) return true;
      console.warn(`[intake] Resend error (attempt ${attempt}): ${res.status} ${await res.text().catch(() => "")}`);
    } catch (err) {
      console.warn(`[intake] Resend request failed (attempt ${attempt}):`, err);
    }
  }
  return false;
}
