/**
 * The Recruiter's owner-by-text tools (scoped to the ONE company the owner's phone resolved to —
 * state.scope; ids from the model are only matched inside it):
 *
 *   start_hiring      "I need a labourer, $22/hr, start Monday" → AI job post → job_post approval
 *                     (asked inline: the agent relays tell_owner_exactly word for word)
 *   applicants        open jobs with their applicants, best first (score + one-line reason)
 *   invite_applicant  "invite Jo" → interview_invite approval (inline)
 *   close_job         takes a job post down (the page stops taking applications)
 *
 * Never throw (return { error }).
 */
import type { ToolRunState } from "@/server/services/owner-channel/tools";
import { prettyPhone, replyInstruction } from "@/server/services/front-desk/approval-text";
import type { RoleOwnerTool } from "@/server/services/staff/types";
import { applicantsOverview, createInviteApproval, defaultApplicantDeps, firstNameOf, rankApplicants, type ApplicantDeps } from "./applicants";
import { INTERVIEW_INVITE_KIND, JOB_POST_KIND } from "./approvals";
import { closeJob, defaultHiringDeps, jobUrlFor, listJobs, matchJobs, startHiring, type HiringDeps } from "./jobs";
import { loadRecruiterCompany, type RecruiterCompany } from "./settings";

const HIRING_OFF = "Hiring is off for this business (Settings > AI front desk > Hiring & payroll).";
/** The owner agent clips replies at 480 characters; an approval question must fit whole. */
const MAX_TELL_OWNER = 470;

type Input = Record<string, unknown>;

function str(value: unknown, max = 300): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

async function hiringCompany(state: ToolRunState): Promise<RecruiterCompany | { error: string }> {
  const company = await loadRecruiterCompany(state.admin, state.scope.organizationId, state.scope.companyId);
  if (!company) return { error: "Business not found." };
  if (!company.settings.hiring.enabled) return { error: HIRING_OFF };
  return company;
}

function tell(code: number | null, summary: string, kind: string, payload: Record<string, unknown> = {}): string {
  const line = `#${code ?? "?"} ${summary} ${replyInstruction(kind, code, payload)}`;
  return line.length <= MAX_TELL_OWNER ? line : `${line.slice(0, MAX_TELL_OWNER - 3)}...`;
}

async function startHiringTool(state: ToolRunState, input: Input, deps: HiringDeps): Promise<Record<string, unknown>> {
  const company = await hiringCompany(state);
  if ("error" in company) return company;
  const request = str(input.request, 1000);
  if (!request) return { error: "What's the job? Pass the owner's words as `request`." };
  const result = await startHiring(
    state.admin,
    company,
    { request, title: str(input.title, 80), pay: str(input.pay, 80), start: str(input.start, 80), location: str(input.location, 120) },
    { askedInlineTo: state.ownerPhone, nowMs: state.nowMs },
    deps,
  );
  if (!result.ok || !result.summary) return { error: result.error ?? "Couldn't draft that job post." };
  return {
    ok: true,
    nothing_posted_yet: true,
    tell_owner_exactly: tell(result.shortCode ?? null, result.summary, JOB_POST_KIND),
  };
}

async function applicantsTool(state: ToolRunState, input: Input): Promise<Record<string, unknown>> {
  const company = await hiringCompany(state);
  if ("error" in company) return company;
  const ref = str(input.job, 120);
  const overview = await applicantsOverview(state.admin, company, (jobs) => {
    const open = jobs.filter((j) => j.status === "open");
    return ref ? matchJobs(jobs, ref) : open.length ? open : jobs.slice(0, 1);
  });
  if (overview.length === 0) return { ok: true, jobs: [], note: ref ? "No job matches that." : "No job posts yet. Say what you're hiring for (e.g. 'I need a labourer, $22/hr, start Monday')." };
  const jobs = await Promise.all(
    overview.map(async ({ job, applicants }) => ({
      job: job.title,
      status: job.status,
      link: job.status === "open" ? await jobUrlFor(state.admin, company, job.id) : null,
      applicants: applicants.length,
      new_since_digest: applicants.filter((a) => !a.digest_at).length,
      list: rankApplicants(applicants)
        .slice(0, 8)
        .map((a) => ({
          name: a.name,
          phone: prettyPhone(a.phone) ?? a.phone,
          score: a.score ? `${a.score}/5` : "not screened yet",
          why: a.score_reason,
          status: a.invited_at ? "invited" : a.status,
          licence: a.drivers_licence === null ? null : a.drivers_licence ? "yes" : "no",
          vehicle: a.has_vehicle === null ? null : a.has_vehicle ? "yes" : "no",
          applied: a.created_at.slice(0, 10),
        })),
    })),
  );
  return { ok: true, jobs, note: "Scores only sort the list (job requirements only). Nobody is rejected automatically - the owner decides. To invite someone use invite_applicant." };
}

