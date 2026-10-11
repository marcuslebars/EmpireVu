/**
 * Google reviews (docs/ai-staff.md → "Marketer"):
 *   - once a day per company (local 09:00–20:00, claimed in marketing_sweep_claims), fetch the up
 *     to 5 reviews the Places API (New) returns; refresh companies.google_rating / review count;
 *   - each NEW review from the last 30 days gets an AI reply draft and an owner approval
 *     (kind review_reply). A review of 3 stars or less also gets an immediate heads-up text;
 *   - on Y the reply goes through the `postReply` seam (no GBP API yet → not posted) and the
 *     owner is texted the final reply + the Google link to paste it;
 *   - review text is dropped after 30 days (we keep rating, author, link and our reply).
 */
import type { AdminClient, ApprovalDecision, ExecuteResult, OwnerApprovalRow } from "@/server/services/front-desk/contracts";
import { draftReviewReply, loadBusinessBrief } from "@/server/services/staff/marketer/ai";
import type { Db, GoogleReviewRow } from "@/server/services/staff/marketer/db-types";
import { createMarketerApproval, isUniqueViolation, reaskWithoutNote, textOwner, type MarketerDeps } from "@/server/services/staff/marketer/deps";
import { GBP_REVIEWS_URL } from "@/server/services/staff/marketer/google";
import { listMarketingCompanies, type MarketingCompany } from "@/server/services/staff/marketer/settings";
import { inProactiveHours, localParts } from "@/server/services/staff/marketer/time";

export const REVIEW_REPLY_KIND = "review_reply";
export const REVIEW_APPROVAL_TTL_MS = 72 * 3_600_000;
/** Only reviews this recent get a reply draft (older ones on the first fetch are just recorded). */
export const REVIEW_DRAFT_MAX_AGE_DAYS = 30;
export const REVIEW_TEXT_KEEP_DAYS = 30;
export const LOW_RATING = 3;

function firstAndInitial(author: string | null): string {
  const parts = (author ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "a customer";
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
}

/**
 * The owner's approval text. PURE. The review's own words are NOT copied here (Google's content
 * terms: approvals are kept) - the owner gets who, how many stars and the link to read it.
 */
export function reviewReplySummary(review: { rating: number | null; author: string | null; link: string | null }, reply: string): string {
  const stars = review.rating != null ? `${review.rating}-star` : "new";
  const link = review.link ? ` (${review.link})` : "";
  return `New ${stars} Google review from ${firstAndInitial(review.author).replace(/\.$/, "")}${link}. Reply: "${reply}" Y = I text you this reply to paste on Google.`;
}

/** The copy-paste text for the owner after Y. PURE. */
export function replyPasteText(review: Pick<GoogleReviewRow, "author_name" | "google_maps_uri">, reply: string): string {
  return `Your reply to ${firstAndInitial(review.author_name)}'s Google review - open ${review.google_maps_uri ?? GBP_REVIEWS_URL} , tap Reply and paste:\n\n${reply}`;
}

async function claimDaily(db: Db, company: MarketingCompany, task: string, periodKey: string): Promise<boolean> {
  const { error } = await db.from("marketing_sweep_claims").insert({ company_id: company.companyId, task, period_key: periodKey, created_at: new Date().toISOString() });
  if (!error) return true;
  if (isUniqueViolation(error)) return false;
  throw error;
}

async function draftForReview(admin: AdminClient, deps: MarketerDeps, company: MarketingCompany, row: GoogleReviewRow): Promise<void> {
  const db = admin as Db;
  const scope = { organizationId: company.organizationId, companyId: company.companyId };
  const brief = await loadBusinessBrief(admin, company);
  const { reply } = await draftReviewReply(deps.model, brief, { rating: row.rating, text: row.text, author: row.author_name }, scope);
  const approval = await createMarketerApproval(admin, deps, {
    ...scope,
    kind: REVIEW_REPLY_KIND,
    summary: reviewReplySummary({ rating: row.rating, author: row.author_name, link: row.google_maps_uri }, reply),
    payload: { reviewId: row.id, rating: row.rating },
    ttlMs: REVIEW_APPROVAL_TTL_MS,
  });
  const { error } = await db
    .from("google_reviews")
    .update({ reply_draft: reply, reply_status: "awaiting_owner", approval_id: approval.id, updated_at: new Date(deps.now()).toISOString() })
    .eq("id", row.id)
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId);
  if (error) throw error;

  if (row.rating != null && row.rating <= LOW_RATING) {
    const { data: claimed, error: claimError } = await db
      .from("google_reviews")
      .update({ owner_alerted_at: new Date(deps.now()).toISOString() })
      .eq("id", row.id)
      .eq("organization_id", company.organizationId)
      .is("owner_alerted_at", null)
      .select("id");
    if (claimError) throw claimError;
    if (((claimed ?? []) as unknown[]).length > 0) {
      const link = row.google_maps_uri ? ` Read it: ${row.google_maps_uri}` : "";
      await textOwner(
        admin,
        scope,
        `Heads up: a new ${row.rating}-star Google review for ${company.businessName} from ${firstAndInitial(row.author_name).replace(/\.$/, "")}.${link} I've drafted a calm reply for you to OK (#${approval.short_code ?? "?"}).`,
      );
    }
  }
}

