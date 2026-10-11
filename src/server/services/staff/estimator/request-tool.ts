/**
 * The SMS agent tool `request_estimate`: the customer wants a price for work the price list
 * doesn't cover (damage, a repair, a custom job, "how much to fix this?" + photos).
 *
 *   1. one open estimate per customer (a second ask while one waits → "still waiting");
 *   2. the conversation's recent MMS photos are copied into the private quote-photos bucket
 *      (Twilio's URLs expire) and passed to the model;
 *   3. the vision estimate (vision.ts) → priced with the price list's own math (estimate.ts);
 *   4. too vague → questions for the agent to ask (nothing goes to the owner);
 *   5. otherwise an `ai_estimate` approval: the owner sees the lines, total + HST, confidence
 *      and assumptions, and answers Y / Y $900 / N.
 *
 * The tool result NEVER carries an amount: the agent can't state an AI price before the owner
 * approves (and the reply guard would block one anyway).
 */
import { z } from "zod";

import { insertApproval } from "@/server/services/front-desk/approvals";
import type { AdminClient, InboundMedia } from "@/server/services/front-desk/contracts";
import { readMediaColumn } from "@/server/services/sms-agent/media";
import type { AgentTool, TurnState } from "@/server/services/sms-agent/tools";
import type { EstimatePhoto, EstimateRequestRow } from "@/server/services/staff/estimator/db-types";
import { estimatorDeps, type EstimatorDeps } from "@/server/services/staff/estimator/deps";
import { buildEstimateSummary, cleanLineLabel, priceDraft } from "@/server/services/staff/estimator/estimate";
import { loadEstimatorSettings } from "@/server/services/staff/estimator/settings";
import { daytimeExpiry, displayName } from "@/server/services/staff/estimator/text";
import { runVisionEstimate } from "@/server/services/staff/estimator/vision";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export const AI_ESTIMATE_KIND = "ai_estimate";
export const ESTIMATE_APPROVAL_TTL_MS = 24 * 3_600_000;
/** Photos from this far back in the conversation count. */
const PHOTO_LOOKBACK_MS = 14 * 86_400_000;
const MAX_PHOTOS = 4;
/** A 'collecting' estimate (questions asked) is picked up again within this window. */
const COLLECTING_REUSE_MS = 3 * 86_400_000;

function ownerLabel(state: TurnState): string {
  return state.facts.ownerFirstName ?? "the owner";
}

