import type { Json } from "@/server/db/database.types";
import { getAttributionSummary, type PeriodRange } from "@/server/services/attribution";
import type { TenantServiceContext } from "@/server/services/shared";

/**
 * Monthly scorecard metrics. Two halves:
 *
 *  - `fetchScorecardInputs` — tenant-scoped reads (every query filters organization_id AND
 *    company_id) that return plain rows for one company and one `[from, to)` period.
 *  - `computeScorecardMetrics` — PURE: rows in, numbers out. Golden-tested with fixture rows,
 *    so the definitions below are pinned by tests rather than by SQL.
 *
 * Metric definitions (also in docs/monthly-scorecard.md):
 *  - leads: contacts CREATED in the period, classified by `classifyLeadSource`.
 *  - missedCalls.caught: `call.missed` activity events in the period (Retell classifies:
 *    voicemail, < 5 s, or unsuccessful). textedBack: of those with a known contact, how many
 *    got a SENT outbound SMS within 60 minutes after the miss.
 *  - messages: outbound message_log rows with status 'sent' to a CONTACT (owner alerts and
 *    this scorecard itself are excluded) in the period; `automated` = sent by a workflow run.
 *  - automationsRun: workflow runs created in the period that completed.
 *  - firstResponse: per new lead, created_at → first sent outbound message or outbound call
 *    to that contact (looked up to 7 days past the period end); median over leads with one.
 *  - quotes: sent = sent_at in period; approved = approved_at in period (amount =
 *    approved_total_cents, else total_cents); deposits = deposit_paid_at in period (amount =
 *    approved_deposit_cents, else deposit_cents). Amounts are Stripe-backed quote data.
 *  - jobsBooked: bookings created in the period, not cancelled. jobsCompleted: bookings
 *    scheduled in the period with status 'completed'.
 *  - reviewsRequested: completed runs (completed_at in period) of the company's
 *    `review-request` workflow, plus built-in review requests sent in the period
 *    (docs/review-requests.md).
 *  - receptionist: inbound retell_calls created in the period; minutes = metered
 *    `voice_minutes` usage for the company in the period.
 *  - attributedRevenue: `getAttributionSummary` (Task 14) over the same period.
 */

// ── Lead source classification (pure) ───────────────────────────────────────────

export const LEAD_SOURCES = ["web_form", "phone_ai", "missed_call", "text", "referral", "other"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  web_form: "Web form",
  phone_ai: "Phone (AI receptionist)",
  missed_call: "Missed-call catcher",
  text: "Text message",
  referral: "Referral",
  other: "Other / manual",
};

const WEB_FORM_TYPES = new Set(["quote", "contact", "booking", "winter-storage-quote"]);
const PHONE_SOURCES = /retell|telnyx|voice|phone/i;
/** A missed call within this window of the contact's creation means the call created the lead. */
const MISSED_CALL_LEAD_WINDOW_BEFORE_MS = 10 * 60_000;
const MISSED_CALL_LEAD_WINDOW_AFTER_MS = 30 * 60_000;
const TEXT_BACK_WINDOW_MS = 60 * 60_000;
const FIRST_RESPONSE_LOOKAHEAD_MS = 7 * 86_400_000;

