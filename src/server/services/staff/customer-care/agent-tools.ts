/**
 * Customer care's tools for the customer-facing SMS agent, pinned to the conversation's company and
 * contact:
 *
 *   record_job_feedback  the customer answers the check-in ("4", "2 - still leaking"). 4–5 → thank
 *                        them, nothing else (never a review ask). 1–3 or a complaint → a care case,
 *                        the owner told right away (08:00–21:00) with the care_followup choices.
 *   check_warranty       the customer reports a problem with past work: the facts on file (jobs,
 *                        warranty dates, installed equipment) for the agent's eyes only. Under an
 *                        active warranty → a warranty case + a warranty_claim approval. Never says
 *                        it's covered: that's the owner's call.
 *   book_care_visit      the customer picks one of the times we texted for a callback / warranty
 *                        visit → booked (re-checked open), linked to the case, never invoiced.
 */
import { z } from "zod";

import type { AgentTool, TurnState } from "@/server/services/sms-agent/tools";
import { CARE_FOLLOWUP_KIND, openComplaint, openWarrantyClaim, WARRANTY_CLAIM_KIND } from "./cases";
import { recentCheckinFor } from "./checkins";
import type { CareCheckinRow, CareContact, Db, InstalledEquipmentRow, JobWarrantyRow } from "./db-types";
import { careWorks, loadCareCompany, type CareCompany } from "./settings";
import { dateLabel, equipmentFact, equipmentName, workmanshipFact } from "./texts";
import { localDate } from "./time";
import { bookCareVisit } from "./visits";
import { mentions, warrantiesFor } from "./warranty";

function ownerName(state: TurnState): string {
  return state.facts.ownerFirstName ?? "the owner";
}

async function workingCompany(state: TurnState): Promise<CareCompany | null> {
  const company = await loadCareCompany(state.admin, state.facts.organizationId, state.facts.companyId);
  return company && careWorks(company) ? company : null;
}

function nowMs(state: TurnState): number {
  return state.services.now().getTime();
}

// ── record_job_feedback ───────────────────────────────────────────────────────────────

const recordJobFeedback: AgentTool<{ rating?: number; comment?: string; unhappy?: boolean }> = {
  name: "record_job_feedback",
  description:
    "The customer is answering the business's check-in text after a job (\"how did it go? Reply 1-5\"). Record their rating (1-5) and/or what they said. Set unhappy: true when they describe a problem, even with a high number. Then follow tell_customer.",
  inputSchema: {
    type: "object",
    properties: {
      rating: { type: "integer", minimum: 1, maximum: 5, description: "The number they replied, 1-5 (5 = great). Leave out if they didn't give one." },
      comment: { type: "string", description: "What they said about the job, in their words (short)." },
      unhappy: { type: "boolean", description: "True when they mention a problem, something missed, or are unhappy." },
    },
    additionalProperties: false,
  },
  parse: z.object({ rating: z.number().int().min(1).max(5).optional(), comment: z.string().trim().max(500).optional(), unhappy: z.boolean().optional() }),
  async run(state, input) {
    const company = await workingCompany(state);
    if (!company) return { ok: false, error: "Feedback isn't recorded for this business. Thank them, and use hand_off_to_owner if they're unhappy." };
    if (input.rating == null && !input.comment) return { ok: false, error: "Pass their rating (1-5) or what they said." };
    const scope = { organizationId: company.organizationId, companyId: company.companyId };
    const t = nowMs(state);
    const checkin = await recentCheckinFor(state.admin, scope, state.contact.id, t);
    if (!checkin) {
      return { ok: false, error: "No check-in went to this customer recently, so this isn't a check-in answer. Answer normally; for a problem with past work use check_warranty." };
    }
    const comment = input.comment ? input.comment.replace(/\s+/g, " ").slice(0, 500) : null;
    const rating = input.rating ?? checkin.rating ?? null;
    const combined = [checkin.comment, comment].filter(Boolean).join(" / ").slice(0, 1000) || null;
    await (state.admin as Db)
      .from("care_checkins")
      .update({ rating, comment: combined, answered_at: new Date(t).toISOString() })
      .eq("id", checkin.id)
      .eq("organization_id", scope.organizationId);
    const unhappy = (rating != null && rating <= 3) || input.unhappy === true;
    if (!unhappy) {
      return {
        ok: true,
        recorded: true,
        tell_customer: "Thank them warmly in one short sentence. Don't ask for a review, a referral or anything else.",
      };
    }
    const result = await openComplaint(state.admin, {
      company,
      contact: state.contact as unknown as CareContact,
      checkinId: checkin.id,
      bookingId: (checkin as CareCheckinRow).booking_id,
      jobLabel: checkin.job_label,
      rating,
      comment: comment ?? checkin.comment,
      ownerFirst: state.facts.ownerFirstName,
      conversationId: state.conversation.id,
      nowMs: t,
    });
    for (const id of result.created ? (result.caseRow.approval_ids ?? []) : []) {
      state.effects.approvals.push({ id, shortCode: 0, kind: CARE_FOLLOWUP_KIND });
    }
    if (result.created && result.caseRow.approval_ids?.length) state.effects.collected.approval_ids = result.caseRow.approval_ids;
    return {
      ok: true,
      recorded: true,
      owner_told: true,
      tell_customer: `Thank them for telling you, say you're sorry it wasn't right, and that ${ownerName(state)} will follow up with them directly. Don't promise a time, a visit, a refund or a discount, and don't ask for a review.`,
    };
  },
};

