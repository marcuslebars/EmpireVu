// Jobber sync job queue: enqueue (idempotent on lead_id), claim (RPC), process
// (token → find-or-create client → quote), backoff retries, and a reconcile sweep.
// Exhausted retries land in manual_review, surfaced via raw_leads.needs_attention
// (owner amendment — never a silent status).
import type { createSupabaseAdminClient } from "@/server/supabase/admin";
import { getJobberConfig, type JobberSyncJobRow, type JobberSyncPayload } from "./config";
import { createQuote, findOrCreateClient, JobberRateLimitError } from "./client";
import { ensureAccessToken } from "./oauth";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
// jobber_* + raw_leads writes via the service-role client (jobber_* not yet in database.types.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tbl = (admin: AdminClient, name: string): any => (admin as any).from(name);
const nowIso = (): string => new Date().toISOString();
const isDupKey = (e: unknown): boolean =>
  Boolean(e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "23505");
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export interface EnqueueJobberSyncInput {
  organizationId: string;
  companyId: string | null;
  leadId: string;
  contactId?: string | null;
  payload: JobberSyncPayload;
}

/** Enqueue a sync job (idempotent on lead_id). Best-effort — never throws to the
 *  caller; the durable raw_leads row + the reconcile sweep are the safety net. */
export async function enqueueJobberSyncJob(admin: AdminClient, input: EnqueueJobberSyncInput): Promise<void> {
  try {
    const { error } = await tbl(admin, "jobber_sync_jobs").insert({
      organization_id: input.organizationId,
      company_id: input.companyId,
      lead_id: input.leadId,
      contact_id: input.contactId ?? null,
      payload: input.payload,
      status: "pending",
      available_at: nowIso(),
    });
    if (error && !isDupKey(error)) throw error;
  } catch (err) {
    console.error("[jobber] enqueue failed (lead is safe in raw_leads; reconcile will retry):", err);
  }
}

export interface ClaimOptions {
  workerId: string;
  limit?: number;
  staleAfterSeconds?: number;
}

export async function claimJobberSyncJobs(admin: AdminClient, options: ClaimOptions): Promise<JobberSyncJobRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any).rpc("claim_jobber_sync_jobs", {
    p_worker_id: options.workerId,
    p_limit: options.limit ?? 5,
    p_stale_after_seconds: options.staleAfterSeconds ?? 900,
  });
  if (error) throw error;
  return (data ?? []) as JobberSyncJobRow[];
}

async function completeJob(
  admin: AdminClient,
  job: JobberSyncJobRow,
  ids: { clientId: string; quoteId: string | null },
): Promise<void> {
  await tbl(admin, "jobber_sync_jobs")
    .update({
      status: "completed",
      completed_at: nowIso(),
      locked_at: null,
      locked_by: null,
      last_error: null,
      jobber_client_id: ids.clientId,
      jobber_quote_id: ids.quoteId,
    })
    .eq("id", job.id);
}

/** Fail with exponential backoff, or route to manual_review (surfaced) once exhausted. */
async function failJob(admin: AdminClient, job: JobberSyncJobRow, reason: string, retryAfterMs?: number): Promise<void> {
  if (job.attempt_count >= job.max_attempts) {
    await tbl(admin, "jobber_sync_jobs")
      .update({ status: "manual_review", completed_at: nowIso(), locked_at: null, locked_by: null, last_error: reason })
      .eq("id", job.id);
    await surfaceManualReview(admin, job, reason);
    return;
  }
  const backoffMs = retryAfterMs ?? Math.min(1000 * 2 ** job.attempt_count, 5 * 60 * 1000);
  await tbl(admin, "jobber_sync_jobs")
    .update({
      status: "pending",
      available_at: new Date(Date.now() + backoffMs).toISOString(),
      locked_at: null,
      locked_by: null,
      last_error: reason,
    })
    .eq("id", job.id);
}

/** manual_review is never silent (owner amendment): flag the raw lead's
 *  needs_attention (surfaces in the existing needs-attention view) + log loudly. */
async function surfaceManualReview(admin: AdminClient, job: JobberSyncJobRow, reason: string): Promise<void> {
  console.error(`[jobber] MANUAL REVIEW — lead ${job.lead_id} exhausted retries: ${reason}`);
  try {
    await tbl(admin, "raw_leads").update({ needs_attention: true }).eq("lead_id", job.lead_id);
  } catch (err) {
    console.error("[jobber] failed to flag raw_leads.needs_attention for manual-review job:", err);
  }
}

