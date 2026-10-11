/**
 * Applicants (docs/ai-staff.md → "Hiring & payroll").
 *
 *   apply      the public form on /s/<slug>/jobs/<id> → job_applicants (one row per job + phone;
 *              applying again updates it) and a contact with metadata.kind "applicant". A new
 *              applicant-only contact has the texting AI paused, so their texts go straight to
 *              the owner (the customer-text relay) — never treated as a customer.
 *   confirm    "thanks for applying" from the company number, 08:00–21:00 local (a later
 *              application is confirmed in the morning). Transactional (they asked), opt-outs
 *              respected, never from the platform number.
 *   screen     the AI scores each applicant 1–5 against the job's stated requirements (ai.ts).
 *   digest     08:30 local, only when there are new applicants: one owner text with the top ones
 *              and a one-line reason, then up to 3 `interview_invite` approvals a day.
 *   invite     Y → "Hi Jo, <business> would like to talk about the <job> job. When's a good time
 *              for a quick call this week?" and the conversation is handed to the owner.
 *
 * Nobody is ever rejected automatically: scores only order the owner's list.
 */
import type { AdminClient, ApprovalDecision, ExecuteResult, OwnerApprovalRow } from "@/server/services/front-desk/contracts";
import { prettyPhone } from "@/server/services/front-desk/approval-text";
import { sendOwnerSms } from "@/server/services/owner-channel/common";
import { addDays, localDate, zonedInstant } from "@/server/services/booking-windows";
import { markOwnerTakeover, setConversationAi } from "@/server/services/sms-agent/takeover";
import type { TenantServiceContext } from "@/server/services/shared";
import { deliverMessage, resolveCompanySmsFrom, type ConsentContact } from "@/server/services/workflow-engine/messaging";
import { defaultRecruiterModel, screenApplicant, type RecruiterModel } from "./ai";
import { createRecruiterApproval, defaultRecruiterApprovalDeps, INTERVIEW_INVITE_KIND, type RecruiterApprovalDeps } from "./approvals";
import type { ApplicantAnswer, Db, JobApplicantRow, JobPostingRow } from "./db-types";
import { listJobs, loadJob, toJob } from "./jobs";
import { localHour } from "./payroll";
import { loadRecruiterCompany, type RecruiterCompany } from "./settings";

export const RECRUITER_SENDER = "recruiter";
/** Applicant texts (confirmation) only go out in these local hours. */
export const APPLICANT_TEXT_HOURS = { from: 8, until: 21 };
export const DIGEST_TIME = { hour: 8, minute: 30 };
export const DIGEST_LAST_HOUR = 11;
export const MAX_INVITES_PER_DAY = 3;
const SCREEN_MAX_ATTEMPTS = 3;
const SCREEN_BATCH = 20;

export interface ApplicantDeps extends RecruiterApprovalDeps {
  model: RecruiterModel;
  deliver: typeof deliverMessage;
  sendOwnerSms: typeof sendOwnerSms;
}

export const defaultApplicantDeps: ApplicantDeps = {
  ...defaultRecruiterApprovalDeps,
  model: defaultRecruiterModel,
  deliver: (input) => deliverMessage(input),
  sendOwnerSms: (admin, input) => sendOwnerSms(admin, input),
};

function toApplicant(row: Record<string, unknown>): JobApplicantRow {
  const r = row as unknown as JobApplicantRow;
  return { ...r, answers: Array.isArray(row.answers) ? (row.answers as ApplicantAnswer[]) : [] };
}

export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] || "there";
}

function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0] ?? name;
}

function tenant(admin: AdminClient, organizationId: string): TenantServiceContext {
  return { organizationId, actorProfileId: null, supabase: admin } as TenantServiceContext;
}

function withinHours(nowMs: number, timeZone: string): boolean {
  const h = localHour(nowMs, timeZone);
  return h >= APPLICANT_TEXT_HOURS.from && h < APPLICANT_TEXT_HOURS.until;
}

/** The interview text (exact; the owner sees it before Y). PURE. */
export function inviteText(name: string, businessName: string, jobTitle: string): string {
  return `Hi ${firstNameOf(name)}, ${businessName} would like to talk about the ${jobTitle} job. When's a good time for a quick call this week?`;
}

/** "Thanks for applying" (exact). PURE. */
export function confirmationText(name: string, businessName: string, jobTitle: string): string {
  return `Hi ${firstNameOf(name)}, thanks for applying for the ${jobTitle} job at ${businessName}. We got your application and we'll be in touch.`;
}