/** Recent picture messages from this customer, newest first. */
async function recentMedia(admin: AdminClient, state: TurnState, nowMs: number): Promise<InboundMedia[]> {
  const { data } = await (admin as Db)
    .from("message_log")
    .select("id, created_at, media")
    .eq("organization_id", state.facts.organizationId)
    .eq("company_id", state.facts.companyId)
    .eq("contact_id", state.contact.id)
    .eq("direction", "inbound")
    .gte("created_at", new Date(nowMs - PHOTO_LOOKBACK_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(30);
  const out: InboundMedia[] = [];
  for (const row of (data ?? []) as Array<{ media: unknown }>) {
    for (const m of readMediaColumn(row.media)) {
      if (out.length >= MAX_PHOTOS) return out;
      out.push(m);
    }
  }
  return out;
}

function extFor(type: string): string {
  return type === "image/png" ? "png" : type === "image/gif" ? "gif" : type === "image/webp" ? "webp" : "jpg";
}

/** An 'estimating' row older than this was left by a crashed turn (the vision step is <=30 s). */
export const STALE_ESTIMATING_MS = 5 * 60_000;

type Claim =
  | { row: EstimateRequestRow }
  | { waiting: true; job: string }
  | { busyWithOther: true; job: string };

/** Mark a stuck estimate failed (only if it's still in the state we saw). */
async function failStuck(db: Db, row: EstimateRequestRow, why: string): Promise<void> {
  await db.from("estimate_requests").update({ status: "failed", error: why }).eq("id", row.id).eq("company_id", row.company_id).eq("status", row.status);
}

function jobOf(row: EstimateRequestRow): string {
  const title = row.estimate && "title" in row.estimate ? row.estimate.title : null;
  return title || row.description.slice(0, 80);
}

/**
 * Find the open (or reusable 'collecting') estimate, or create one in 'estimating'.
 *
 * Stuck rows don't block the customer forever: 'estimating' older than 5 minutes (a crash
 * mid-estimate) and 'awaiting_owner' whose approval is no longer pending (decided/expired, but
 * the executor never finished) are marked failed and ignored.
 *
 * A 'collecting' row (we asked questions) is reused only when the agent says this call answers
 * those questions (`answersToQuestions`); otherwise this is a new job and the old row is closed.
 * While an estimate is live, a call for the same job (`sameJob`) is "still waiting"; a different
 * job is refused so the agent asks the owner instead of promising a quote that isn't coming.
 */
async function claimEstimate(
  admin: AdminClient,
  state: TurnState,
  description: string,
  flags: { answersToQuestions: boolean; sameJob: boolean },
  nowMs: number,
): Promise<Claim> {
  const db = admin as Db;
  const scope = { organization_id: state.facts.organizationId, company_id: state.facts.companyId, contact_id: state.contact.id };
  const { data: existing } = await db
    .from("estimate_requests")
    .select("*")
    .eq("organization_id", scope.organization_id)
    .eq("company_id", scope.company_id)
    .eq("contact_id", scope.contact_id)
    .in("status", ["collecting", "estimating", "awaiting_owner"])
    .order("created_at", { ascending: false })
    .limit(5);
  const rows: EstimateRequestRow[] = [];
  for (const r of (existing ?? []) as EstimateRequestRow[]) {
    if (r.status === "estimating" && nowMs - Date.parse(r.updated_at ?? r.created_at) > STALE_ESTIMATING_MS) {
      await failStuck(db, r, "estimate never finished (stale)");
      continue;
    }
    if (r.status === "awaiting_owner") {
      let pending = false;
      if (r.approval_id) {
        const { data: a } = await db.from("owner_approvals").select("status").eq("company_id", scope.company_id).eq("id", r.approval_id).maybeSingle();
        pending = (a as { status: string } | null)?.status === "pending";
      }
      if (!pending) {
        await failStuck(db, r, "approval no longer pending (stale)");
        continue;
      }
    }
    rows.push(r);
  }
  const live = rows.find((r) => r.status === "estimating" || r.status === "awaiting_owner");
  if (live) return flags.sameJob || flags.answersToQuestions ? { waiting: true, job: jobOf(live) } : { busyWithOther: true, job: jobOf(live) };

  const collecting = rows.find((r) => r.status === "collecting" && nowMs - Date.parse(r.created_at) < COLLECTING_REUSE_MS);
  if (collecting && flags.answersToQuestions) {
    // The customer answered our questions: one request, the details added together.
    const merged = `${collecting.description} / ${description}`.slice(-2000);
    const { data: claimed } = await db
      .from("estimate_requests")
      .update({ status: "estimating", description: merged, error: null, updated_at: new Date(nowMs).toISOString() })
      .eq("id", collecting.id)
      .eq("company_id", scope.company_id)
      .eq("status", "collecting")
      .select("*");
    const row = ((claimed ?? []) as EstimateRequestRow[])[0];
    return row ? { row } : { waiting: true, job: jobOf(collecting) };
  }
  if (collecting) await failStuck(db, collecting, "replaced by a new request");

  const { data: inserted, error } = await db
    .from("estimate_requests")
    .insert({
      ...scope,
      conversation_id: state.conversation.id,
      description: description.slice(0, 2000),
      photos: [],
      status: "estimating",
      created_at: new Date(nowMs).toISOString(),
    })
    .select("*")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") return { waiting: true, job: description.slice(0, 80) };
    throw error;
  }
  return { row: inserted as EstimateRequestRow };
}

async function setEstimate(admin: AdminClient, row: EstimateRequestRow, patch: Record<string, unknown>): Promise<void> {
  const { error } = await (admin as Db).from("estimate_requests").update(patch).eq("id", row.id).eq("company_id", row.company_id);
  if (error) throw error;
}

/** Copy photos to storage; returns what was stored (a failed upload is skipped, logged). */
async function storePhotos(deps: EstimatorDeps, admin: AdminClient, row: EstimateRequestRow, images: Awaited<ReturnType<EstimatorDeps["fetchImages"]>>): Promise<EstimatePhoto[]> {
  const stored: EstimatePhoto[] = [];
  for (const [i, image] of images.entries()) {
    const path = `${row.organization_id}/${row.company_id}/${row.id}/${i + 1}.${extFor(image.mediaType)}`;
    try {
      await deps.storePhoto(admin, path, image);
      stored.push({ storage_path: path, content_type: image.mediaType });
    } catch (err) {
      console.error("[estimator] photo upload failed:", err instanceof Error ? err.message : err);
    }
  }
  return stored;
}

export interface RequestEstimateInput {
  description: string;
  details?: string;
  answers_to_questions?: boolean;
  same_job?: boolean;
}

export const requestEstimateTool: AgentTool<RequestEstimateInput> = {
  name: "request_estimate",
  description:
    "Get a price for work the price list doesn't cover (damage, a repair, a custom job, or the customer sent photos and asks how much). The owner's AI estimator looks at the details and photos, and the owner OKs the price before the customer gets a quote. Returns questions to ask when it needs more. Never say a price yourself.",
  inputSchema: {
    type: "object",
    properties: {
      description: { type: "string", description: "What the customer wants priced, in plain words, with every detail they gave (what, where, size, materials, access, timing)." },
      details: { type: "string", description: "Anything else useful: the address or town, measurements, when they want it done." },
      answers_to_questions: { type: "boolean", description: "true ONLY when this call carries the customer's answers to the questions request_estimate asked for the SAME job. Then repeat the job in description too." },
      same_job: { type: "boolean", description: "true when the customer is asking again about the job already being estimated (not a new job)." },
    },
    required: ["description"],
    additionalProperties: false,
  },
  parse: z.object({
    description: z.string().trim().min(3).max(1000),
    details: z.string().trim().max(600).optional(),
    answers_to_questions: z.boolean().optional(),
    same_job: z.boolean().optional(),
  }),
  async run(state, input) {
    const deps = estimatorDeps();
    const admin = state.admin;
    const settings = await loadEstimatorSettings(admin, state.facts.companyId);
    if (!settings?.enabled) {
      return { ok: false, error: "Estimates aren't switched on for this business. Ask the owner instead (request_owner_approval kind custom_price)." };
    }
    const now = state.approvalDeps.now();
    const nowMs = now.getTime();
    const claim = await claimEstimate(admin, state, input.description, { answersToQuestions: input.answers_to_questions === true, sameJob: input.same_job === true }, nowMs);
    if ("busyWithOther" in claim) {
      return {
        ok: false,
        estimate_in_progress_for: claim.job,
        error: `${ownerLabel(state)} is still looking at this customer's estimate for "${claim.job}", so a second job can't be estimated yet. For this new job use request_owner_approval (kind custom_price) or hand_off_to_owner - don't promise a quote for it and don't give a price. If they're asking about the same job, call again with same_job: true.`,
      };
    }
    if ("waiting" in claim) {
      return {
        ok: true,
        already_waiting: true,
        job: claim.job,
        tell_customer: `${ownerLabel(state)} is already looking at their estimate - say you'll text the quote as soon as it's ready. Don't give a price.`,
      };
    }
    const row = claim.row;

    try {
      const media = await recentMedia(admin, state, nowMs);
      const images = media.length ? await deps.fetchImages(media) : [];
      const photos = images.length ? await storePhotos(deps, admin, row, images) : [];
      const model = deps.model();
      const vision = await runVisionEstimate(deps.modelClient(), model, state.facts, { description: row.description, details: input.details ?? null, images });
      if (vision.usage) {
        await deps.recordUsage({ organizationId: row.organization_id, companyId: row.company_id, model: vision.usage.model, responseId: vision.usage.responseId, usage: vision.usage.usage });
      }
      if (!vision.draft) throw new Error("The estimate came back unreadable.");

      const fallbackTitle = cleanLineLabel(input.description, state.facts.businessName)?.slice(0, 60) ?? "Estimated work";
      const priced = await priceDraft(deps, state.facts, vision.draft, fallbackTitle);
      if (priced.ok === false) {
        await setEstimate(admin, row, { status: "collecting", photos, estimate: { questions: priced.questions } });
        return {
          ok: true,
          need_more_info: true,
          ask_customer: priced.questions,
          note: "Ask these (one or two at a time), then call request_estimate again with answers_to_questions: true and everything they told you. Don't give a price or a range.",
        };
      }

      const estimate = { ...priced.estimate, model };
      const summary = buildEstimateSummary({
        customerName: displayName(state.contact),
        customerPhone: state.contact.phone,
        description: row.description,
        photoCount: photos.length || images.length,
        estimate,
      });
      const approval = await insertApproval(admin, {
        organizationId: row.organization_id,
        companyId: row.company_id,
        contactId: row.contact_id,
        conversationId: state.conversation.id,
        kind: AI_ESTIMATE_KIND,
        summary,
        payload: {
          estimateId: row.id,
          customerName: displayName(state.contact),
          title: estimate.title,
          subtotalCents: estimate.subtotalCents,
          totalCents: estimate.totalCents,
          confidence: estimate.confidence,
        },
        requestedBy: "estimator",
        createdAt: now,
        expiresAt: daytimeExpiry(now, ESTIMATE_APPROVAL_TTL_MS, state.facts.timeZone),
      });
      // Link the estimate to its approval BEFORE the owner can be asked; if that fails, withdraw
      // the approval so a "Y" can never land on an estimate that doesn't point at it.
      try {
        await setEstimate(admin, row, { status: "awaiting_owner", photos, estimate, approval_id: approval.id });
      } catch (err) {
        await (admin as Db)
          .from("owner_approvals")
          .update({ status: "superseded", result: { ok: false, message: "Withdrawn: the estimate couldn't be saved." } })
          .eq("id", approval.id)
          .eq("company_id", row.company_id)
          .eq("status", "pending");
        throw err;
      }
      try {
        await state.approvalDeps.notify(admin, approval.id);
      } catch (err) {
        console.error("[estimator] notify failed:", err instanceof Error ? err.message : err);
      }
      state.effects.approvals.push({ id: approval.id, shortCode: approval.short_code ?? 0, kind: AI_ESTIMATE_KIND });
      state.effects.collected.approval_ids = [approval.id];
      state.effects.collected.estimate_ids = [row.id];
      state.effects.collected.job = estimate.title;
      return {
        ok: true,
        estimate_requested: true,
        tell_customer: `Tell them ${ownerLabel(state)} will look over the details${photos.length || images.length ? " and photos" : ""} and you'll text them the quote as soon as it's ready. Don't give any price, range or ballpark.`,
        questions_to_confirm: estimate.questions.length ? estimate.questions : undefined,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error("[estimator] request_estimate failed:", reason);
      await setEstimate(admin, row, { status: "failed", error: reason.slice(0, 500) }).catch(() => undefined);
      return {
        ok: false,
        needs_owner: true,
        error: "The estimate didn't work. Ask the owner instead (request_owner_approval kind custom_price) - don't guess a price.",
      };
    }
  },
};
