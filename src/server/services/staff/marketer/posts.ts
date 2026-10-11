/**
 * Weekly Google Business Profile post drafts (docs/ai-staff.md → "Marketer"). Monday (or
 * Tuesday as a catch-up) local daytime: one draft per company per week (unique company +
 * week_start), rotating offer → seasonal tip → recent-job highlight. Owner approval kind
 * google_post; on Y the copy + the GBP link is texted to the owner to paste (no GBP API yet).
 */
import type { AdminClient, ApprovalDecision, ExecuteResult, OwnerApprovalRow } from "@/server/services/front-desk/contracts";
import { draftGooglePost, loadBusinessBrief, topicForWeek } from "@/server/services/staff/marketer/ai";
import type { Db, GooglePostDraftRow, PostTopic } from "@/server/services/staff/marketer/db-types";
import { clip, createMarketerApproval, isUniqueViolation, reaskWithoutNote, textOwner, type MarketerDeps } from "@/server/services/staff/marketer/deps";
import { GBP_POSTS_URL } from "@/server/services/staff/marketer/google";
import { listMarketingCompanies, type MarketingCompany } from "@/server/services/staff/marketer/settings";
import { localParts, localWeekStart } from "@/server/services/staff/marketer/time";

export const GOOGLE_POST_KIND = "google_post";
export const POST_APPROVAL_TTL_MS = 72 * 3_600_000;

const TOPIC_LABEL: Record<PostTopic, string> = { offer: "service spotlight", seasonal_tip: "seasonal tip", job_highlight: "recent job" };

export function googlePostSummary(topic: PostTopic, body: string): string {
  return `Google post for this week (${TOPIC_LABEL[topic]}): "${clip(body, 400)}" Y = I text it to you to paste on your Google listing.`;
}

export function postPasteText(body: string): string {
  return `This week's Google post - open ${GBP_POSTS_URL} , tap Add update and paste:\n\n${body}`;
}

/** A recent completed job, described without names or addresses (title / description only). */
async function recentJob(db: Db, company: MarketingCompany, nowMs: number): Promise<string | null> {
  const { data } = await db
    .from("bookings")
    .select("title, description, completed_at")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .eq("status", "completed")
    .gte("completed_at", new Date(nowMs - 14 * 86_400_000).toISOString())
    .order("completed_at", { ascending: false })
    .limit(5);
  const row = ((data ?? []) as Array<{ title: string | null; description: string | null }>).find((r) => r.title?.trim());
  if (!row) return null;
  // Titles often carry the customer's name ("Smith - roof repair"): keep the part after a dash.
  const title = (row.title ?? "").split(/\s[-–—:]\s/).pop()?.trim() ?? "";
  return title ? clip(title, 80) : null;
}

export async function draftWeeklyPost(admin: AdminClient, deps: MarketerDeps, company: MarketingCompany): Promise<"created" | "exists" | "skipped"> {
  const db = admin as Db;
  const nowMs = deps.now();
  if (!company.settings.googlePosts.enabled) return "skipped";
  const weekStart = localWeekStart(nowMs, company.timeZone);
  const job = await recentJob(db, company, nowMs);
  const topic = topicForWeek(weekStart, Boolean(job));
  const nowIso = new Date(nowMs).toISOString();
  const { data: inserted, error } = await db
    .from("google_post_drafts")
    .insert({ organization_id: company.organizationId, company_id: company.companyId, week_start: weekStart, topic, status: "draft", created_at: nowIso, updated_at: nowIso })
    .select("*")
    .single();
  if (error) {
    if (isUniqueViolation(error)) return "exists";
    throw error;
  }
  const draft = inserted as GooglePostDraftRow;
  const scope = { organizationId: company.organizationId, companyId: company.companyId };
  try {
    const brief = await loadBusinessBrief(admin, company);
    const month = Number.parseInt(localParts(nowMs, company.timeZone).month.slice(5, 7), 10);
    const { body } = await draftGooglePost(deps.model, brief, { topic, month, job: topic === "job_highlight" ? job : null }, scope);
    const approval = await createMarketerApproval(admin, deps, {
      ...scope,
      kind: GOOGLE_POST_KIND,
      summary: googlePostSummary(topic, body),
      payload: { postId: draft.id, topic },
      ttlMs: POST_APPROVAL_TTL_MS,
    });
    await db
      .from("google_post_drafts")
      .update({ body, status: "awaiting_owner", approval_id: approval.id, updated_at: nowIso })
      .eq("id", draft.id)
      .eq("organization_id", company.organizationId)
      .eq("company_id", company.companyId);
    return "created";
  } catch (err) {
    await db.from("google_post_drafts").update({ status: "failed", updated_at: nowIso }).eq("id", draft.id).eq("organization_id", company.organizationId);
    throw err;
  }
}