/**
 * Google content is kept at most 30 days: text, author, rating, link and publish time are nulled
 * (we keep the review's resource name - to never draft twice - and our own reply + status).
 * Runs for every company, whatever its settings.
 */
export async function pruneGoogleReviews(admin: AdminClient, nowMs: number): Promise<void> {
  const { error } = await (admin as Db)
    .from("google_reviews")
    .update({ text: null, author_name: null, rating: null, google_maps_uri: null, published_at: null, text_pruned_at: new Date(nowMs).toISOString() })
    .is("text_pruned_at", null)
    .lt("created_at", new Date(nowMs - REVIEW_TEXT_KEEP_DAYS * 86_400_000).toISOString());
  if (error) console.error("[marketer] pruning Google review content failed:", error.message);
}

/** One company's daily review pass. Returns how many new reviews got a draft. */
export async function ingestReviewsForCompany(admin: AdminClient, deps: MarketerDeps, company: MarketingCompany): Promise<{ fetched: number; drafted: number; skipped: boolean }> {
  const db = admin as Db;
  const nowMs = deps.now();
  if (!company.settings.reviewReplies.enabled || !company.googlePlaceId) return { fetched: 0, drafted: 0, skipped: true };
  if (!inProactiveHours(nowMs, company.timeZone)) return { fetched: 0, drafted: 0, skipped: true };
  if (!(await claimDaily(db, company, "google_reviews", localParts(nowMs, company.timeZone).date))) return { fetched: 0, drafted: 0, skipped: true };

  const nowIso = new Date(nowMs).toISOString();
  const fetched = await deps.fetchReviews(company.googlePlaceId);
  if (!fetched) return { fetched: 0, drafted: 0, skipped: true };

  if (fetched.rating != null || fetched.reviewCount != null) {
    await db
      .from("companies")
      .update({
        ...(fetched.rating != null ? { google_rating: fetched.rating } : {}),
        ...(fetched.reviewCount != null ? { google_review_count: fetched.reviewCount } : {}),
      })
      .eq("organization_id", company.organizationId)
      .eq("id", company.companyId);
  }

  let drafted = 0;
  for (const review of fetched.reviews) {
    const fresh = review.publishedAt != null && nowMs - Date.parse(review.publishedAt) <= REVIEW_DRAFT_MAX_AGE_DAYS * 86_400_000;
    const { error } = await db
      .from("google_reviews")
      .insert({
        organization_id: company.organizationId,
        company_id: company.companyId,
        review_name: review.name,
        // An old review (first fetch) is only recorded so it's never drafted: no Google content kept.
        rating: fresh ? review.rating : null,
        text: fresh ? review.text : null,
        author_name: fresh ? review.author : null,
        published_at: fresh ? review.publishedAt : null,
        google_maps_uri: fresh ? review.googleMapsUri : null,
        reply_status: fresh ? "new" : "skipped",
        ...(fresh ? {} : { text_pruned_at: nowIso }),
        created_at: nowIso,
        updated_at: nowIso,
      })
      .select("*")
      .single();
    if (error) {
      if (isUniqueViolation(error)) continue; // seen before
      throw error;
    }
  }

  // Draft every fresh review still at 'new' - this run's, and any a crash left behind.
  const { data: waiting, error: waitingError } = await db
    .from("google_reviews")
    .select("*")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .eq("reply_status", "new")
    .gte("published_at", new Date(nowMs - REVIEW_DRAFT_MAX_AGE_DAYS * 86_400_000).toISOString())
    .limit(20);
  if (waitingError) throw waitingError;
  for (const row of (waiting ?? []) as GoogleReviewRow[]) {
    try {
      await draftForReview(admin, deps, company, row);
      drafted++;
    } catch (err) {
      console.error("[marketer] review reply draft failed", company.companyId, err instanceof Error ? err.message : err);
      await db.from("google_reviews").update({ reply_status: "failed", updated_at: nowIso }).eq("id", row.id).eq("organization_id", company.organizationId);
    }
  }
  return { fetched: fetched.reviews.length, drafted, skipped: false };
}