/** Transactional consent for an applicant text: their application, but a STOP always wins. */
function applicantConsent(contact: { sms_opt_out_at: string | null; email_opt_out_at: string | null }, nowMs: number): ConsentContact {
  return { sms_opt_out_at: contact.sms_opt_out_at, email_opt_out_at: contact.email_opt_out_at, sms_consent_at: new Date(nowMs).toISOString(), consent_source: "job_application" };
}

// ── Apply ────────────────────────────────────────────────────────────────────

export interface ApplicationForm {
  name: string;
  phone: string;
  email: string | null;
  experience: string | null;
  availability: string | null;
  driversLicence: boolean | null;
  hasVehicle: boolean | null;
  answers: string[];
}

export interface ApplyResult {
  ok: boolean;
  error?: string;
  applicantId?: string;
  duplicate?: boolean;
}

function splitName(name: string): { first: string; last: string | null } {
  const parts = name.trim().split(/\s+/);
  return { first: parts[0] ?? name, last: parts.length > 1 ? parts.slice(1).join(" ") : null };
}

async function applicantContact(admin: AdminClient, company: RecruiterCompany, form: ApplicationForm & { phone: string }, jobId: string, nowMs: number): Promise<{ id: string; created: boolean } | null> {
  const db = admin as Db;
  const last10 = form.phone.replace(/\D/g, "").slice(-10);
  const { data: found } = await db
    .from("contacts")
    .select("id, metadata, email")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .eq("phone_last10", last10)
    .order("created_at", { ascending: true })
    .limit(1);
  const existing = ((found ?? []) as Array<{ id: string; metadata: unknown; email: string | null }>)[0];
  if (existing) {
    const meta = existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata) ? { ...(existing.metadata as Record<string, unknown>) } : {};
    const jobs = Array.isArray(meta.applicant_job_ids) ? (meta.applicant_job_ids as unknown[]).filter((v): v is string => typeof v === "string") : [];
    meta.applicant_job_ids = [...new Set([...jobs, jobId])].slice(-20);
    // Never fill in or overwrite a customer's details from a public form.
    await db.from("contacts").update({ metadata: meta }).eq("organization_id", company.organizationId).eq("id", existing.id);
    return { id: existing.id, created: false };
  }
  const { first, last } = splitName(form.name);
  // Direct insert (no contact.created event): an applicant must never trigger lead automations.
  const { data: created, error } = await db
    .from("contacts")
    .insert({
      organization_id: company.organizationId,
      company_id: company.companyId,
      first_name: first.slice(0, 80),
      last_name: last?.slice(0, 80) ?? null,
      phone: form.phone,
      email: form.email,
      metadata: { kind: "applicant", applicant_job_ids: [jobId] },
      consent_source: "job_application",
      sms_consent_at: new Date(nowMs).toISOString(),
      notes: "Job applicant (Hiring & payroll).",
    })
    .select("id")
    .single();
  if (error || !created) return null;
  return { id: (created as { id: string }).id, created: true };
}