/** Scheduler: Monday (Tuesday catch-up) 09:00–17:00 local. */
export async function sweepGooglePosts(admin: AdminClient, deps: MarketerDeps, companies?: MarketingCompany[]): Promise<{ drafted: number }> {
  const nowMs = deps.now();
  let drafted = 0;
  for (const company of companies ?? (await listMarketingCompanies(admin))) {
    if (!company.settings.googlePosts.enabled) continue;
    const local = localParts(nowMs, company.timeZone);
    if ((local.weekday !== 1 && local.weekday !== 2) || local.hour < 9 || local.hour >= 17) continue;
    try {
      if ((await draftWeeklyPost(admin, deps, company)) === "created") drafted++;
    } catch (err) {
      console.error("[marketer] google post draft failed", company.companyId, err instanceof Error ? err.message : err);
    }
  }
  return { drafted };
}

export async function executeGooglePost(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision, deps: MarketerDeps): Promise<ExecuteResult> {
  const db = admin as Db;
  const id = typeof approval.payload.postId === "string" ? approval.payload.postId : null;
  if (!id) return { ok: false, message: "I couldn't find that post - nothing was done." };
  const nowIso = new Date(deps.now()).toISOString();
  const scoped = (q: Db) => q.eq("id", id).eq("organization_id", approval.organization_id).eq("company_id", approval.company_id);

  if (!decision.approved) {
    const status = decision.decidedVia === "expiry" ? "expired" : "rejected";
    await scoped(db.from("google_post_drafts").update({ status, updated_at: nowIso })).eq("approval_id", approval.id).eq("status", "awaiting_owner");
    return { ok: true, message: status === "expired" ? "This week's Google post wasn't approved in time - skipped." : "OK - skipping this week's Google post." };
  }
  if (decision.ownerNote?.trim()) {
    return reaskWithoutNote(
      admin,
      deps,
      approval,
      async (newId) => {
        const { data } = await scoped(db.from("google_post_drafts").update({ approval_id: newId, updated_at: nowIso })).eq("approval_id", approval.id).eq("status", "awaiting_owner").select("id");
        return ((data ?? []) as unknown[]).length > 0;
      },
      "Google post",
    );
  }
  const { data: claimed } = await scoped(db.from("google_post_drafts").update({ status: "approved", owner_texted_at: nowIso, updated_at: nowIso }))
    .eq("approval_id", approval.id)
    .eq("status", "awaiting_owner")
    .select("*");
  const post = ((claimed ?? []) as GooglePostDraftRow[])[0];
  if (!post) return { ok: true, message: "That Google post was already handled." };
  const body = post.body ?? "";
  const sent = await textOwner(admin, { organizationId: post.organization_id, companyId: post.company_id }, postPasteText(body));
  if (sent !== "sent") {
    await scoped(db.from("google_post_drafts").update({ owner_texted_at: null }));
    return { ok: true, message: `Approved. Paste this on your Google listing (${GBP_POSTS_URL}): ${body}` };
  }
  return { ok: true, message: "Approved - I texted you the post and the link to paste it on Google." };
}