export interface LeadSourceSignals {
  /** contacts.metadata (lead intake writes source / sourceSite / formType / meta here). */
  metadata: Json | null;
  consentSource: string | null;
  /** The raw_leads row linked to this contact, if any. */
  rawLead: { source: string | null; sourceSite: string | null; formType: string | null } | null;
  /** The contact's booking came in through the public booking page. */
  viaPublicBooking: boolean;
  /** A `call.missed` event for this contact landed right around its creation. */
  missedCallAtCreation: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Deterministic source bucket for a new lead. Precedence: missed-call catcher → referral tag
 * → phone/AI → web form → inbound text → other. A missed call wins over "phone" because the
 * catcher is what saved that lead.
 */
export function classifyLeadSource(signals: LeadSourceSignals): LeadSource {
  if (signals.missedCallAtCreation) return "missed_call";

  const meta = asRecord(signals.metadata);
  const inner = asRecord(meta.meta);
  const utm = asRecord(inner.utm);
  const source = str(meta.source) ?? signals.rawLead?.source ?? null;
  const formType = str(meta.formType) ?? signals.rawLead?.formType ?? null;
  const tags = [source, str(meta.sourceSite), signals.rawLead?.sourceSite ?? null, str(utm.utm_source), str(utm.utm_medium), str(meta.referral)]
    .filter((tag): tag is string => Boolean(tag))
    .join(" ")
    .toLowerCase();

  if (tags.includes("referral") || tags.includes("referred")) return "referral";
  if (formType === "phone-lead" || (source !== null && PHONE_SOURCES.test(source))) return "phone_ai";
  if ((formType !== null && WEB_FORM_TYPES.has(formType)) || signals.rawLead !== null || signals.viaPublicBooking) {
    return "web_form";
  }
  if (signals.consentSource === "inbound_sms") return "text";
  return "other";
}

// ── Raw inputs (what fetchScorecardInputs returns) ──────────────────────────────

export interface ScorecardInputs {
  newContacts: Array<{ id: string; createdAt: string; metadata: Json | null; consentSource: string | null }>;
  rawLeads: Array<{ contactId: string; source: string | null; sourceSite: string | null; formType: string | null }>;
  publicBookingContactIds: string[];
  /** `call.missed` events from 10 min before the period through its end. */
  missedCalls: Array<{ contactId: string | null; at: string }>;
  /** Sent outbound messages to contacts, from the period start through end + 7 days. */
  outboundMessages: Array<{ contactId: string; channel: string; at: string; workflowRunId: string | null }>;
  /** Outbound calls to contacts, from the period start through end + 7 days. */
  outboundCalls: Array<{ contactId: string; at: string }>;
  workflows: Array<{ id: string; slug: string; status: string }>;
  workflowRuns: Array<{ workflowId: string; status: string; createdAt: string; completedAt: string | null }>;
  quotes: Array<{
    sentAt: string | null;
    approvedAt: string | null;
    depositPaidAt: string | null;
    approvedTotalCents: number | null;
    totalCents: number;
    approvedDepositCents: number | null;
    depositCents: number;
    currency: string | null;
  }>;
  bookings: Array<{ createdAt: string; scheduledFor: string; status: string }>;
  inboundCalls: Array<{ at: string }>;
  voiceMinutes: number;
  attribution: { approvedCents: number; paidCents: number } | null;
  /** sent_at of built-in review requests sent in the period. */
  reviewRequestsSent?: string[];
  /** The company has built-in review requests switched on. */
  reviewRequestsOn?: boolean;
}

export function emptyScorecardInputs(): ScorecardInputs {
  return {
    newContacts: [],
    rawLeads: [],
    publicBookingContactIds: [],
    missedCalls: [],
    outboundMessages: [],
    outboundCalls: [],
    workflows: [],
    workflowRuns: [],
    quotes: [],
    bookings: [],
    inboundCalls: [],
    voiceMinutes: 0,
    attribution: null,
    reviewRequestsSent: [],
    reviewRequestsOn: false,
  };
}

// ── Computed metrics ───────────────────────────────────────────────────────────

export interface ScorecardMetrics {
  leads: { total: number; bySource: Record<LeadSource, number> };
  missedCalls: { caught: number; textedBack: number };
  messages: { sent: number; automated: number; sms: number; email: number };
  automationsRun: number;
  firstResponse: { medianSeconds: number | null; responded: number; within5Min: number };
  quotes: {
    sent: number;
    approved: number;
    approvedCents: number;
    depositsCollected: number;
    depositCents: number;
    /** Of the quotes SENT this period, how many have been approved (any time so far). */
    sentThenApproved: number;
    currency: string;
  };
  jobsBooked: number;
  jobsCompleted: number;
  reviewsRequested: number;
  receptionist: { callsHandled: number; minutes: number };
  attributedRevenue: { approvedCents: number; paidCents: number };
  /** Recipe slug → workflow status for the company (drives "what we're tuning next"). */
  recipeStatus: Record<string, string>;
  /** Built-in review requests are switched on (Settings → Reviews). */
  reviewRequestsOn: boolean;
}

const DEFAULT_CURRENCY = "CAD";

function inRange(iso: string | null | undefined, fromMs: number, toMs: number): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms >= fromMs && ms < toMs;
}