async function inviteTool(state: ToolRunState, input: Input, deps: ApplicantDeps): Promise<Record<string, unknown>> {
  const company = await hiringCompany(state);
  if ("error" in company) return company;
  const name = str(input.applicant, 120)?.toLowerCase();
  if (!name) return { error: "Who? Pass the applicant's name." };
  const overview = await applicantsOverview(state.admin, company, (jobs) => (str(input.job, 120) ? matchJobs(jobs, str(input.job, 120)) : jobs.filter((j) => j.status === "open")));
  const tokens = name.split(/\s+/).filter(Boolean);
  const matches = overview.flatMap(({ job, applicants }) => applicants.filter((a) => tokens.every((t) => a.name.toLowerCase().includes(t))).map((a) => ({ job, a })));
  if (matches.length === 0) return { ok: false, reason: "No applicant by that name on an open job. Use applicants to see the list." };
  if (matches.length > 1) return { ok: false, reason: "More than one applicant matches - ask which one.", matches: matches.slice(0, 5).map((m) => ({ name: m.a.name, job: m.job.title, phone: prettyPhone(m.a.phone) })) };
  const { job, a } = matches[0];
  if (a.invited_at) return { ok: false, reason: `${a.name} was already invited ${a.invited_at.slice(0, 10)}.` };
  const approval = await createInviteApproval(state.admin, company, a, job, { askedInlineTo: state.ownerPhone, nowMs: state.nowMs }, deps);
  if (!approval) return { ok: false, reason: `${firstNameOf(a.name)} was already invited.` };
  return { ok: true, nothing_sent_yet: true, tell_owner_exactly: tell(approval.shortCode, approval.summary, INTERVIEW_INVITE_KIND) };
}

async function closeJobTool(state: ToolRunState, input: Input): Promise<Record<string, unknown>> {
  const company = await loadRecruiterCompany(state.admin, state.scope.organizationId, state.scope.companyId);
  if (!company) return { error: "Business not found." };
  const open = await listJobs(state.admin, company, ["open"]);
  if (open.length === 0) return { ok: false, reason: "No open job posts." };
  const ref = str(input.job, 120);
  const found = ref ? matchJobs(open, ref) : open.length === 1 ? open : [];
  if (found.length === 0) return { ok: false, reason: ref ? "No open job matches that." : "Which job?", open_jobs: open.map((j) => j.title) };
  if (found.length > 1) return { ok: false, reason: "More than one open job matches - ask which one.", open_jobs: found.map((j) => j.title) };
  const job = found[0];
  const closed = await closeJob(state.admin, company, job.id, state.nowMs);
  return closed ? { ok: true, closed: job.title, note: "The job page no longer takes applications. Applicants already in stay in the list." } : { ok: false, reason: `${job.title} was already closed.` };
}

export function recruiterOwnerTools(hiringDeps: HiringDeps = defaultHiringDeps, applicantDeps: ApplicantDeps = defaultApplicantDeps): RoleOwnerTool[] {
  const guard = (fn: (state: ToolRunState, input: Input) => Promise<Record<string, unknown>>) => async (state: ToolRunState, input: Input) => {
    try {
      return await fn(state, input ?? {});
    } catch (err) {
      console.error("[recruiter] owner tool failed:", err instanceof Error ? err.message : err);
      return { error: "That didn't work on our side." };
    }
  };
  return [
    {
      tool: {
        name: "start_hiring",
        description:
          "The owner wants to hire someone (e.g. 'I need a labourer, $22/hr, start Monday'). Drafts a job post and asks the owner to OK it; nothing is posted until they reply Y with the code. Pass the owner's own words as request; title/pay/start/location only if they said them.",
        input_schema: {
          type: "object",
          properties: {
            request: { type: "string", description: "The owner's words about the job, verbatim." },
            title: { type: "string", description: "Job title, if they said one." },
            pay: { type: "string", description: "Pay exactly as the owner said it (e.g. '$22/hr'). Never invent one." },
            start: { type: "string", description: "Start date as they said it (e.g. 'Monday')." },
            location: { type: "string", description: "Where the work is, if they said." },
          },
          required: ["request"],
        },
      },
      run: guard((state, input) => startHiringTool(state, input, hiringDeps)),
    },
    {
      tool: {
        name: "applicants",
        description: "Job applicants for the open job posts (or one job), best first, with a 1-5 score against the job's requirements and a one-line reason, phone, and whether they were invited.",
        input_schema: { type: "object", properties: { job: { type: "string", description: "Job title words, if the owner named one." } } },
      },
      run: guard((state, input) => applicantsTool(state, input)),
    },
    {
      tool: {
        name: "invite_applicant",
        description:
          "Propose texting an applicant to set up a call about the job ('invite Jo'). Nothing is sent until the owner replies Y with the code; on Y the applicant is texted and their reply goes to the owner.",
        input_schema: {
          type: "object",
          properties: { applicant: { type: "string", description: "The applicant's name." }, job: { type: "string", description: "Job title words, if needed." } },
          required: ["applicant"],
        },
      },
      run: guard((state, input) => inviteTool(state, input, applicantDeps)),
    },
    {
      tool: {
        name: "close_job",
        description: "Take a job post down when the owner has hired or wants to stop taking applications ('close the labourer job').",
        input_schema: { type: "object", properties: { job: { type: "string", description: "Job title words (optional when only one job is open)." } } },
      },
      run: guard((state, input) => closeJobTool(state, input)),
    },
  ];
}