/** One application (the public route already checked the form, the bot signals and the rate limit). */
export async function submitApplication(
  admin: AdminClient,
  input: { company: RecruiterCompany; job: JobPostingRow; form: ApplicationForm; nowMs: number },
  deps: ApplicantDeps = defaultApplicantDeps,
): Promise<ApplyResult> {
  const db = admin as Db;
  const { company, job, form, nowMs } = input;
  if (job.status !== "open" || !company.settings.hiring.enabled) return { ok: false, error: "This job isn't taking applications any more." };
  const answers: ApplicantAnswer[] = job.custom_questions.slice(0, 3).map((question, i) => ({ question, answer: (form.answers[i] ?? "").trim().slice(0, 500) }));
  const nowIso = new Date(nowMs).toISOString();
  const fields = {
    name: form.name,
    email: form.email,
    experience: form.experience,
    availability: form.availability,
    drivers_licence: form.driversLicence,
    has_vehicle: form.hasVehicle,
    answers,
    last_applied_at: nowIso,
  };
  const { data: prior } = await db.from("job_applicants").select("*").eq("organization_id", company.organizationId).eq("job_id", job.id).eq("phone", form.phone).maybeSingle();
  if (prior) {
    const p = toApplicant(prior as Record<string, unknown>);
    // Same person again: refresh their answers (re-screened), no second confirmation text.
    await db
      .from("job_applicants")
      .update({ ...fields, applied_count: (p.applied_count ?? 1) + 1, screened_at: null, screen_attempts: 0 })
      .eq("id", p.id)
      .eq("organization_id", company.organizationId);
    return { ok: true, applicantId: p.id, duplicate: true };
  }
  const contact = await applicantContact(admin, company, form, job.id, nowMs);
  const { data: inserted, error } = await db
    .from("job_applicants")
    .insert({
      organization_id: company.organizationId,
      company_id: company.companyId,
      job_id: job.id,
      contact_id: contact?.id ?? null,
      phone: form.phone,
      status: "new",
      confirmation_status: "pending",
      screen_attempts: 0,
      applied_count: 1,
      created_at: nowIso,
      ...fields,
    })
    .select("*")
    .single();
  if (error || !inserted) {
    if ((error as { code?: string } | null)?.code === "23505") return { ok: true, duplicate: true };
    return { ok: false, error: "Your application couldn't be sent. Please try again." };
  }
  const applicant = toApplicant(inserted as Record<string, unknown>);
  if (contact?.created) {
    // An applicant-only contact: the texting AI stays out; their texts reach the owner.
    await setConversationAi(admin, { companyId: company.companyId, contactId: contact.id, on: false }).catch((err: unknown) => {
      console.error("[recruiter] pausing the AI for an applicant failed:", err instanceof Error ? err.message : err);
    });
  }
  if (withinHours(nowMs, company.timeZone)) await sendConfirmation(admin, company, applicant, job, nowMs, deps);
  return { ok: true, applicantId: applicant.id };
}

async function loadContactFor(admin: AdminClient, organizationId: string, contactId: string | null): Promise<{ id: string; phone: string | null; sms_opt_out_at: string | null; email_opt_out_at: string | null; metadata: unknown } | null> {
  if (!contactId) return null;
  const { data } = await (admin as Db).from("contacts").select("id, phone, sms_opt_out_at, email_opt_out_at, metadata").eq("organization_id", organizationId).eq("id", contactId).maybeSingle();
  return (data as { id: string; phone: string | null; sms_opt_out_at: string | null; email_opt_out_at: string | null; metadata: unknown } | null) ?? null;
}

/** The confirmation text, claimed pending → sending → sent/skipped/failed. */
export async function sendConfirmation(admin: AdminClient, company: RecruiterCompany, applicant: JobApplicantRow, job: Pick<JobPostingRow, "title">, nowMs: number, deps: ApplicantDeps = defaultApplicantDeps): Promise<"sent" | "skipped" | "failed" | "claimed_elsewhere"> {
  const db = admin as Db;
  const { data: claim } = await db
    .from("job_applicants")
    .update({ confirmation_status: "sending" })
    .eq("id", applicant.id)
    .eq("organization_id", company.organizationId)
    .eq("confirmation_status", "pending")
    .select("id");
  if (((claim ?? []) as unknown[]).length === 0) return "claimed_elsewhere";
  const finish = (status: "sent" | "skipped" | "failed") =>
    db.from("job_applicants").update({ confirmation_status: status, confirmation_sent_at: status === "sent" ? new Date(nowMs).toISOString() : null }).eq("id", applicant.id).eq("organization_id", company.organizationId);
  const ctx = tenant(admin, company.organizationId);
  // Only from the company's own number (a reply must reach this business, never another's line).
  const from = await resolveCompanySmsFrom(ctx, company.companyId);
  const contact = await loadContactFor(admin, company.organizationId, applicant.contact_id);
  if (!from || !contact) {
    await finish("skipped");
    return "skipped";
  }
  const result = await deps.deliver({
    context: ctx,
    channel: "sms",
    to: applicant.phone,
    body: confirmationText(applicant.name, company.name, job.title),
    companyId: company.companyId,
    contactId: contact.id,
    consentContact: applicantConsent(contact, nowMs),
    sentBy: RECRUITER_SENDER,
  });
  const status = result.status === "sent" ? "sent" : result.status === "blocked" ? "skipped" : "failed";
  await finish(status);
  return status;
}

/** Morning catch-up for confirmations that came in overnight (or failed to claim). */
/** Company ids in `.in()` chunks (keeps each request small). */
function chunked(ids: string[], size = 100): string[][] {
  const out: string[][] = [];
  for (let k = 0; k < ids.length; k += size) out.push(ids.slice(k, k + size));
  return out;
}

