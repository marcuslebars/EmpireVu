// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): the public jobs pages on a company's generated site
// (/s/<slug>/jobs, /s/<slug>/jobs/<id>) and the apply form. No session. The company is resolved
// FROM THE SLUG ROW ONLY (status 'published'), a job only renders when it's that company's and
// open, and hiring must be on. docs/ai-staff.md → "Hiring & payroll".
// ─────────────────────────────────────────────────────────────────────────────
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { isValidSlug, parseSiteContent } from "@/server/services/dfy/site-content";
import { turnstileSiteKey } from "@/server/services/dfy/site-public";
import { siteUrl } from "@/server/services/dfy/site-url";
import { toE164 } from "@/server/services/retell/payload";
import { defaultApplicantDeps, firstNameOf, submitApplication, type ApplicantDeps, type ApplicationForm } from "./applicants";
import type { Db, JobPostingRow } from "./db-types";
import { listJobs, loadJob } from "./jobs";
import { renderApplied, renderJobClosed, renderJobPage, renderJobsList, type JobsPageContext } from "./jobs-render";
import { isEmail, loadRecruiterCompany, type RecruiterCompany } from "./settings";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface JobsSite {
  company: RecruiterCompany;
  ctx: JobsPageContext;
}

/** The published site for a slug with hiring on, or null (→ the neutral 404). */
export async function loadJobsSite(admin: AdminClient, slug: string): Promise<JobsSite | null> {
  const s = (slug ?? "").trim().toLowerCase();
  if (!isValidSlug(s)) return null;
  const { data, error } = await (admin as Db).from("company_sites").select("id, organization_id, company_id, slug, status, content").eq("slug", s).maybeSingle();
  if (error) throw new Error(`site read failed: ${error.message}`);
  const site = data as { organization_id: string; company_id: string; slug: string; status: string; content: unknown } | null;
  if (!site || site.status !== "published") return null;
  const content = parseSiteContent(site.content);
  if (!content) return null;
  const company = await loadRecruiterCompany(admin, site.organization_id, site.company_id);
  if (!company || !company.active || !company.settings.hiring.enabled) return null;
  return { company, ctx: { content, siteUrl: siteUrl(site.slug, content.facts.brand), turnstileSiteKey: turnstileSiteKey() } };
}

export interface PublicPage {
  status: number;
  html: string | null;
}

export async function jobsListPage(admin: AdminClient, slug: string): Promise<PublicPage> {
  const site = await loadJobsSite(admin, slug);
  if (!site) return { status: 404, html: null };
  const jobs = await listJobs(admin, site.company, ["open"]);
  return { status: 200, html: renderJobsList(site.ctx, jobs) };
}

async function openJob(admin: AdminClient, site: JobsSite, jobId: string): Promise<JobPostingRow | "closed" | null> {
  if (!UUID_RE.test(jobId)) return null;
  const job = await loadJob(admin, site.company, jobId);
  if (!job) return null;
  if (job.status === "closed") return "closed";
  return job.status === "open" ? job : null;
}

export async function jobPage(admin: AdminClient, slug: string, jobId: string): Promise<PublicPage> {
  const site = await loadJobsSite(admin, slug);
  if (!site) return { status: 404, html: null };
  const job = await openJob(admin, site, jobId);
  if (job === "closed") return { status: 410, html: renderJobClosed(site.ctx) };
  if (!job) return { status: 404, html: null };
  return { status: 200, html: renderJobPage(site.ctx, job) };
}

const LIMITS = { name: 120, phone: 20, email: 254, experience: 2000, availability: 500, answer: 500 };

function field(params: URLSearchParams, key: string, max: number): string {
  return (params.get(key) ?? "").split(String.fromCharCode(0)).join("").trim().slice(0, max);
}

function yesNo(value: string): boolean | null {
  return value === "yes" ? true : value === "no" ? false : null;
}

/** Form body → a checked application, or the error to show. PURE. */
export function parseApplicationForm(params: URLSearchParams): { form: ApplicationForm; values: Record<string, string> } | { error: string; values: Record<string, string> } {
  const values: Record<string, string> = {};
  for (const key of ["name", "phone", "email", "experience", "availability", "licence", "vehicle", "q0", "q1", "q2", "t"]) {
    values[key] = field(params, key, key === "experience" ? LIMITS.experience : key === "availability" || key.startsWith("q") ? LIMITS.answer : key === "email" ? LIMITS.email : 120);
  }
  const name = values.name.replace(/\s+/g, " ");
  if (name.length < 2 || /https?:|www\./i.test(name)) return { error: "Please enter your name.", values };
  const phone = toE164(values.phone);
  if (!phone || !/^\+1[2-9]\d{9}$/.test(phone)) return { error: "Please enter a 10-digit Canadian or US cell number.", values };
  if (values.email && !isEmail(values.email)) return { error: "That email doesn't look right - fix it or leave it blank.", values };
  return {
    form: {
      name,
      phone,
      email: values.email ? values.email.toLowerCase() : null,
      experience: values.experience || null,
      availability: values.availability || null,
      driversLicence: yesNo(values.licence),
      hasVehicle: yesNo(values.vehicle),
      answers: [values.q0, values.q1, values.q2],
    },
    values,
  };
}

/** POST: the route already ran the rate limit, honeypot, timing and Turnstile checks. */
export async function applyToJob(
  admin: AdminClient,
  input: { slug: string; jobId: string; params: URLSearchParams; nowMs: number },
  deps: ApplicantDeps = defaultApplicantDeps,
): Promise<PublicPage> {
  const site = await loadJobsSite(admin, input.slug);
  if (!site) return { status: 404, html: null };
  const job = await openJob(admin, site, input.jobId);
  if (job === "closed") return { status: 410, html: renderJobClosed(site.ctx) };
  if (!job) return { status: 404, html: null };
  const parsed = parseApplicationForm(input.params);
  if ("error" in parsed) return { status: 400, html: renderJobPage(site.ctx, job, { values: parsed.values, error: parsed.error }) };
  const result = await submitApplication(admin, { company: site.company, job, form: parsed.form, nowMs: input.nowMs }, deps);
  if (!result.ok) return { status: 400, html: renderJobPage(site.ctx, job, { values: parsed.values, error: result.error ?? "Your application couldn't be sent. Please try again." }) };
  return { status: 200, html: renderApplied(site.ctx, job, firstNameOf(parsed.form.name)) };
}

export function rejectedPage(site: JobsSite, job: JobPostingRow, params: URLSearchParams, error: string): string {
  const values: Record<string, string> = {};
  for (const key of ["name", "phone", "email", "experience", "availability", "licence", "vehicle", "q0", "q1", "q2"]) values[key] = field(params, key, 2000);
  return renderJobPage(site.ctx, job, { values, error });
}

/** The job page again with an error (bot checks / rate limit failed), keeping what they typed. */
export async function jobPageWithError(admin: AdminClient, slug: string, jobId: string, params: URLSearchParams, error: string, status = 400): Promise<PublicPage> {
  const site = await loadJobsSite(admin, slug);
  if (!site) return { status: 404, html: null };
  const job = await openJob(admin, site, jobId);
  if (job === "closed") return { status: 410, html: renderJobClosed(site.ctx) };
  if (!job) return { status: 404, html: null };
  return { status, html: rejectedPage(site, job, params, error) };
}
