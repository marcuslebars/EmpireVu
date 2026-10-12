/**
 * Receipts & HST — the Tax Clerk (docs/ai-staff.md → "Receipts & HST").
 *
 *   Receipts  the owner texts a photo / PDF of a receipt or supplier bill → read, filed as an
 *             expense (job, paid-with, category, PO from their words), duplicates skipped, one
 *             reply text (ownerMedia handler, receipts.ts); owner tools fix_receipt,
 *             receipts_summary.
 *   HST       the regular-method worksheet (CRA lines 101/103/106/109), the 10-day reminder,
 *             and the `accountant_packet` approval (Y emails the packet); owner tools
 *             hst_summary, send_hst_packet.
 *   Nudges    Monday receipt check, first-week "text me your receipts" tip.
 *
 * Sweeps: tax_clerk:hst, tax_clerk:nudges. Off for house orgs unless switched on (settings.ts).
 * Prepared figures only: nothing is ever filed with CRA.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { emptyRole, type StaffRoleModule, type StaffSweep } from "@/server/services/staff/types";
import { ACCOUNTANT_PACKET_KIND } from "./approvals";
import { sweepNudges } from "./nudges";
import { taxClerkOwnerTools } from "./owner-tools";
import { executeAccountantPacket } from "./packet";
import { receiptMediaHandler } from "./receipts";
import { sweepHstReminders } from "./reminders";
import { hstRemindersOn, loadTaxClerkCompanies, taxClerkActiveFor, type TaxClerkCompany } from "./settings";

export { briefingItems } from "./briefing-items";

let cached: { atMs: number; companies: TaxClerkCompany[] } | null = null;

/** The feature-on companies, loaded at most once per 30 s and shared by the sweeps. */
async function companiesFor(admin: AdminClient, nowMs: number): Promise<TaxClerkCompany[]> {
  if (cached && Math.abs(nowMs - cached.atMs) < 30_000) return cached.companies;
  const companies = await loadTaxClerkCompanies(admin);
  cached = { atMs: nowMs, companies };
  return companies;
}

/** Test hook. */
export function resetTaxClerkCompanyCache(): void {
  cached = null;
}

export const TAX_CLERK_SWEEPS: StaffSweep[] = [
  {
    name: "tax_clerk:hst",
    intervalMs: 15 * 60_000,
    run: async (admin, nowMs) => {
      const companies = (await companiesFor(admin, nowMs)).filter((c) => hstRemindersOn(c.settings) && c.ownerPhone);
      if (companies.length) await sweepHstReminders(admin, nowMs, companies);
    },
  },
  {
    name: "tax_clerk:nudges",
    intervalMs: 15 * 60_000,
    run: async (admin, nowMs) => {
      const companies = (await companiesFor(admin, nowMs)).filter((c) => c.settings.receipts.enabled && c.ownerPhone);
      if (companies.length) await sweepNudges(admin, nowMs, companies);
    },
  },
];

export const taxClerkRole: StaffRoleModule = {
  ...emptyRole("tax_clerk"),
  activeFor: taxClerkActiveFor,
  ownerMedia: receiptMediaHandler,
  approvalExecutors: {
    [ACCOUNTANT_PACKET_KIND]: (admin, approval, decision) => executeAccountantPacket(admin, approval, decision),
  },
  ownerTools: taxClerkOwnerTools(),
  ownerPromptNotes: [
    "Receipts: photos of receipts the owner texts are filed as expenses automatically and the reply ends 'Reply \"fix\" to change it'. When the owner says \"fix\" or changes the last receipt (category, job, amount, HST, date, personal/business card, PO, delete) call fix_receipt with ONLY what they said and relay its tell_owner. \"receipts\" / \"expenses this month\" → receipts_summary.",
    "HST: \"hst\" → hst_summary (relay tell_owner). \"send the hst packet\" → send_hst_packet, then reply with its tell_owner_exactly word for word (it carries the Y code). Figures are prepared, not filed: never say anything was filed with CRA - the owner or their accountant files the return.",
  ],
  sweeps: TAX_CLERK_SWEEPS,
};