/**
 * Morning catch-up for confirmations that came in overnight. Only rows of companies that are on
 * AND inside their texting hours are read, so one company's waiting rows never block another's.
 */
export async function sweepConfirmations(admin: AdminClient, nowMs: number, companies: Map<string, RecruiterCompany>, deps: ApplicantDeps = defaultApplicantDeps): Promise<number> {
  const db = admin as Db;
  const since = new Date(nowMs - 2 * 86_400_000).toISOString();
  const ready = [...companies.values()].filter((c) => c.settings.hiring.enabled && withinHours(nowMs, c.timeZone)).map((c) => c.companyId);
  let sent = 0;
  for (const ids of chunked(ready)) {
    const { data } = await db.from("job_applicants").select("*").in("company_id", ids).eq("confirmation_status", "pending").gte("created_at", since).order("created_at", { ascending: true }).limit(100);
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const applicant = toApplicant(row);
      const company = companies.get(applicant.company_id);
      if (!company || company.organizationId !== applicant.organization_id) continue;
      const job = await loadJob(admin, company, applicant.job_id);
      if (!job) {
        await db.from("job_applicants").update({ confirmation_status: "skipped" }).eq("id", applicant.id).eq("organization_id", applicant.organization_id).eq("confirmation_status", "pending");
        continue;
      }
      if ((await sendConfirmation(admin, company, applicant, job, nowMs, deps)) === "sent") sent += 1;
    }
  }
  // Older than 2 days and never sent: too late to say thanks — mark skipped.
  await db.from("job_applicants").update({ confirmation_status: "skipped" }).eq("confirmation_status", "pending").lt("created_at", since);
  return sent;
}

// ── Screening ────────────────────────────────────────────────────────────────

/**
 * Screen up to SCREEN_BATCH applicants per pass — only of companies with hiring on and only rows
 * with attempts left, so rows that can't be screened never block the queue. A row whose job is
 * gone is marked done (attempts used up).
 */
export async function sweepScreening(admin: AdminClient, nowMs: number, companies: Map<string, RecruiterCompany>, deps: ApplicantDeps = defaultApplicantDeps): Promise<number> {
  const db = admin as Db;
  const enabled = [...companies.values()].filter((c) => c.settings.hiring.enabled).map((c) => c.companyId);
  let done = 0;
  for (const ids of chunked(enabled)) {
    if (done >= SCREEN_BATCH) break;
    const { data } = await db
      .from("job_applicants")
      .select("*")
      .in("company_id", ids)
      .is("screened_at", null)
      .lt("screen_attempts", SCREEN_MAX_ATTEMPTS)
      .order("created_at", { ascending: true })
      .limit(SCREEN_BATCH - done);
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const a = toApplicant(row);
      const company = companies.get(a.company_id);
      if (!company || company.organizationId !== a.organization_id) continue;
      const job = await loadJob(admin, company, a.job_id);
      // Count the attempt first (a crash mid-call can't loop forever); no job → attempts used up.
      const { data: claim } = await db
        .from("job_applicants")
        .update({ screen_attempts: job ? (a.screen_attempts ?? 0) + 1 : SCREEN_MAX_ATTEMPTS })
        .eq("id", a.id)
        .eq("organization_id", a.organization_id)
        .eq("screen_attempts", a.screen_attempts ?? 0)
        .is("screened_at", null)
        .select("id");
      if (!job || ((claim ?? []) as unknown[]).length === 0) continue;
      const sc = await screenApplicant(deps.model, job, a, company);
      await db
        .from("job_applicants")
        .update({ score: sc.score, score_reason: sc.reason, screening: { meets: sc.meets }, screening_source: sc.source, screened_at: new Date(nowMs).toISOString() })
        .eq("id", a.id)
        .eq("organization_id", a.organization_id);
      done += 1;
    }
  }
  return done;
}

// ── Digest + invites ─────────────────────────────────────────────────────────

/** Best first: score (unscreened last), then who applied first. PURE. */
export function rankApplicants<T extends Pick<JobApplicantRow, "score" | "created_at">>(list: T[]): T[] {
  return [...list].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || Date.parse(a.created_at) - Date.parse(b.created_at));
}

