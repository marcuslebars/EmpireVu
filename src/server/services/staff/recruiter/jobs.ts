/**
 * Job posts (docs/ai-staff.md → "Hiring & payroll"). The owner texts "I need a labourer, $22/hr,
 * start Monday" → owner tool start_hiring → Claude drafts the post (ai.ts, checked in code) →
 * `job_post` approval showing it. Y publishes it on the company site (/s/<slug>/jobs/<id>, with
 * an apply form) and texts the owner copy to paste into Indeed or Facebook. close_job takes it
 * down. One job post waits on the owner at a time: a new start_hiring withdraws the old draft.
 */
import type { AdminClient, ApprovalDecision, ExecuteResult, OwnerApprovalRow } from "@/server/services/front-desk/contracts";
import { prettyPhone } from "@/server/services/front-desk/approval-text";
import { sendOwnerSms } from "@/server/services/owner-channel/common";
import { siteUrl } from "@/server/services/dfy/site-url";
import { getPack } from "@/server/services/packs";
import { parseAppliedIndustryPack } from "@/server/services/packs/types";
import { resolveCompanySmsFrom } from "@/server/services/workflow-engine/messaging";
import type { TenantServiceContext } from "@/server/services/shared";
import { defaultRecruiterModel, draftJobPost, type JobBrief, type JobDraft, type RecruiterModel } from "./ai";
import { createRecruiterApproval, defaultRecruiterApprovalDeps, JOB_POST_KIND, supersedeApproval, type RecruiterApprovalDeps } from "./approvals";
import type { Db, JobPostingRow } from "./db-types";
import type { RecruiterCompany } from "./settings";

export const AI_DISCLOSURE = "We use AI to help sort applications. A person reads every one and makes every decision.";
export const VACANCY_STATEMENT = "This is a current opening.";

export interface HiringDeps extends RecruiterApprovalDeps {
  model: RecruiterModel;
  sendOwnerSms: typeof sendOwnerSms;
}

export const defaultHiringDeps: HiringDeps = {
  ...defaultRecruiterApprovalDeps,
  model: defaultRecruiterModel,
  sendOwnerSms: (admin, input) => sendOwnerSms(admin, input),
};