/** Median of a non-empty list (mean of the two middle values for an even count). */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function computeScorecardMetrics(inputs: ScorecardInputs, range: PeriodRange): ScorecardMetrics {
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);

  // Leads by source.
  const rawLeadByContact = new Map(inputs.rawLeads.map((lead) => [lead.contactId, lead]));
  const publicBooking = new Set(inputs.publicBookingContactIds);
  const missedByContact = new Map<string, number[]>();
  for (const miss of inputs.missedCalls) {
    if (!miss.contactId) continue;
    const list = missedByContact.get(miss.contactId) ?? [];
    list.push(Date.parse(miss.at));
    missedByContact.set(miss.contactId, list);
  }
  const bySource = Object.fromEntries(LEAD_SOURCES.map((source) => [source, 0])) as Record<LeadSource, number>;
  const newContacts = inputs.newContacts.filter((contact) => inRange(contact.createdAt, fromMs, toMs));
  for (const contact of newContacts) {
    const createdMs = Date.parse(contact.createdAt);
    const missedCallAtCreation = (missedByContact.get(contact.id) ?? []).some(
      (at) => at >= createdMs - MISSED_CALL_LEAD_WINDOW_BEFORE_MS && at <= createdMs + MISSED_CALL_LEAD_WINDOW_AFTER_MS,
    );
    const rawLead = rawLeadByContact.get(contact.id);
    const source = classifyLeadSource({
      metadata: contact.metadata,
      consentSource: contact.consentSource,
      rawLead: rawLead ? { source: rawLead.source, sourceSite: rawLead.sourceSite, formType: rawLead.formType } : null,
      viaPublicBooking: publicBooking.has(contact.id),
      missedCallAtCreation,
    });
    bySource[source] += 1;
  }

  // Outbound touches per contact, sorted, for text-back + first response.
  const smsTimesByContact = new Map<string, number[]>();
  const touchTimesByContact = new Map<string, number[]>();
  const push = (map: Map<string, number[]>, key: string, ms: number) => {
    const list = map.get(key) ?? [];
    list.push(ms);
    map.set(key, list);
  };
  for (const message of inputs.outboundMessages) {
    const ms = Date.parse(message.at);
    if (!Number.isFinite(ms)) continue;
    push(touchTimesByContact, message.contactId, ms);
    if (message.channel === "sms") push(smsTimesByContact, message.contactId, ms);
  }
  for (const call of inputs.outboundCalls) {
    const ms = Date.parse(call.at);
    if (Number.isFinite(ms)) push(touchTimesByContact, call.contactId, ms);
  }

  // Missed calls caught + texted back.
  const missedInPeriod = inputs.missedCalls.filter((miss) => inRange(miss.at, fromMs, toMs));
  const textedBack = missedInPeriod.filter((miss) => {
    if (!miss.contactId) return false;
    const missMs = Date.parse(miss.at);
    return (smsTimesByContact.get(miss.contactId) ?? []).some((ms) => ms >= missMs && ms <= missMs + TEXT_BACK_WINDOW_MS);
  }).length;

  // Messages in period.
  const messagesInPeriod = inputs.outboundMessages.filter((message) => inRange(message.at, fromMs, toMs));

  // First response.
  const responseSeconds: number[] = [];
  for (const contact of newContacts) {
    const createdMs = Date.parse(contact.createdAt);
    const first = (touchTimesByContact.get(contact.id) ?? [])
      .filter((ms) => ms >= createdMs && ms <= createdMs + FIRST_RESPONSE_LOOKAHEAD_MS)
      .sort((a, b) => a - b)[0];
    if (first !== undefined) responseSeconds.push(Math.round((first - createdMs) / 1000));
  }

  // Workflows.
  const recipeStatus: Record<string, string> = {};
  for (const workflow of inputs.workflows) recipeStatus[workflow.slug] = workflow.status;
  const reviewWorkflowIds = new Set(inputs.workflows.filter((w) => w.slug === "review-request").map((w) => w.id));
  const automationsRun = inputs.workflowRuns.filter(
    (run) => run.status === "completed" && inRange(run.createdAt, fromMs, toMs),
  ).length;
  const reviewsRequested =
    inputs.workflowRuns.filter(
      (run) => reviewWorkflowIds.has(run.workflowId) && run.status === "completed" && inRange(run.completedAt, fromMs, toMs),
    ).length + (inputs.reviewRequestsSent ?? []).filter((at) => inRange(at, fromMs, toMs)).length;

  // Quotes.
  const sentQuotes = inputs.quotes.filter((quote) => inRange(quote.sentAt, fromMs, toMs));
  const approvedQuotes = inputs.quotes.filter((quote) => inRange(quote.approvedAt, fromMs, toMs));
  const paidQuotes = inputs.quotes.filter((quote) => inRange(quote.depositPaidAt, fromMs, toMs));
  const currency = (inputs.quotes.find((quote) => quote.currency)?.currency ?? DEFAULT_CURRENCY).toUpperCase();

  return {
    leads: { total: newContacts.length, bySource },
    missedCalls: { caught: missedInPeriod.length, textedBack },
    messages: {
      sent: messagesInPeriod.length,
      automated: messagesInPeriod.filter((message) => message.workflowRunId !== null).length,
      sms: messagesInPeriod.filter((message) => message.channel === "sms").length,
      email: messagesInPeriod.filter((message) => message.channel === "email").length,
    },
    automationsRun,
    firstResponse: {
      medianSeconds: median(responseSeconds),
      responded: responseSeconds.length,
      within5Min: responseSeconds.filter((seconds) => seconds <= 300).length,
    },
    quotes: {
      sent: sentQuotes.length,
      approved: approvedQuotes.length,
      approvedCents: approvedQuotes.reduce((sum, q) => sum + Number(q.approvedTotalCents ?? q.totalCents ?? 0), 0),
      depositsCollected: paidQuotes.length,
      depositCents: paidQuotes.reduce((sum, q) => sum + Number(q.approvedDepositCents ?? q.depositCents ?? 0), 0),
      sentThenApproved: sentQuotes.filter((quote) => quote.approvedAt !== null).length,
      currency,
    },
    jobsBooked: inputs.bookings.filter((b) => b.status !== "cancelled" && inRange(b.createdAt, fromMs, toMs)).length,
    jobsCompleted: inputs.bookings.filter((b) => b.status === "completed" && inRange(b.scheduledFor, fromMs, toMs)).length,
    reviewsRequested,
    receptionist: {
      callsHandled: inputs.inboundCalls.filter((call) => inRange(call.at, fromMs, toMs)).length,
      minutes: Math.round(inputs.voiceMinutes),
    },
    attributedRevenue: {
      approvedCents: inputs.attribution?.approvedCents ?? 0,
      paidCents: inputs.attribution?.paidCents ?? 0,
    },
    recipeStatus,
    reviewRequestsOn: Boolean(inputs.reviewRequestsOn),
  };
}