function scoreLabel(a: Pick<JobApplicantRow, "score" | "score_reason">, max = 90): string {
  const why = (a.score_reason ?? "").replace(/\.$/, "").trim();
  const clipped = why.length > max ? `${why.slice(0, max - 3).trimEnd()}...` : why;
  return a.score ? `${a.score}/5${clipped ? ` - ${clipped}` : ""}` : "not screened yet";
}

/** The digest text. ≤ 600 chars. PURE. */
export function buildDigest(input: { companyName: string; applicants: Array<JobApplicantRow & { jobTitle: string }>; invitesComing: number }): string {
  const ranked = rankApplicants(input.applicants);
  const n = ranked.length;
  const jobs = [...new Set(ranked.map((a) => a.jobTitle))];
  const head = `Hiring (${input.companyName}): ${n} new ${n === 1 ? "applicant" : "applicants"}${jobs.length === 1 ? ` for ${jobs[0]}` : ""}.`;
  const foot = `${input.invitesComing ? ` I'll ask you about inviting ${input.invitesComing === 1 ? "the top one" : `the top ${input.invitesComing}`}.` : ""} Text "applicants" for the full list.`;
  for (let shown = Math.min(5, n); shown >= 1; shown--) {
    const lines = ranked.slice(0, shown).map((a) => `${shortName(a.name)}${jobs.length > 1 ? ` (${a.jobTitle})` : ""} ${scoreLabel(a, 60)}`);
    const more = n > shown ? `; +${n - shown} more` : "";
    const text = `${head} Top: ${lines.join("; ")}${more}.${foot}`;
    if (text.length <= 600) return text;
  }
  return `${head}${foot}`;
}

function inviteSummary(a: JobApplicantRow, job: Pick<JobPostingRow, "title">, businessName: string): string {
  const phone = prettyPhone(a.phone) ?? a.phone;
  return `Invite ${a.name} (${phone}) to talk about the ${job.title} job? ${a.score ? `Score ${scoreLabel(a, 70)}.` : "Not screened yet."} Y texts them: "${inviteText(a.name, businessName, job.title)}" Their reply comes to you.`;
}

/** An interview_invite approval for one applicant (one open invite per applicant). */
export async function createInviteApproval(
  admin: AdminClient,
  company: RecruiterCompany,
  applicant: JobApplicantRow,
  job: Pick<JobPostingRow, "id" | "title">,
  options: { askedInlineTo: string | null; nowMs: number },
  deps: ApplicantDeps = defaultApplicantDeps,
): Promise<{ id: string; shortCode: number | null; summary: string } | null> {
  const db = admin as Db;
  if (applicant.invited_at) return null;
  if (applicant.invite_approval_id) {
    const { data } = await db.from("owner_approvals").select("id, short_code, summary, status").eq("id", applicant.invite_approval_id).maybeSingle();
    const existing = data as { id: string; short_code: number | null; summary: string; status: string } | null;
    if (existing?.status === "pending") return { id: existing.id, shortCode: existing.short_code, summary: existing.summary };
  }
  const approval = await createRecruiterApproval(
    admin,
    {
      organizationId: company.organizationId,
      companyId: company.companyId,
      contactId: applicant.contact_id,
      kind: INTERVIEW_INVITE_KIND,
      summary: inviteSummary(applicant, job, company.name),
      payload: { applicantId: applicant.id, jobId: job.id },
      askedInlineTo: options.askedInlineTo,
    },
    options.nowMs,
    deps,
  );
  await db.from("job_applicants").update({ invite_approval_id: approval.id }).eq("id", applicant.id).eq("organization_id", company.organizationId);
  return approval;
}

async function invitesToday(admin: AdminClient, company: RecruiterCompany, nowMs: number): Promise<number> {
  const today = localDate(new Date(nowMs), company.timeZone);
  const since = new Date(nowMs - 26 * 3_600_000).toISOString();
  const { data } = await (admin as Db)
    .from("owner_approvals")
    .select("id, created_at, requested_by")
    .eq("company_id", company.companyId)
    .eq("kind", INTERVIEW_INVITE_KIND)
    .gte("created_at", since)
    .limit(50);
  return ((data ?? []) as Array<{ created_at: string; requested_by: string }>).filter((r) => r.requested_by === "recruiter" && localDate(new Date(r.created_at), company.timeZone) === today).length;
}

export interface DigestOutcome {
  companyId: string;
  status: "sent" | "nothing_new" | "not_due" | "claimed_elsewhere" | "failed" | "no_owner_phone";
  invites?: number;
  body?: string;
}