// ── check_warranty ────────────────────────────────────────────────────────────────────

function pickCandidate(problem: string, jobs: JobWarrantyRow[], equipment: InstalledEquipmentRow[], today: string): { job: JobWarrantyRow | null; equipment: InstalledEquipmentRow | null } {
  const activeJobs = jobs.filter((j) => j.ends_on >= today);
  const activeEquipment = equipment.filter((e) => e.manufacturer_warranty_ends && e.manufacturer_warranty_ends >= today);
  const job = activeJobs.find((j) => mentions(problem, j.job_label));
  if (job) return { job, equipment: null };
  const eq = activeEquipment.find((e) => mentions(problem, `${e.make ?? ""} ${e.model ?? ""}`));
  if (eq) return { job: null, equipment: eq };
  // Nothing named: the most recent job still under warranty (the likeliest one), else nothing.
  if (activeJobs.length) return { job: activeJobs[0], equipment: null };
  if (activeEquipment.length === 1) return { job: null, equipment: activeEquipment[0] };
  return { job: null, equipment: null };
}

const checkWarranty: AgentTool<{ problem: string; job_hint?: string }> = {
  name: "check_warranty",
  description:
    "A customer reports a problem with work the business already did (a leak after a repair, something broke, it's not working). Looks up their past jobs, warranty dates and installed equipment, and asks the owner when it's still under warranty. The facts are for you only: never tell the customer something is covered, free or under warranty.",
  inputSchema: {
    type: "object",
    properties: {
      problem: { type: "string", description: "The problem in the customer's words (short)." },
      job_hint: { type: "string", description: "Which job or equipment they mean, if they said (\"the roof\", \"the furnace\")." },
    },
    required: ["problem"],
    additionalProperties: false,
  },
  parse: z.object({ problem: z.string().trim().min(2).max(500), job_hint: z.string().trim().max(100).optional() }),
  async run(state, input) {
    const owner = ownerName(state);
    const company = await workingCompany(state);
    if (!company) return { ok: false, error: `Warranty questions go to ${owner}: use hand_off_to_owner.` };
    const scope = { organizationId: company.organizationId, companyId: company.companyId };
    const t = nowMs(state);
    const today = localDate(new Date(t), company.timeZone);
    const { jobs, equipment } = await warrantiesFor(state.admin, scope, [state.contact.id]);
    const facts = {
      past_jobs: jobs.slice(0, 5).map((j) => ({ job: j.job_label ?? "job", done: dateLabel(j.starts_on), workmanship_warranty_until: dateLabel(j.ends_on), still_under_warranty: j.ends_on >= today })),
      equipment: equipment.slice(0, 5).map((e) => ({
        equipment: equipmentName(e),
        installed: e.installed_on ? dateLabel(e.installed_on) : null,
        manufacturer_warranty_until: e.manufacturer_warranty_ends ? dateLabel(e.manufacturer_warranty_ends) : null,
      })),
      facts_note: "For you only. Don't quote warranty terms or dates to the customer, and never say it's covered or free.",
    };
    const words = [input.problem, input.job_hint].filter(Boolean).join(" ");
    const pick = pickCandidate(words, jobs, equipment, today);
    if (!pick.job && !pick.equipment) {
      return {
        ok: true,
        ...facts,
        under_warranty: false,
        tell_customer: `Nothing on file is still under warranty for this. Don't say whether it's covered. Say sorry for the trouble and that ${owner} will follow up, then use hand_off_to_owner (reason: "problem with past work: ${input.problem.replace(/"/g, "'").slice(0, 120)}").`,
      };
    }
    const fact = pick.job
      ? workmanshipFact(pick.job.starts_on, pick.job.months, pick.job.ends_on)
      : equipmentFact(equipmentName(pick.equipment as InstalledEquipmentRow), pick.equipment?.installed_on ?? null, pick.equipment?.manufacturer_warranty_ends as string);
    const result = await openWarrantyClaim(state.admin, {
      company,
      contact: state.contact as unknown as CareContact,
      problem: input.problem,
      warranty: pick.job,
      equipment: pick.equipment,
      fact,
      jobLabel: pick.job?.job_label ?? (pick.equipment ? equipmentName(pick.equipment) : null),
      ownerFirst: state.facts.ownerFirstName,
      conversationId: state.conversation.id,
      nowMs: t,
    });
    if ("reason" in result) {
      if (result.reason === "already_open") return { ok: true, ...facts, already_asked: true, tell_customer: `Say ${owner} already has this and will be in touch. Don't promise anything.` };
      return { ok: false, error: `Couldn't pass it on. Say ${owner} will follow up, and use hand_off_to_owner.` };
    }
    state.effects.approvals.push({ id: result.approvalId, shortCode: result.shortCode ?? 0, kind: WARRANTY_CLAIM_KIND });
    state.effects.collected.approval_ids = [result.approvalId];
    return {
      ok: true,
      ...facts,
      owner_asked: true,
      tell_customer: `Say sorry for the trouble and that you've passed it to ${owner}, who'll get back to them shortly. Don't say it's covered, free or under warranty, and don't promise a visit or a time.`,
    };
  },
};