function quoteTitle(payload: JobberSyncPayload): string {
  return payload.locality ? `Winter storage — ${payload.locality}` : "Winter storage quote";
}

export async function processJobberSyncJob(admin: AdminClient, job: JobberSyncJobRow): Promise<void> {
  const cfg = getJobberConfig();
  if (!cfg.enabled) {
    // Flag off — park the job without burning a retry (the claim already incremented).
    await tbl(admin, "jobber_sync_jobs")
      .update({
        status: "pending",
        available_at: new Date(Date.now() + 60_000).toISOString(),
        attempt_count: Math.max(job.attempt_count - 1, 0),
        locked_at: null,
        locked_by: null,
      })
      .eq("id", job.id);
    return;
  }
  try {
    const accessToken = await ensureAccessToken(admin, job.organization_id, cfg);
    const clientId = await findOrCreateClient(accessToken, job.payload.contact, cfg);
    const lineItems = job.payload.lineItems ?? [];
    // Calculator leads carry engine line items → a full quote. Lead-capture leads
    // (winter-storage-quote, no line items) get the client only; the team quotes.
    const quoteId = lineItems.length
      ? await createQuote(accessToken, clientId, lineItems, { title: quoteTitle(job.payload) }, cfg)
      : null;
    await completeJob(admin, job, { clientId, quoteId });
    // TODO(confirm at connect): trigger the client-hub "quote ready" send (Jobber's own
    // email/text vs our email with the approval link) — see docs/jobber-integration.md.
  } catch (err) {
    if (err instanceof JobberRateLimitError) {
      await failJob(admin, job, "Jobber rate limit (429)", err.retryAfterMs ?? 60_000);
      return;
    }
    await failJob(admin, job, err instanceof Error ? err.message : "Jobber sync failed.");
  }
}

interface RawLeadRow {
  lead_id: string;
  organization_id: string | null;
  company_id: string | null;
  contact_id: string | null;
  raw_payload: unknown;
  form_type: string | null;
}

/** Build a sync payload from a stored raw_leads.raw_payload (the canonical envelope). */
export function payloadFromRawLead(raw: unknown): JobberSyncPayload {
  const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const contact = (e.contact && typeof e.contact === "object" ? e.contact : {}) as Record<string, unknown>;
  const meta = (e.meta && typeof e.meta === "object" ? e.meta : {}) as Record<string, unknown>;
  return {
    formType: String(e.formType ?? ""),
    source: String(e.source ?? ""),
    sourceSite: String(e.sourceSite ?? ""),
    contact: { name: str(contact.name), email: str(contact.email), phone: str(contact.phone) },
    message: str(e.message),
    lineItems: Array.isArray(e.lineItems) ? (e.lineItems as JobberSyncPayload["lineItems"]) : undefined,
    asset: e.asset && typeof e.asset === "object" ? (e.asset as JobberSyncPayload["asset"]) : undefined,
    locality: str(meta.locality),
  };
}

/**
 * Reconcile sweep (owner amendment): find recent A1 Marine Storage quote /
 * winter-storage-quote leads with no jobber_sync_jobs row and enqueue them — closes
 * the best-effort enqueue gap. Returns how many were enqueued.
 */
export async function reconcileJobberSyncJobs(admin: AdminClient, lookbackHours = 72): Promise<number> {
  const since = new Date(Date.now() - lookbackHours * 3_600_000).toISOString();
  const { data: leads, error } = await tbl(admin, "raw_leads")
    .select("lead_id, organization_id, company_id, contact_id, raw_payload, form_type")
    .in("form_type", ["winter-storage-quote", "quote"])
    .eq("source_site", "a1marinestorage")
    .eq("schema_valid", true)
    .gte("received_at", since)
    .limit(500);
  if (error) throw error;

  let enqueued = 0;
  for (const lead of (leads ?? []) as RawLeadRow[]) {
    if (!lead.organization_id) continue;
    const { data: existing } = await tbl(admin, "jobber_sync_jobs")
      .select("id")
      .eq("lead_id", lead.lead_id)
      .maybeSingle();
    if (existing) continue;
    await enqueueJobberSyncJob(admin, {
      organizationId: lead.organization_id,
      companyId: lead.company_id,
      leadId: lead.lead_id,
      contactId: lead.contact_id,
      payload: payloadFromRawLead(lead.raw_payload),
    });
    enqueued++;
  }
  return enqueued;
}