/** One company's digest for today (claimed once per local date). */
export async function runCompanyDigest(admin: AdminClient, company: RecruiterCompany, nowMs: number, deps: ApplicantDeps = defaultApplicantDeps): Promise<DigestOutcome> {
  const db = admin as Db;
  const h = localHour(nowMs, company.timeZone);
  const minute = Number(new Intl.DateTimeFormat("en-US", { timeZone: company.timeZone, minute: "numeric" }).format(new Date(nowMs)));
  if (h < DIGEST_TIME.hour || (h === DIGEST_TIME.hour && minute < DIGEST_TIME.minute) || h >= DIGEST_LAST_HOUR) return { companyId: company.companyId, status: "not_due" };
  if (!company.ownerPhone) return { companyId: company.companyId, status: "no_owner_phone" };
  const jobs = await listJobs(admin, company, ["open"]);
  if (jobs.length === 0) return { companyId: company.companyId, status: "nothing_new" };
  const titles = new Map(jobs.map((j) => [j.id, j.title]));
  const { data } = await db
    .from("job_applicants")
    .select("*")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .is("digest_at", null)
    .in("job_id", [...titles.keys()])
    .order("created_at", { ascending: true })
    .limit(200);
  const fresh = ((data ?? []) as Array<Record<string, unknown>>).map(toApplicant).filter((a) => a.status === "new");
  if (fresh.length === 0) return { companyId: company.companyId, status: "nothing_new" };

  const today = localDate(new Date(nowMs), company.timeZone);
  const { error: claimError } = await db.from("recruiter_sweep_claims").insert({ company_id: company.companyId, task: "digest", period_key: today });
  if (claimError) return { companyId: company.companyId, status: "claimed_elsewhere" };

  const room = Math.max(0, MAX_INVITES_PER_DAY - (await invitesToday(admin, company, nowMs)));
  const candidates = rankApplicants(fresh.filter((a) => !a.invited_at && !a.invite_approval_id)).slice(0, room);
  const body = buildDigest({ companyName: company.name, applicants: fresh.map((a) => ({ ...a, jobTitle: titles.get(a.job_id) ?? "the" })), invitesComing: candidates.length });
  const sent = await deps.sendOwnerSms(admin, { to: company.ownerPhone, body, organizationId: company.organizationId, companyId: company.companyId, platformBrand: company.platformBrand });
  if (sent.status === "failed") {
    await db.from("recruiter_sweep_claims").delete().eq("company_id", company.companyId).eq("task", "digest").eq("period_key", today);
    return { companyId: company.companyId, status: "failed", body };
  }
  const nowIso = new Date(nowMs).toISOString();
  for (const a of fresh) await db.from("job_applicants").update({ digest_at: nowIso }).eq("id", a.id).eq("organization_id", company.organizationId).is("digest_at", null);
  let invites = 0;
  if (sent.status === "sent") {
    for (const a of candidates) {
      const created = await createInviteApproval(admin, company, a, { id: a.job_id, title: titles.get(a.job_id) ?? "open" }, { askedInlineTo: null, nowMs }, deps).catch((err: unknown) => {
        console.error("[recruiter] invite approval failed", a.id, err instanceof Error ? err.message : err);
        return null;
      });
      if (created) invites += 1;
    }
  }
  return { companyId: company.companyId, status: "sent", invites, body };
}

export async function sweepDigest(admin: AdminClient, nowMs: number, companies: RecruiterCompany[], deps: ApplicantDeps = defaultApplicantDeps): Promise<DigestOutcome[]> {
  const out: DigestOutcome[] = [];
  for (const company of companies) {
    if (!company.settings.hiring.enabled) continue;
    try {
      out.push(await runCompanyDigest(admin, company, nowMs, deps));
    } catch (err) {
      console.error("[recruiter] digest failed", company.companyId, err instanceof Error ? err.message : err);
    }
  }
  return out;
}