function arr(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Normalise a job_postings row (jsonb arrays). */
export function toJob(row: Record<string, unknown>): JobPostingRow {
  const r = row as unknown as JobPostingRow;
  return { ...r, duties: arr(row.duties), requirements: arr(row.requirements), nice_to_have: arr(row.nice_to_have), custom_questions: arr(row.custom_questions) };
}

export async function loadJob(admin: AdminClient, scope: { organizationId: string; companyId: string }, jobId: string): Promise<JobPostingRow | null> {
  const { data } = await (admin as Db).from("job_postings").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("id", jobId).maybeSingle();
  return data ? toJob(data as Record<string, unknown>) : null;
}

export async function listJobs(admin: AdminClient, scope: { organizationId: string; companyId: string }, statuses: JobPostingRow["status"][]): Promise<JobPostingRow[]> {
  const { data } = await (admin as Db)
    .from("job_postings")
    .select("*")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .in("status", statuses)
    .order("created_at", { ascending: false })
    .limit(50);
  return ((data ?? []) as Array<Record<string, unknown>>).map(toJob);
}

/** The company's published generated site slug, if any (the jobs pages live under it). */
export async function publishedSiteSlug(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<string | null> {
  const { data } = await (admin as Db)
    .from("company_sites")
    .select("slug, status")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("status", "published")
    .limit(1);
  return ((data ?? []) as Array<{ slug: string | null }>)[0]?.slug ?? null;
}

export function jobUrl(slug: string, jobId: string, brand: string | null): string {
  return `${siteUrl(slug, brand === "crankleads" ? "crankleads" : "empirevu")}/jobs/${jobId}`;
}

export async function jobUrlFor(admin: AdminClient, company: RecruiterCompany, jobId: string): Promise<string | null> {
  const slug = await publishedSiteSlug(admin, company).catch(() => null);
  return slug ? jobUrl(slug, jobId, company.platformBrand) : null;
}

async function jobBrief(admin: AdminClient, company: RecruiterCompany): Promise<JobBrief> {
  const { data } = await (admin as Db).from("companies").select("industry_pack, service_area").eq("organization_id", company.organizationId).eq("id", company.companyId).maybeSingle();
  const row = (data ?? {}) as { industry_pack?: unknown; service_area?: string | null };
  const applied = parseAppliedIndustryPack(row.industry_pack ?? null);
  return { businessName: company.name, trade: applied ? (getPack(applied.id)?.name ?? null) : null, serviceArea: row.service_area?.trim() || null };
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
}

function facts(job: Pick<JobPostingRow, "pay_text" | "employment_type" | "start_text" | "location">): string {
  return [job.pay_text, job.employment_type, job.start_text ? `start ${job.start_text.replace(/^start(ing)?\s+/i, "")}` : null, job.location].filter(Boolean).join(", ");
}

/** The job_post approval text (without the reply line), ≤ 400 so the owner agent can relay it whole. PURE. */
export function buildJobPostSummary(job: Pick<JobPostingRow, "title" | "pay_text" | "employment_type" | "start_text" | "location" | "duties" | "requirements" | "custom_questions">, url: string | null): string {
  const head = `Job post "${job.title}"${facts(job) ? ` - ${facts(job)}` : ""}.`;
  const noPay = job.pay_text ? "" : ' No pay given - Ontario requires the pay or a pay range on public job posts: reply N and text me again with it, e.g. "$22-$25/hr".';
  const where = url ? `Y publishes it on your website with an apply form and texts you copy for Indeed/Facebook.` : `Y opens it and texts you copy for Indeed/Facebook (your website isn't live, so people apply by texting your business number).`;
  const asks = job.custom_questions.length ? ` Form also asks: ${job.custom_questions.map((q) => `"${clip(q, 60)}"`).join(", ")}.` : "";
  for (const [d, r] of [[4, 3], [3, 3], [2, 2], [1, 1], [0, 0]] as const) {
    const duties = d ? ` Duties: ${job.duties.slice(0, d).map((x) => clip(x, 70)).join("; ")}.` : "";
    const needs = r ? ` Needs: ${job.requirements.slice(0, r).map((x) => clip(x, 70)).join("; ")}.` : "";
    const text = `${head}${duties}${needs}${asks}${noPay} ${where}`;
    if (text.length <= 400) return text;
  }
  return clip(`${head} ${where}`, 400);
}

/**
 * Copy for Indeed / Facebook, texted to the owner after Y. Always ends with how to apply and the
 * 2026 Ontario job-posting disclosures (a current vacancy; AI helps screen) — only the job details
 * are clipped to fit 560 characters. PURE.
 */
export function pasteCopy(job: JobPostingRow, businessName: string, url: string | null, businessPhone: string | null): string {
  const details = [
    `${businessName} is hiring: ${job.title}${facts(job) ? ` (${facts(job)})` : ""}.`,
    job.duties.length ? `You'll: ${job.duties.slice(0, 4).join("; ")}.` : null,
    job.requirements.length ? `You need: ${job.requirements.slice(0, 4).join("; ")}.` : null,
  ].filter((l): l is string => Boolean(l));
  const apply = url ? `Apply here: ${url}` : businessPhone ? `To apply, text ${businessPhone} with your name and experience.` : "To apply, message us with your name and experience.";
  const tail = `${apply} ${VACANCY_STATEMENT} ${AI_DISCLOSURE}`;
  return `${clip(details.join(" "), Math.max(60, 560 - tail.length - 1))} ${tail}`;
}

export interface StartHiringInput {
  request: string;
  title?: string | null;
  pay?: string | null;
  start?: string | null;
  location?: string | null;
}

export interface StartHiringResult {
  ok: boolean;
  error?: string;
  jobId?: string;
  shortCode?: number | null;
  summary?: string;
  draft?: JobDraft;
}

/**
 * Draft a job post and ask the owner (inline when `askedInlineTo` is the owner's phone — the
 * owner agent replies with the question). A job draft already waiting is withdrawn first.
 */
export async function startHiring(
  admin: AdminClient,
  company: RecruiterCompany,
  input: StartHiringInput,
  options: { askedInlineTo: string | null; nowMs: number },
  deps: HiringDeps = defaultHiringDeps,
): Promise<StartHiringResult> {
  const db = admin as Db;
  if (!company.settings.hiring.enabled) return { ok: false, error: "Hiring is off for this business (Settings > AI front desk > Hiring & payroll)." };
  const request = input.request.trim().slice(0, 1000);
  if (request.length < 3) return { ok: false, error: "What's the job? e.g. \"I need a labourer, $22/hr, start Monday\"." };

  // One draft at a time: withdraw any job post still waiting on the owner.
  for (const old of await listJobs(admin, company, ["draft", "awaiting_owner"])) {
    await db.from("job_postings").update({ status: "rejected" }).eq("id", old.id).eq("organization_id", company.organizationId).in("status", ["draft", "awaiting_owner"]);
    if (old.approval_id) await supersedeApproval(admin, old.approval_id);
  }

  const draft = await draftJobPost(deps.model, await jobBrief(admin, company), request, input, company);
  const { data: inserted, error } = await db
    .from("job_postings")
    .insert({
      organization_id: company.organizationId,
      company_id: company.companyId,
      title: draft.title,
      pay_text: draft.pay,
      employment_type: draft.employmentType,
      start_text: draft.start,
      location: draft.location,
      summary: draft.summary,
      duties: draft.duties,
      requirements: draft.requirements,
      nice_to_have: draft.niceToHave,
      custom_questions: draft.customQuestions,
      owner_request: request,
      status: "draft",
      draft_source: draft.source,
    })
    .select("*")
    .single();
  if (error || !inserted) return { ok: false, error: "Couldn't save the job post - try again in a minute." };
  const job = toJob(inserted as Record<string, unknown>);
  const url = await jobUrlFor(admin, company, job.id);
  const approval = await createRecruiterApproval(
    admin,
    { organizationId: company.organizationId, companyId: company.companyId, kind: JOB_POST_KIND, summary: buildJobPostSummary(job, url), payload: { jobId: job.id, title: job.title }, askedInlineTo: options.askedInlineTo },
    options.nowMs,
    deps,
  );
  const { data: linked } = await db
    .from("job_postings")
    .update({ status: "awaiting_owner", approval_id: approval.id })
    .eq("id", job.id)
    .eq("organization_id", company.organizationId)
    .eq("status", "draft")
    .select("id");
  if (((linked ?? []) as unknown[]).length === 0) {
    await supersedeApproval(admin, approval.id);
    return { ok: false, error: "Couldn't save the job post - try again in a minute." };
  }
  return { ok: true, jobId: job.id, shortCode: approval.shortCode, summary: approval.summary, draft };
}

/** job_post: Y opens the post (+ paste copy to the owner); N / expiry → not posted. */
export async function executeJobPost(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision, deps: HiringDeps = defaultHiringDeps, nowMs: number = Date.now()): Promise<ExecuteResult> {
  const db = admin as Db;
  const code = approval.short_code ?? "?";
  const jobId = typeof approval.payload?.jobId === "string" ? approval.payload.jobId : null;
  const scope = { organizationId: approval.organization_id, companyId: approval.company_id };
  const job = jobId ? await loadJob(admin, scope, jobId) : null;
  if (!job || job.approval_id !== approval.id) return { ok: false, message: `#${code} isn't linked to a job post any more, so nothing was posted.` };

  if (!decision.approved) {
    const expired = decision.decidedVia === "expiry";
    await db.from("job_postings").update({ status: expired ? "expired" : "rejected" }).eq("id", job.id).eq("organization_id", scope.organizationId).eq("status", "awaiting_owner");
    return {
      ok: true,
      message: expired
        ? `The ${job.title} job post wasn't published (no answer). Text me "hire a ${job.title.toLowerCase()}" to start again.`
        : `OK, the ${job.title} job isn't posted. Text me what to change (e.g. the pay or start date) and I'll redraft it.`,
    };
  }

  if (job.status === "open") return { ok: true, message: `The ${job.title} job is already posted.` };
  const { data: opened } = await db
    .from("job_postings")
    .update({ status: "open", published_at: new Date(nowMs).toISOString() })
    .eq("id", job.id)
    .eq("organization_id", scope.organizationId)
    .eq("status", "awaiting_owner")
    .select("id");
  if (((opened ?? []) as unknown[]).length === 0) return { ok: false, message: `The ${job.title} job post was withdrawn, so nothing was posted.` };

  const { data: companyRow } = await db.from("companies").select("id, organization_id, name, brand_from_name, owner_phone_e164, owner_phone_verified_at").eq("organization_id", scope.organizationId).eq("id", scope.companyId).maybeSingle();
  const c = (companyRow ?? {}) as { name?: string; brand_from_name?: string | null; owner_phone_e164?: string | null; owner_phone_verified_at?: string | null };
  const businessName = c.brand_from_name?.trim() || c.name || "the business";
  const { data: org } = await db.from("organizations").select("platform_brand").eq("id", scope.organizationId).maybeSingle();
  const brand = (org as { platform_brand?: string | null } | null)?.platform_brand ?? null;
  const slug = await publishedSiteSlug(admin, scope).catch(() => null);
  const url = slug ? jobUrl(slug, job.id, brand) : null;
  const ctx = { organizationId: scope.organizationId, actorProfileId: null, supabase: admin } as TenantServiceContext;
  const businessPhone = prettyPhone(await resolveCompanySmsFrom(ctx, scope.companyId));

  // The paste copy goes once (claimed by owner_texted_at).
  const ownerPhone = c.owner_phone_verified_at && c.owner_phone_e164 ? c.owner_phone_e164 : null;
  let texted = false;
  if (ownerPhone) {
    const { data: claim } = await db.from("job_postings").update({ owner_texted_at: new Date(nowMs).toISOString() }).eq("id", job.id).eq("organization_id", scope.organizationId).is("owner_texted_at", null).select("id");
    if (((claim ?? []) as unknown[]).length) {
      const sent = await deps.sendOwnerSms(admin, {
        to: ownerPhone,
        body: `Copy for Indeed/Facebook:\n${pasteCopy({ ...job, status: "open" }, businessName, url, businessPhone)}`,
        organizationId: scope.organizationId,
        companyId: scope.companyId,
        platformBrand: brand,
      });
      texted = sent.status === "sent";
      if (!texted) await db.from("job_postings").update({ owner_texted_at: null }).eq("id", job.id).eq("organization_id", scope.organizationId);
    }
  }
  const where = url ? `Posted the ${job.title} job: ${url}` : `The ${job.title} job is open (people apply by texting your business number - publish your website to get an apply page).`;
  return { ok: true, message: `${where}${texted ? " Copy for Indeed/Facebook is in my other text." : ""} Text "applicants" any time, or "close the ${job.title.toLowerCase()} job" when you've hired.` };
}

/** Match open jobs by id or words of the title (scope only). PURE. */
export function matchJobs(jobs: JobPostingRow[], ref: string | null): JobPostingRow[] {
  if (!ref) return jobs;
  const byId = jobs.filter((j) => j.id === ref);
  if (byId.length) return byId;
  const tokens = ref.toLowerCase().replace(/\b(the|job|post|posting|position|role|for|a|an)\b/g, " ").split(/\s+/).filter((t) => t.length > 1);
  if (tokens.length === 0) return jobs;
  return jobs.filter((j) => tokens.every((t) => j.title.toLowerCase().includes(t.replace(/s$/, ""))));
}

/** Close an open job (the page stops taking applications). */
export async function closeJob(admin: AdminClient, scope: { organizationId: string; companyId: string }, jobId: string, nowMs: number): Promise<boolean> {
  const { data } = await (admin as Db)
    .from("job_postings")
    .update({ status: "closed", closed_at: new Date(nowMs).toISOString() })
    .eq("id", jobId)
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("status", "open")
    .select("id");
  return ((data ?? []) as unknown[]).length > 0;
}