/** Anything at all happened this month (drives "quiet month" wording + first-month logic). */
export function metricsHaveActivity(metrics: ScorecardMetrics): boolean {
  return (
    metrics.leads.total > 0 ||
    metrics.missedCalls.caught > 0 ||
    metrics.messages.sent > 0 ||
    metrics.quotes.sent > 0 ||
    metrics.quotes.approved > 0 ||
    metrics.quotes.depositsCollected > 0 ||
    metrics.jobsBooked > 0 ||
    metrics.receptionist.callsHandled > 0
  );
}

// ── Tenant-scoped reads ─────────────────────────────────────────────────────────

const PAGE_SIZE = 1000;
const MAX_PAGES = 20; // 20k rows per table per company-month — far beyond a trades business.
const ID_CHUNK = 200;

type PageResult<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

/** Page through a PostgREST query (default max-rows is 1000) until a short page. */
export async function fetchAllPages<T>(page: (from: number, to: number) => PageResult<T>): Promise<T[]> {
  const rows: T[] = [];
  for (let index = 0; index < MAX_PAGES; index += 1) {
    const from = index * PAGE_SIZE;
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
  return out;
}

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Read everything `computeScorecardMetrics` needs for one company and period. Every query is
 * filtered by BOTH organization_id and company_id — under an RLS client that's belt and
 * braces; under the job's service-role client it IS the tenancy boundary.
 */
export async function fetchScorecardInputs(
  context: TenantServiceContext,
  companyId: string,
  range: PeriodRange,
): Promise<ScorecardInputs> {
  const org = context.organizationId;
  const db = context.supabase;
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);
  const missedFrom = new Date(fromMs - MISSED_CALL_LEAD_WINDOW_BEFORE_MS).toISOString();
  const touchesTo = new Date(toMs + FIRST_RESPONSE_LOOKAHEAD_MS).toISOString();
  const runsFrom = new Date(fromMs - 31 * 86_400_000).toISOString(); // a review run may start last month

  const quotesIn = (column: "sent_at" | "approved_at" | "deposit_paid_at") =>
    fetchAllPages((a, b) =>
      db.from("quotes")
        .select("id, sent_at, approved_at, deposit_paid_at, approved_total_cents, total_cents, approved_deposit_cents, deposit_cents, currency")
        .eq("organization_id", org).eq("company_id", companyId)
        .gte(column, range.from).lt(column, range.to)
        .order(column, { ascending: true }).range(a, b),
    );

  const [
    contactRows,
    missedRows,
    messageRows,
    callRows,
    workflowRows,
    runRows,
    sentQuoteRows,
    approvedQuoteRows,
    paidQuoteRows,
    bookingCreatedRows,
    bookingScheduledRows,
    voiceRows,
  ] = await Promise.all([
    fetchAllPages((a, b) =>
      db.from("contacts").select("id, created_at, metadata, consent_source")
        .eq("organization_id", org).eq("company_id", companyId)
        .gte("created_at", range.from).lt("created_at", range.to)
        .order("created_at", { ascending: true }).range(a, b),
    ),
    fetchAllPages((a, b) =>
      db.from("activity_events").select("entity_id, entity_type, occurred_at, metadata_json")
        .eq("organization_id", org).eq("company_id", companyId)
        .eq("event_type", "call.missed")
        .gte("occurred_at", missedFrom).lt("occurred_at", range.to)
        .order("occurred_at", { ascending: true }).range(a, b),
    ),
    fetchAllPages((a, b) =>
      db.from("message_log").select("contact_id, channel, created_at, workflow_run_id")
        .eq("organization_id", org).eq("company_id", companyId)
        .eq("direction", "outbound").eq("status", "sent")
        .not("contact_id", "is", null)
        .gte("created_at", range.from).lt("created_at", touchesTo)
        .order("created_at", { ascending: true }).range(a, b),
    ),
    fetchAllPages((a, b) =>
      db.from("retell_calls").select("contact_id, direction, created_at")
        .eq("organization_id", org).eq("company_id", companyId)
        .gte("created_at", range.from).lt("created_at", touchesTo)
        .order("created_at", { ascending: true }).range(a, b),
    ),
    fetchAllPages((a, b) =>
      db.from("workflows").select("id, slug, status")
        .eq("organization_id", org).eq("company_id", companyId)
        .order("created_at", { ascending: true }).range(a, b),
    ),
    fetchAllPages((a, b) =>
      db.from("workflow_runs").select("workflow_id, status, created_at, completed_at")
        .eq("organization_id", org).eq("company_id", companyId)
        .gte("created_at", runsFrom).lt("created_at", range.to)
        .order("created_at", { ascending: true }).range(a, b),
    ),
    quotesIn("sent_at"),
    quotesIn("approved_at"),
    quotesIn("deposit_paid_at"),
    fetchAllPages((a, b) =>
      db.from("bookings").select("id, created_at, scheduled_for, status")
        .eq("organization_id", org).eq("company_id", companyId)
        .gte("created_at", range.from).lt("created_at", range.to)
        .order("created_at", { ascending: true }).range(a, b),
    ),
    fetchAllPages((a, b) =>
      db.from("bookings").select("id, created_at, scheduled_for, status")
        .eq("organization_id", org).eq("company_id", companyId)
        .eq("status", "completed")
        .gte("scheduled_for", range.from).lt("scheduled_for", range.to)
        .order("scheduled_for", { ascending: true }).range(a, b),
    ),
    fetchAllPages((a, b) =>
      db.from("usage_events").select("quantity")
        .eq("organization_id", org).eq("company_id", companyId)
        .eq("kind", "voice_minutes")
        .gte("occurred_at", range.from).lt("occurred_at", range.to)
        .order("occurred_at", { ascending: true }).range(a, b),
    ),
  ]);

  const contactIds = contactRows.map((row) => row.id);

  // raw_leads + public-booking events for the new contacts only (chunked IN lists).
  const rawLeads: ScorecardInputs["rawLeads"] = [];
  const publicBookingContactIds = new Set<string>();
  for (const ids of chunk(contactIds, ID_CHUNK)) {
    const [{ data: leadRows, error: leadError }, { data: bookingEvents, error: eventError }] = await Promise.all([
      db.from("raw_leads").select("contact_id, source, source_site, form_type")
        .eq("organization_id", org).eq("company_id", companyId)
        .in("contact_id", ids),
      db.from("activity_events").select("related_entity_id, metadata_json")
        .eq("organization_id", org).eq("company_id", companyId)
        .eq("event_type", "booking.created")
        .in("related_entity_id", ids),
    ]);
    if (leadError) throw leadError;
    if (eventError) throw eventError;
    for (const row of leadRows ?? []) {
      if (row.contact_id) {
        rawLeads.push({ contactId: row.contact_id, source: row.source, sourceSite: row.source_site, formType: row.form_type });
      }
    }
    for (const row of bookingEvents ?? []) {
      if (row.related_entity_id && asRecord(row.metadata_json).source === "public_booking") {
        publicBookingContactIds.add(row.related_entity_id);
      }
    }
  }

  // Quotes from the three cohorts, de-duplicated by id.
  const quotesById = new Map<string, (typeof sentQuoteRows)[number]>();
  for (const row of [...sentQuoteRows, ...approvedQuoteRows, ...paidQuoteRows]) quotesById.set(row.id, row);

  const bookingsById = new Map<string, (typeof bookingCreatedRows)[number]>();
  for (const row of [...bookingCreatedRows, ...bookingScheduledRows]) bookingsById.set(row.id, row);

  const attribution = await getAttributionSummary(context, { companyId, from: range.from, to: range.to })
    .then((summary) => ({ approvedCents: summary.approvedCentsTotal, paidCents: summary.paidCentsTotal }))
    .catch((err: unknown) => {
      console.error("[monthly-scorecard] attribution unavailable:", err instanceof Error ? err.message : err);
      return null;
    });

  // Built-in review requests (docs/review-requests.md). Tolerant: a database without the
  // table yet still produces a scorecard.
  const [reviewSentRes, reviewCompanyRes] = await Promise.all([
    db.from("review_requests").select("sent_at")
      .eq("organization_id", org).eq("company_id", companyId)
      .eq("status", "sent")
      .gte("sent_at", range.from).lt("sent_at", range.to)
      .limit(5000),
    db.from("companies").select("review_settings").eq("organization_id", org).eq("id", companyId).maybeSingle(),
  ]);
  if (reviewSentRes.error) console.error("[monthly-scorecard] review requests unavailable:", reviewSentRes.error.message);
  const reviewSettingsRaw = reviewCompanyRes.error ? null : asRecord((reviewCompanyRes.data as { review_settings?: unknown } | null)?.review_settings);

  return {
    reviewRequestsSent: reviewSentRes.error ? [] : (reviewSentRes.data ?? []).map((row: { sent_at: string | null }) => row.sent_at).filter((v: string | null): v is string => !!v),
    reviewRequestsOn: reviewSettingsRaw?.enabled === true,
    newContacts: contactRows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      metadata: row.metadata,
      consentSource: row.consent_source,
    })),
    rawLeads,
    publicBookingContactIds: [...publicBookingContactIds],
    missedCalls: missedRows.map((row) => {
      const meta = asRecord(row.metadata_json);
      const contactId = str(meta.contactId) ?? (row.entity_type === "contact" ? row.entity_id : null);
      return { contactId, at: row.occurred_at };
    }),
    outboundMessages: messageRows
      .filter((row) => row.contact_id !== null)
      .map((row) => ({
        contactId: row.contact_id ?? "",
        channel: row.channel,
        at: row.created_at,
        workflowRunId: row.workflow_run_id,
      })),
    outboundCalls: callRows
      .filter((row) => row.direction === "outbound" && row.contact_id)
      .map((row) => ({ contactId: row.contact_id ?? "", at: row.created_at })),
    workflows: workflowRows.map((row) => ({ id: row.id, slug: row.slug, status: row.status })),
    workflowRuns: runRows.map((row) => ({
      workflowId: row.workflow_id,
      status: row.status,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    })),
    quotes: [...quotesById.values()].map((row) => ({
      sentAt: row.sent_at,
      approvedAt: row.approved_at,
      depositPaidAt: row.deposit_paid_at,
      approvedTotalCents: row.approved_total_cents,
      totalCents: toNumber(row.total_cents),
      approvedDepositCents: row.approved_deposit_cents,
      depositCents: toNumber(row.deposit_cents),
      currency: row.currency,
    })),
    bookings: [...bookingsById.values()].map((row) => ({
      createdAt: row.created_at,
      scheduledFor: row.scheduled_for,
      status: row.status,
    })),
    inboundCalls: callRows
      .filter((row) => row.direction !== "outbound" && inRange(row.created_at, fromMs, toMs))
      .map((row) => ({ at: row.created_at })),
    voiceMinutes: voiceRows.reduce((sum, row) => sum + toNumber(row.quantity), 0),
    attribution,
  };
}
