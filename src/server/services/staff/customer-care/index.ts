/**
 * Customer care & warranty (docs/ai-staff.md → "Customer care & warranty").
 *
 *   Check-ins   one "how did it go? Reply 1-5" text after each completed job (never gates the
 *               review request: that flow is untouched).
 *   Replies     the SMS agent's record_job_feedback: 4–5 → thanks only; 1–3 / a complaint → a care
 *               case, the owner told at once with care_followup (visit / call / leave it).
 *   Warranty    job_warranties (default + per-service terms), installed equipment; the SMS agent's
 *               check_warranty gives it the facts and asks the owner (warranty_claim).
 *   Visits      the owner's Y texts the customer open times; book_care_visit books the pick as a
 *               new booking linked through care_case_bookings — never auto-invoiced.
 *
 * On for CrankLeads companies where the SMS agent is on; house orgs off unless switched on.
 */
import { emptyRole, type StaffRoleModule, type StaffSweep } from "@/server/services/staff/types";
import { customerCareAgentTools } from "./agent-tools";
import { executeCareFollowup, executeWarrantyClaim } from "./approvals";
import { CARE_FOLLOWUP_KIND, WARRANTY_CLAIM_KIND } from "./cases";
import { customerCareOwnerTools } from "./owner-tools";
import { careActiveFor } from "./settings";
import { sweepCheckins, sweepJobs, sweepOutbox } from "./sweeps";

export const CUSTOMER_CARE_SWEEPS: StaffSweep[] = [
  { name: "customer_care:jobs", intervalMs: 5 * 60_000, run: async (admin, nowMs) => void (await sweepJobs(admin, nowMs)) },
  { name: "customer_care:checkins", intervalMs: 5 * 60_000, run: async (admin, nowMs) => void (await sweepCheckins(admin, nowMs)) },
  { name: "customer_care:outbox", intervalMs: 2 * 60_000, run: async (admin, nowMs) => void (await sweepOutbox(admin, nowMs)) },
];

export const customerCareRole: StaffRoleModule = {
  ...emptyRole("customer_care"),
  activeFor: careActiveFor,
  approvalExecutors: {
    [CARE_FOLLOWUP_KIND]: executeCareFollowup,
    [WARRANTY_CLAIM_KIND]: executeWarrantyClaim,
  },
  agentTools: customerCareAgentTools,
  agentPromptNotes: [
    "Customer care - check-ins: the business texts customers after a job (\"how did the … go? Reply 1-5 (5 = great), or tell us anything we missed\"). When the customer answers that (a number, or how it went), call record_job_feedback with their rating and/or words, then reply as its tell_customer says. Never ask a customer for a review, and never treat a low score differently from a complaint: the tool tells the owner, so don't also call hand_off_to_owner for it.",
    "Customer care - problems with past work: when a customer says something the business did isn't right (a leak after a repair, a part failed, it stopped working), call check_warranty FIRST and follow its tell_customer (it asks the owner when the job is still under warranty, otherwise it tells you to hand off). Its facts are for you only: never say anything is covered, free or under warranty, and never promise a visit, refund or date. Emergencies and safety issues still go straight to hand_off_to_owner.",
    "Customer care - visit times: when the business texted the customer times for a callback or warranty visit (\"Would any of these work: …?\") and they pick one, book it with book_care_visit (not book_slot). Never quote a price for these visits.",
  ],
  ownerTools: customerCareOwnerTools(),
  ownerPromptNotes: [
    "Customer care: care_status shows unhappy customers, warranty claims, callback visits and check-in ratings; warranty_lookup shows a customer's job warranties and installed equipment; resolve_case closes a customer's case; add_equipment records equipment you installed (with its manufacturer warranty date). You can't approve a callback or warranty visit yourself - the owner answers those with Y/N and the number from the text. Never ask customers for reviews based on their check-in answers.",
  ],
  sweeps: CUSTOMER_CARE_SWEEPS,
};