/** interview_invite: Y texts the applicant and hands the conversation to the owner; N / expiry → nothing. */
export async function executeInterviewInvite(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision, deps: ApplicantDeps = defaultApplicantDeps, nowMs: number = Date.now()): Promise<ExecuteResult> {
  const db = admin as Db;
  const code = approval.short_code ?? "?";
  const applicantId = typeof approval.payload?.applicantId === "string" ? approval.payload.applicantId : null;
  const { data } = applicantId
    ? await db.from("job_applicants").select("*").eq("organization_id", approval.organization_id).eq("company_id", approval.company_id).eq("id", applicantId).maybeSingle()
    : { data: null };
  if (!data) return { ok: false, message: `#${code} isn't linked to an applicant any more, so nothing was sent.` };
  const a = toApplicant(data as Record<string, unknown>);
  if (!decision.approved) {
    if (a.invite_approval_id === approval.id) await db.from("job_applicants").update({ invite_approval_id: null }).eq("id", a.id).eq("organization_id", a.organization_id).eq("invite_approval_id", approval.id);
    return { ok: true, message: decision.decidedVia === "expiry" ? `No answer on inviting ${a.name}, so I didn't text them. Text "invite ${firstNameOf(a.name)}" if you want to.` : `OK, I won't text ${a.name}.` };
  }
  if (a.invited_at) return { ok: true, message: `${a.name} was already invited.` };
  const company = await loadRecruiterCompany(admin, approval.organization_id, approval.company_id);
  const job = await loadJob(admin, { organizationId: approval.organization_id, companyId: approval.company_id }, a.job_id);
  if (!company || !job) return { ok: false, message: `The job for #${code} is gone, so nothing was sent.` };
  const contact = await loadContactFor(admin, a.organization_id, a.contact_id);
  if (!contact) return { ok: false, message: `${a.name}'s contact is gone, so nothing was sent.` };
  if (contact.sms_opt_out_at) return { ok: false, message: `${a.name} replied STOP to your number, so I can't text them. Their number is ${prettyPhone(a.phone) ?? a.phone}.` };
  const ctx = tenant(admin, a.organization_id);
  if (!(await resolveCompanySmsFrom(ctx, a.company_id))) return { ok: false, message: `Your business has no texting number yet, so I couldn't text ${a.name}. Their number is ${prettyPhone(a.phone) ?? a.phone}.` };
  // Applicant texts only go 08:00–21:00 local: a late Y queues it for the morning sweep.
  if (!withinHours(nowMs, company.timeZone)) {
    const at = nextTextingStart(nowMs, company.timeZone);
    const { data: queued } = await db
      .from("job_applicants")
      .update({ invite_send_after: at.toISOString() })
      .eq("id", a.id)
      .eq("organization_id", a.organization_id)
      .is("invited_at", null)
      .select("id");
    if (((queued ?? []) as unknown[]).length === 0) return { ok: true, message: `${a.name} was already invited.` };
    return { ok: true, message: `It's late, so I'll text ${a.name} about the ${job.title} job at 8am. Their reply will come to you.` };
  }
  const sent = await sendInvite(admin, company, a, job, contact, nowMs, deps);
  if (sent.status === "already") return { ok: true, message: `${a.name} was already invited.` };
  if (sent.status === "failed") return { ok: false, message: `The text to ${a.name} didn't go through (${sent.reason}). Their number is ${prettyPhone(a.phone) ?? a.phone}.` };
  return { ok: true, message: `Texted ${a.name} about the ${job.title} job. Their reply will come to you.` };
}

/** 08:00 local today if it's still ahead, else tomorrow's. */
export function nextTextingStart(nowMs: number, timeZone: string): Date {
  const today = localDate(new Date(nowMs), timeZone);
  const at = zonedInstant(today, `${String(APPLICANT_TEXT_HOURS.from).padStart(2, "0")}:00`, timeZone);
  return at.getTime() > nowMs ? at : zonedInstant(addDays(today, 1), `${String(APPLICANT_TEXT_HOURS.from).padStart(2, "0")}:00`, timeZone);
}

type InviteContact = { id: string; sms_opt_out_at: string | null; email_opt_out_at: string | null; metadata: unknown };

