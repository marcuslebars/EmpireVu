/**
 * Service plans — maintenance agreements and renewals (docs/ai-staff.md → "Service plans").
 *
 *   Plans       templates the owner sells (Settings): price per year or per visit, visit months,
 *               weekday + time, what's included.
 *   Sign-up     /<slug>/plans on the company site: annual plans pay the first year through Stripe
 *               Checkout (the webhook starts the plan); per-visit plans, or no online payments →
 *               `plan_signup` approval. Owner by text: enroll_customer → `plan_signup`.
 *   Agreements  one per customer per term; each drives the recurring_jobs series it created.
 *   Renewals    weekly `plan_renewals` batch → each customer's own renewal link; paid → renewed +
 *               the next term; unpaid 14 days after the term → lapsed (untouched visits come off).
 *   Heads-up    one text ~10 days before each plan visit (unless an automation already texts that
 *               far ahead).
 *
 * Off until the owner creates a plan; house orgs are always off.
 */
import { emptyRole, type StaffRoleModule, type StaffSweep } from "@/server/services/staff/types";
import { offerServicePlan } from "./agent-tool";
import { defaultPlanDeps } from "./agreements";
import { PLAN_RENEWALS_KIND, PLAN_SIGNUP_KIND } from "./approval-kinds";
import { executePlanRenewals, executePlanSignup } from "./approvals";
import { servicePlansOwnerTools } from "./owner-tools";
import { servicePlansActiveFor } from "./settings";
import { sweepHeadsUp, sweepPayments, sweepQueue, sweepRenewals } from "./sweeps";

export const SERVICE_PLAN_SWEEPS: StaffSweep[] = [
  { name: "service-plans:payments", intervalMs: 5 * 60_000, run: async (admin, nowMs) => void (await sweepPayments(admin, nowMs)) },
  { name: "service-plans:renewals", intervalMs: 30 * 60_000, run: async (admin, nowMs) => void (await sweepRenewals(admin, nowMs)) },
  { name: "service-plans:heads-up", intervalMs: 30 * 60_000, run: async (admin, nowMs) => void (await sweepHeadsUp(admin, nowMs)) },
  { name: "service-plans:queue", intervalMs: 2 * 60_000, run: async (admin, nowMs) => void (await sweepQueue(admin, nowMs)) },
];

export const servicePlansRole: StaffRoleModule = {
  ...emptyRole("service_plans"),
  activeFor: servicePlansActiveFor,
  approvalExecutors: {
    [PLAN_SIGNUP_KIND]: (admin, approval, decision) => executePlanSignup(admin, approval, decision, defaultPlanDeps),
    [PLAN_RENEWALS_KIND]: (admin, approval, decision) => executePlanRenewals(admin, approval, decision, defaultPlanDeps),
  },
  agentTools: [offerServicePlan as never],
  agentPromptNotes: [
    "Service plans: if offer_service_plan is available and the customer asks about regular, seasonal or yearly service, a maintenance plan, or having it done every spring / fall, call it and tell them briefly about the plan(s) it returns - only those plans and prices - and that they can sign up at the link. Never sign them up yourself, never promise visit dates or a discount, and never make up a plan. Questions about an existing plan, a renewal or a bill go to hand_off_to_owner.",
  ],
  ownerTools: servicePlansOwnerTools(),
  ownerPromptNotes: [
    "Service plans: use plans_summary for how the maintenance plans are doing (customers, renewals, lapsed, plan revenue). To put a customer on a plan use enroll_customer; it only drafts - reply with its tell_owner_exactly text word for word (it carries the Y code). Plans are created and edited in Settings > AI front desk > Service plans; renewals are asked about every Monday by text.",
  ],
  sweeps: SERVICE_PLAN_SWEEPS,
};
