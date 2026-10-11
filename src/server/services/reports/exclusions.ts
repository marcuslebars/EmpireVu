/**
 * Records that aren't business activity and must not inflate reports:
 *
 *   • contacts brought in by the customer import (consent_source "import") or created for a job
 *     applicant (consent_source "job_application") are not new leads;
 *   • past jobs brought in by the customer import (bookings.source_call_id "import:<key>",
 *     staff/importer/apply.ts) are history, not jobs done in the period.
 *
 * Only these exact markers are excluded, so a house org (A1) — whose own A1 cutover import uses
 * source_call_id "a1:…" — keeps exactly the numbers it had. PURE, no runtime imports.
 */

export const NON_LEAD_CONSENT_SOURCES: ReadonlySet<string> = new Set(["import", "job_application"]);

export function isReportableLead(contact: { consent_source?: string | null }): boolean {
  return !NON_LEAD_CONSENT_SOURCES.has(contact.consent_source ?? "");
}

export function isImportedPastJob(booking: { source_call_id?: string | null }): boolean {
  return typeof booking.source_call_id === "string" && booking.source_call_id.startsWith("import:");
}