/** Claim (invited_at) → the exact invite text → the conversation goes to the owner. */
async function sendInvite(
  admin: AdminClient,
  company: RecruiterCompany,
  a: JobApplicantRow,
  job: Pick<JobPostingRow, "title">,
  contact: InviteContact,
  nowMs: number,
  deps: ApplicantDeps,
): Promise<{ status: "sent" | "already" | "failed"; reason?: string }> {
  const db = admin as Db;
  const ctx = tenant(admin, a.organization_id);
  // Claim before sending: one text however many times this runs.
  const { data: claim } = await db
    .from("job_applicants")
    .update({ invited_at: new Date(nowMs).toISOString(), status: "invited", invite_send_after: null })
    .eq("id", a.id)
    .eq("organization_id", a.organization_id)
    .is("invited_at", null)
    .select("id");
  if (((claim ?? []) as unknown[]).length === 0) return { status: "already" };
  const result = await deps.deliver({
    context: ctx,
    channel: "sms",
    to: a.phone,
    body: inviteText(a.name, company.name, job.title),
    companyId: a.company_id,
    contactId: contact.id,
    consentContact: applicantConsent(contact, nowMs),
    sentBy: RECRUITER_SENDER,
  });
  if (result.status !== "sent") {
    await db.from("job_applicants").update({ invited_at: null, status: "new" }).eq("id", a.id).eq("organization_id", a.organization_id);
    return { status: "failed", reason: result.reason ?? result.status };
  }
  // Their reply is the owner's: an applicant-only contact stays paused; anyone else is taken over.
  const meta = contact.metadata && typeof contact.metadata === "object" ? (contact.metadata as Record<string, unknown>) : {};
  if (meta.kind === "applicant") await setConversationAi(admin, { companyId: a.company_id, contactId: contact.id, on: false }).catch(() => null);
  else await markOwnerTakeover(admin, { companyId: a.company_id, contactId: contact.id, at: new Date(nowMs) });
  return { status: "sent" };
}

/** Invites the owner OK'd late at night go out from 08:00 local (only for companies in hours). */
export async function sweepQueuedInvites(admin: AdminClient, nowMs: number, companies: Map<string, RecruiterCompany>, deps: ApplicantDeps = defaultApplicantDeps): Promise<number> {
  const db = admin as Db;
  const ready = [...companies.values()].filter((c) => c.settings.hiring.enabled && withinHours(nowMs, c.timeZone)).map((c) => c.companyId);
  let sent = 0;
  for (const ids of chunked(ready)) {
    const { data } = await db
      .from("job_applicants")
      .select("*")
      .in("company_id", ids)
      .is("invited_at", null)
      .lte("invite_send_after", new Date(nowMs).toISOString())
      .order("invite_send_after", { ascending: true })
      .limit(50);
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const a = toApplicant(row);
      const company = companies.get(a.company_id);
      if (!company || company.organizationId !== a.organization_id || !a.invite_send_after) continue;
      const job = await loadJob(admin, company, a.job_id);
      const contact = await loadContactFor(admin, a.organization_id, a.contact_id);
      const drop = async (why: string) => {
        await db.from("job_applicants").update({ invite_send_after: null }).eq("id", a.id).eq("organization_id", a.organization_id).is("invited_at", null);
        if (company.ownerPhone) await deps.sendOwnerSms(admin, { to: company.ownerPhone, body: why, organizationId: company.organizationId, companyId: company.companyId, platformBrand: company.platformBrand });
      };
      if (!job || !contact || contact.sms_opt_out_at) {
        await drop(`I didn't text ${a.name} this morning (${!job ? "the job is gone" : !contact ? "their contact is gone" : "they replied STOP"}).`);
        continue;
      }
      const result = await sendInvite(admin, company, a, job, contact, nowMs, deps);
      if (result.status === "sent") sent += 1;
      else if (result.status === "failed") await drop(`The 8am text to ${a.name} didn't go through (${result.reason}). Their number is ${prettyPhone(a.phone) ?? a.phone}.`);
    }
  }
  return sent;
}

/** Applicants for the owner tool: newest jobs first, best applicants first. */
export async function applicantsOverview(admin: AdminClient, company: RecruiterCompany, jobFilter: (jobs: JobPostingRow[]) => JobPostingRow[]): Promise<Array<{ job: JobPostingRow; applicants: JobApplicantRow[] }>> {
  const jobs = jobFilter(await listJobs(admin, company, ["open", "closed"]));
  const out: Array<{ job: JobPostingRow; applicants: JobApplicantRow[] }> = [];
  for (const job of jobs.slice(0, 5)) {
    const { data } = await (admin as Db)
      .from("job_applicants")
      .select("*")
      .eq("organization_id", company.organizationId)
      .eq("company_id", company.companyId)
      .eq("job_id", job.id)
      .order("created_at", { ascending: false })
      .limit(100);
    out.push({ job, applicants: rankApplicants(((data ?? []) as Array<Record<string, unknown>>).map(toApplicant)) });
  }
  return out;
}

export { toApplicant, toJob };