// ── book_care_visit ───────────────────────────────────────────────────────────────────

const bookCareVisitTool: AgentTool<{ date?: string; window?: string; starts_at?: string }> = {
  name: "book_care_visit",
  description:
    "The customer is picking one of the times the business texted them for a callback or warranty visit (\"Would any of these work: …?\"). Books that time. Use this instead of book_slot for those visits. Pass the date (YYYY-MM-DD) + window, or starts_at, of the time they chose.",
  inputSchema: {
    type: "object",
    properties: {
      date: { type: "string", description: "YYYY-MM-DD (local)." },
      window: { type: "string", description: "Booking window key (e.g. morning / afternoon), when the business books by window." },
      starts_at: { type: "string", description: "ISO start time, for hourly bookings." },
    },
    additionalProperties: false,
  },
  parse: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), window: z.string().max(32).optional(), starts_at: z.string().max(40).optional() }),
  async run(state, input) {
    const company = await workingCompany(state);
    if (!company) return { ok: false, error: "No visit offer here. Use check_availability / book_slot, or hand off." };
    if (!input.date && !input.starts_at) return { ok: false, error: "Pass the date + window (or starts_at) of the time they picked." };
    const result = await bookCareVisit(state.admin, company, state.facts, state.contact as unknown as CareContact, { date: input.date ?? null, window: input.window ?? null, startsAt: input.starts_at ?? null }, nowMs(state));
    if ("bookingId" in result) {
      state.effects.bookings.push({ id: result.bookingId, label: result.label });
      state.effects.collected.booking_ids = [result.bookingId];
      return { ok: true, booked: result.label, already_booked: result.duplicate, tell_customer: `Tell them the visit is booked for ${result.label} and ${ownerName(state)} will see them then. Don't mention a price.` };
    }
    const failed = result as Extract<typeof result, { ok: false }>;
    if (failed.reason === "not_open") {
      const alternatives = failed.alternatives ?? [];
      state.effects.offeredSlots.push(...alternatives.map((a) => ({ date: a.date, window: a.window, startsAt: a.startsAt, label: a.label })));
      return {
        ok: false,
        reason: "not_open",
        alternatives: alternatives.map((a) => ({ label: a.label, date: a.date, window: a.window, starts_at: a.startsAt })),
        hint: alternatives.length ? "That time just went. Offer these instead, then book the one they pick with book_care_visit." : `Nothing open soon. Say ${ownerName(state)} will call to set a time, and use hand_off_to_owner.`,
      };
    }
    if (failed.reason === "no_offer") return { ok: false, error: "There's no visit offer waiting for this customer. For a normal booking use check_availability / book_slot." };
    return { ok: false, error: `Couldn't book it just now. Say ${ownerName(state)} will confirm the time, and use hand_off_to_owner.` };
  },
};

export const customerCareAgentTools = [recordJobFeedback, checkWarranty, bookCareVisitTool] as unknown as AgentTool<never>[];
