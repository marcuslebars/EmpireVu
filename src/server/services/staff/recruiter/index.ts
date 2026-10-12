/**
 * Hiring & payroll — the Recruiter (docs/ai-staff.md → "Hiring & payroll").
 *
 *   Payroll   pay periods from settings, hours + Ontario OT flags from time_entries, the
 *             `payroll_period` approval the morning after each period (Y locks + emails the CSV),
 *             the lock on time entries, CSV download / lock / unlock from Settings.
 *   Hiring    start_hiring → AI job post → `job_post` approval → public jobs pages + apply form
 *             on the company site → applicants as contacts → human-rights-safe AI screening →
 *             08:30 digest with `interview_invite` approvals; owner tools applicants,
 *             invite_applicant, close_job.
 *
 * Sweeps: recruiter:payroll, recruiter:applicants (screening, confirmation texts, invites queued overnight),
 * recruiter:digest. Off for house orgs unless switched on (settings.ts).
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { emptyRole, type StaffRoleModule, type StaffSweep } from "@/server/services/staff/types";
import { executeInterviewInvite, sweepConfirmations, sweepDigest, sweepQueuedInvites, sweepScreening } from "./applicants";
import { INTERVIEW_INVITE_KIND, JOB_POST_KIND, PAYROLL_PERIOD_KIND } from "./approvals";
import { executeJobPost } from "./jobs";
import { recruiterOwnerTools } from "./owner-tools";
import { executePayrollPeriod, sweepPayroll } from "./payroll";
import { loadRecruiterCompanies, recruiterActiveFor, type RecruiterCompany } from "./settings";

let cached: { atMs: number; companies: RecruiterCompany[] } | null = null;

/** The feature-on companies, loaded at most once per 30 s and shared by the sweeps. */
async function companiesFor(admin: AdminClient, nowMs: number): Promise<RecruiterCompany[]> {
  if (cached && Math.abs(nowMs - cached.atMs) < 30_000) return cached.companies;
  const companies = await loadRecruiterCompanies(admin);
  cached = { atMs: nowMs, companies };
  return companies;
}

/** Test hook. */
export function resetRecruiterCompanyCache(): void {
  cached = null;
}

const byId = (companies: RecruiterCompany[]) => new Map(companies.map((c) => [c.companyId, c]));

export const RECRUITER_SWEEPS: StaffSweep[] = [
  {
    name: "recruiter:payroll",
    intervalMs: 5 * 60_000,
    run: async (admin, nowMs) => {
      const companies = (await companiesFor(admin, nowMs)).filter((c) => c.settings.payroll.enabled);
      if (companies.length) await sweepPayroll(admin, nowMs, companies);
    },
  },
  {
    name: "recruiter:applicants",
    intervalMs: 2 * 60_000,
    run: async (admin, nowMs) => {
      const companies = (await companiesFor(admin, nowMs)).filter((c) => c.settings.hiring.enabled);
      if (companies.length === 0) return;
      const map = byId(companies);
      await sweepScreening(admin, nowMs, map);
      await sweepConfirmations(admin, nowMs, map);
      await sweepQueuedInvites(admin, nowMs, map);
    },
  },
  {
    name: "recruiter:digest",
    intervalMs: 5 * 60_000,
    run: async (admin, nowMs) => {
      const companies = (await companiesFor(admin, nowMs)).filter((c) => c.settings.hiring.enabled);
      if (companies.length) await sweepDigest(admin, nowMs, companies);
    },
  },
];

export const recruiterRole: StaffRoleModule = {
  ...emptyRole("recruiter"),
  activeFor: recruiterActiveFor,
  approvalExecutors: {
    [PAYROLL_PERIOD_KIND]: (admin, approval, decision) => executePayrollPeriod(admin, approval, decision),
    [JOB_POST_KIND]: (admin, approval, decision) => executeJobPost(admin, approval, decision),
    [INTERVIEW_INVITE_KIND]: (admin, approval, decision) => executeInterviewInvite(admin, approval, decision),
  },
  agentPromptNotes: [
    "Job applicants: this business may be hiring. If the person is asking about a job, their application, an interview or work (or the history shows a \"thanks for applying\" or interview text from the business), they are a job applicant, not a customer: never quote, book or sell to them, never say whether they'll get the job, and never ask about age, family, health, origin or anything personal. Call hand_off_to_owner with a short reason (\"job applicant: …\") and tell them the owner will get back to them.",
  ],
  ownerTools: recruiterOwnerTools(),
  ownerPromptNotes: [
    "Hiring: when the owner wants to hire (\"I need a labourer, $22/hr, start Monday\") use start_hiring with their words; it only drafts - reply with its tell_owner_exactly text word for word (it carries the Y code). Never invent pay. Use applicants for who applied (scores are job-requirements only and never reject anyone), invite_applicant to propose texting one (relay tell_owner_exactly), close_job when they've hired. Never judge applicants on age, sex, family, health, origin or anything personal.",
    "Payroll: the morning after each pay period ends the owner gets a payroll text (#code) - Y locks the hours and emails the CSV; with open entries (no clock-out) they fix them in the app or reply \"Y <code> anyway\". You can't lock or unlock hours yourself; unlocking and CSV downloads are in Settings > AI front desk > Hiring & payroll.",
  ],
  sweeps: RECRUITER_SWEEPS,
};