export async function sweepGoogleReviews(admin: AdminClient, deps: MarketerDeps, companies?: MarketingCompany[]): Promise<{ drafted: number }> {
  await pruneGoogleReviews(admin, deps.now());
  let drafted = 0;
  for (const company of companies ?? (await listMarketingCompanies(admin))) {
    try {
      drafted += (await ingestReviewsForCompany(admin, deps, company)).drafted;
    } catch (err) {
      console.error("[marketer] review fetch failed", company.companyId, err instanceof Error ? err.message : err);
    }
  }
  return { drafted };
}

async function loadReview(db: Db, approval: OwnerApprovalRow): Promise<GoogleReviewRow | null> {
  const id = typeof approval.payload.reviewId === "string" ? approval.payload.reviewId : null;
  if (!id) return null;
  const { data } = await db
    .from("google_reviews")
    .select("*")
    .eq("organization_id", approval.organization_id)
    .eq("company_id", approval.company_id)
    .eq("id", id)
    .maybeSingle();
  return (data as GoogleReviewRow | null) ?? null;
}

export async function executeReviewReply(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision, deps: MarketerDeps): Promise<ExecuteResult> {
  const db = admin as Db;
  const review = await loadReview(db, approval);
  if (!review) return { ok: false, message: "I couldn't find that review - nothing was done." };
  const nowIso = new Date(deps.now()).toISOString();
  const scoped = (q: Db) => q.eq("id", review.id).eq("organization_id", review.organization_id).eq("company_id", review.company_id);

  if (!decision.approved) {
    const status = decision.decidedVia === "expiry" ? "expired" : "rejected";
    await scoped(db.from("google_reviews").update({ reply_status: status, updated_at: nowIso })).eq("approval_id", approval.id).eq("reply_status", "awaiting_owner");
    return { ok: true, message: status === "expired" ? "The review reply wasn't approved in time - nothing was sent." : "OK - no reply drafted for that review." };
  }

  if (decision.ownerNote?.trim()) {
    return reaskWithoutNote(
      admin,
      deps,
      approval,
      async (newId) => {
        const { data } = await scoped(db.from("google_reviews").update({ approval_id: newId, updated_at: nowIso }))
          .eq("approval_id", approval.id)
          .eq("reply_status", "awaiting_owner")
          .select("id");
        return ((data ?? []) as unknown[]).length > 0;
      },
      "review reply",
    );
  }

  const { data: claimed } = await scoped(db.from("google_reviews").update({ reply_status: "approved", updated_at: nowIso }))
    .eq("approval_id", approval.id)
    .eq("reply_status", "awaiting_owner")
    .select("*");
  const row = ((claimed ?? []) as GoogleReviewRow[])[0];
  if (!row) return { ok: true, message: "That review reply was already handled." };
  const reply = row.reply_draft ?? "";

  const posted = await deps.postReply({ organizationId: row.organization_id, companyId: row.company_id, reviewName: row.review_name, reply }).catch(() => ({ posted: false }));
  if (posted.posted) {
    await scoped(db.from("google_reviews").update({ reply_status: "posted", updated_at: nowIso }));
    return { ok: true, message: "Posted your reply on Google." };
  }

  // No GBP API yet: text the owner the final reply + link (claimed so it's sent once).
  const { data: textClaim } = await scoped(db.from("google_reviews").update({ owner_texted_at: nowIso })).is("owner_texted_at", null).select("id");
  if (((textClaim ?? []) as unknown[]).length === 0) return { ok: true, message: "I already texted you that reply to paste." };
  const sent = await textOwner(admin, { organizationId: row.organization_id, companyId: row.company_id }, replyPasteText(row, reply));
  if (sent !== "sent") {
    await scoped(db.from("google_reviews").update({ owner_texted_at: null }));
    return { ok: true, message: `Approved. Paste this reply on Google (${row.google_maps_uri ?? GBP_REVIEWS_URL}): ${reply}` };
  }
  return { ok: true, message: "Approved - I texted you the reply and the link to paste it on Google." };
}
