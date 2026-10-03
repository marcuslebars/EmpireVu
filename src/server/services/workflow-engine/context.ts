import type { Json, Tables } from "@/server/db/database.types";
import type { TenantServiceContext } from "@/server/services/shared";
import type { MessageTemplateData } from "@/server/services/workflow-engine/interpolate";
import type { WorkflowEventContext } from "@/server/services/workflow-engine/types";
import {
  DEFAULT_BOOKING_POLICY,
  localDate,
  parseBookingPolicy,
  spokenWindowLabel,
} from "@/server/services/booking-windows";
import { quotePublicBaseUrlFor } from "@/server/services/quotes/config";
import { loadCallForTemplate, ownerClockTime, prettyPhone } from "@/server/services/retell/call-summary";
import { boatFromSnapshot, DEFAULT_AGENT_NAME, formatDollars } from "@/server/services/retell/caller-lookup";

type TraceEntityRow =
  | Tables<"activity_events">
  | Tables<"bookings">
  | Tables<"comments">
  | Tables<"companies">
  | Tables<"contacts">
  | Tables<"tasks">
  | Tables<"workflow_runs">
  | Tables<"workflows">;

function asJsonRecord(value: Json | null | undefined): Record<string, Json> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
}

async function getTraceEntityRow(
  context: TenantServiceContext,
  entityType: string | null,
  entityId: string | null,
): Promise<TraceEntityRow | null> {
  if (!entityType || !entityId) {
    return null;
  }

  switch (entityType) {
    case "company": {
      const { data, error } = await context.supabase.from("companies").select("*")
        .eq("organization_id", context.organizationId).eq("id", entityId).maybeSingle();
      if (error) throw error;
      return data;
    }
    case "contact": {
      const { data, error } = await context.supabase.from("contacts").select("*")
        .eq("organization_id", context.organizationId).eq("id", entityId).maybeSingle();
      if (error) throw error;
      return data;
    }
    case "booking": {
      const { data, error } = await context.supabase.from("bookings").select("*")
        .eq("organization_id", context.organizationId).eq("id", entityId).maybeSingle();
      if (error) throw error;
      return data;
    }
    case "task": {
      const { data, error } = await context.supabase.from("tasks").select("*")
        .eq("organization_id", context.organizationId).eq("id", entityId).maybeSingle();
      if (error) throw error;
      return data;
    }
    case "workflow": {
      const { data, error } = await context.supabase.from("workflows").select("*")
        .eq("organization_id", context.organizationId).eq("id", entityId).maybeSingle();
      if (error) throw error;
      return data;
    }
    case "workflow_run": {
      const { data, error } = await context.supabase.from("workflow_runs").select("*")
        .eq("organization_id", context.organizationId).eq("id", entityId).maybeSingle();
      if (error) throw error;
      return data;
    }
    case "activity_event": {
      const { data, error } = await context.supabase.from("activity_events").select("*")
        .eq("organization_id", context.organizationId).eq("id", entityId).maybeSingle();
      if (error) throw error;
      return data;
    }
    default:
      return null;
  }
}

function readAssignedUserId(entityRow: TraceEntityRow | null, metadata: Record<string, Json>): Json {
  if (entityRow && "assigned_to_profile_id" in entityRow) {
    return entityRow.assigned_to_profile_id;
  }

  if (entityRow && "owner_profile_id" in entityRow) {
    return entityRow.owner_profile_id;
  }

  return metadata.assigned_user_id ?? metadata.assignedToProfileId ?? metadata.owner_profile_id ?? null;
}

function readPriority(entityRow: TraceEntityRow | null, metadata: Record<string, Json>): Json {
  if (entityRow && "priority" in entityRow) {
    return entityRow.priority;
  }

  return metadata.priority ?? null;
}

function readStage(entityRow: TraceEntityRow | null, metadata: Record<string, Json>): Json {
  if (entityRow && "stage" in entityRow) {
    return entityRow.stage;
  }

  return metadata.stage ?? metadata.stage_changed_to ?? metadata.to_stage ?? metadata.toStage ?? null;
}

function readValueCents(entityRow: TraceEntityRow | null, metadata: Record<string, Json>): Json {
  if (entityRow && "metadata" in entityRow) {
    const entityMetadata = asJsonRecord(entityRow.metadata);
    return entityMetadata.value_cents ?? entityMetadata.valueCents ?? metadata.value_cents ?? metadata.valueCents ?? null;
  }

  return metadata.value_cents ?? metadata.valueCents ?? null;
}

function readCommonFields(
  activityEvent: Tables<"activity_events">,
  entityRow: TraceEntityRow | null,
  relatedEntityRow: TraceEntityRow | null,
): Record<string, Json> {
  const metadata = asJsonRecord(activityEvent.metadata_json);

  return {
    actor_user_id: activityEvent.actor_user_id,
    assigned_user_id: readAssignedUserId(entityRow, metadata),
    booking_id:
      (entityRow && "scheduled_for" in entityRow ? entityRow.id : null) ??
      metadata.booking_id ??
      metadata.bookingId ??
      (relatedEntityRow && "scheduled_for" in relatedEntityRow ? relatedEntityRow.id : null),
    company_id: activityEvent.company_id,
    contact_id:
      (entityRow && "first_name" in entityRow ? entityRow.id : null) ??
      (entityRow && "contact_id" in entityRow ? entityRow.contact_id : null) ??
      metadata.contact_id ??
      metadata.contactId ??
      (relatedEntityRow && "first_name" in relatedEntityRow ? relatedEntityRow.id : null),
    entity_id: activityEvent.entity_id,
    entity_type: activityEvent.entity_type,
    event_type: activityEvent.event_type,
    previous_stage: metadata.previous_stage ?? metadata.previousStage ?? metadata.from_stage ?? metadata.fromStage ?? null,
    priority: readPriority(entityRow, metadata),
    related_entity_id: activityEvent.related_entity_id,
    related_entity_type: activityEvent.related_entity_type,
    stage: readStage(entityRow, metadata),
    stage_changed_to: metadata.stage_changed_to ?? metadata.to_stage ?? metadata.toStage ?? metadata.stage ?? null,
    status:
      (entityRow && "status" in entityRow ? entityRow.status : null) ?? metadata.status ?? null,
    task_id:
      (entityRow && "priority" in entityRow ? entityRow.id : null) ??
      metadata.task_id ??
      metadata.taskId ??
      (relatedEntityRow && "priority" in relatedEntityRow ? relatedEntityRow.id : null),
    title: (entityRow && "title" in entityRow ? entityRow.title : null) ?? metadata.title ?? null,
    trigger_event_type: activityEvent.event_type,
    value_cents: readValueCents(entityRow, metadata),
  };
}

export async function buildWorkflowEventContext(
  context: TenantServiceContext,
  activityEvent: Tables<"activity_events">,
): Promise<WorkflowEventContext> {
  const [entityRow, relatedEntityRow] = await Promise.all([
    getTraceEntityRow(context, activityEvent.entity_type, activityEvent.entity_id),
    getTraceEntityRow(context, activityEvent.related_entity_type, activityEvent.related_entity_id),
  ]);

  const fields = readCommonFields(activityEvent, entityRow, relatedEntityRow);
  await addQuoteAndCallFields(context, activityEvent, entityRow, fields);

  return {
    activityEvent,
    companyId: activityEvent.company_id,
    entity: (entityRow as Json) ?? null,
    entityId: activityEvent.entity_id,
    entityType: activityEvent.entity_type,
    fields,
    metadata: activityEvent.metadata_json,
    relatedEntity: (relatedEntityRow as Json) ?? null,
    relatedEntityId: activityEvent.related_entity_id,
    relatedEntityType: activityEvent.related_entity_type,
  };
}

/**
 * LIVE quote + call fields, so conditions (and resume_conditions after a wait) can ask
 * "has the deposit been paid?" / "is a date booked yet?" — re-read every time the context
 * is rebuilt, which is exactly what a resumed wait needs.
 *
 *   quote_id, quote_status, quote_deposit_paid (bool), quote_booked (bool),
 *   quote_link_sent (bool — the hosted quote link has been texted/emailed)
 *   call_id, call_direction
 *   message_from, message_preview (contact.sms_received)
 *
 * The quote comes from the event's metadata.quoteId (quote.* events), the booking's
 * quote_id (booking.* events), or — for call.* events — the quote Marina created on that
 * call (the call's lead → quotes.source_lead_id). Best-effort: an unreadable quote simply leaves the fields
 * null, and a condition on them then doesn't match.
 */
async function addQuoteAndCallFields(
  context: TenantServiceContext,
  activityEvent: Tables<"activity_events">,
  entityRow: TraceEntityRow | null,
  fields: Record<string, Json>,
): Promise<void> {
  const metadata = asJsonRecord(activityEvent.metadata_json);
  const callId = readIdField(metadata.callId);
  let quoteId =
    readIdField(metadata.quoteId) ??
    readIdField(metadata.quote_id) ??
    (entityRow && "scheduled_for" in entityRow ? readIdField((entityRow as { quote_id?: Json }).quote_id) : null);
  if (!quoteId && callId) quoteId = await quoteMadeOnCall(context, callId);

  fields.quote_id = quoteId;
  // invoice.* events: which invoice, so {{ invoice.* }} and conditions can read it live.
  const invoiceId = readIdField(metadata.invoiceId) ?? readIdField(metadata.invoice_id);
  fields.invoice_id = invoiceId;
  fields.invoice_status = null;
  fields.invoice_balance_cents = null;
  if (invoiceId) {
    try {
      const { data: inv } = await context.supabase
        .from("invoices")
        .select("status, balance_due_cents")
        .eq("organization_id", context.organizationId)
        .eq("id", invoiceId)
        .maybeSingle();
      if (inv) {
        fields.invoice_status = inv.status;
        fields.invoice_balance_cents = inv.balance_due_cents;
      }
    } catch (err) {
      console.error("[workflow-context] invoice fields unavailable:", err instanceof Error ? err.message : err);
    }
  }
  fields.quote_status = null;
  fields.quote_deposit_paid = null;
  fields.quote_booked = null;
  fields.quote_link_sent = null;
  if (quoteId) {
    try {
      const [{ data: quote }, { data: booked }, { data: linkSent }] = await Promise.all([
        context.supabase
          .from("quotes")
          .select("status, deposit_paid_at")
          .eq("organization_id", context.organizationId)
          .eq("id", quoteId)
          .maybeSingle(),
        context.supabase
          .from("bookings")
          .select("id")
          .eq("organization_id", context.organizationId)
          .eq("quote_id", quoteId)
          .neq("status", "cancelled")
          .limit(1),
        context.supabase
          .from("quote_events")
          .select("id")
          .eq("organization_id", context.organizationId)
          .eq("quote_id", quoteId)
          .in("event_type", ["deposit_link_sent", "checkout_session_created"])
          .limit(1),
      ]);
      if (quote) {
        fields.quote_status = (quote as { status: string }).status;
        fields.quote_deposit_paid = Boolean((quote as { deposit_paid_at: string | null }).deposit_paid_at);
        fields.quote_booked = ((booked ?? []) as unknown[]).length > 0;
        fields.quote_link_sent = ((linkSent ?? []) as unknown[]).length > 0;
      }
    } catch (err) {
      console.error("[workflow-context] quote fields unavailable:", err instanceof Error ? err.message : err);
    }
  }

  fields.call_id = callId;
  fields.call_direction = typeof metadata.direction === "string" ? metadata.direction : null;
  fields.message_from = typeof metadata.from === "string" ? metadata.from : null;
  fields.message_preview = typeof metadata.bodyPreview === "string" ? metadata.bodyPreview : null;

  // call.started: who's calling and when — "📞 Marina answering a call from 705-555-1234 (2:05p.m.)."
  fields.call_from = typeof metadata.callerNumber === "string" ? prettyPhone(metadata.callerNumber) : null;
  const startedAt = typeof metadata.startedAt === "string" ? new Date(metadata.startedAt) : null;
  fields.call_time =
    startedAt && !Number.isNaN(startedAt.getTime())
      ? ownerClockTime(startedAt, process.env.BUSINESS_TIMEZONE?.trim() || "America/Toronto")
      : null;

  // booking.*: was this booking brought over by an import (e.g. from the A1 Care site, which
  // still sends its own reminders for it)? Lets a reminder skip it: booking_imported equals false.
  fields.booking_imported =
    entityRow && "scheduled_for" in entityRow
      ? String((entityRow as { source?: Json }).source ?? "").startsWith("import:")
      : null;
  // booking.*: whole hours from now until the booking starts (negative once it has begun).
  // Re-read on every wait resume, so a "day before" reminder pushed into quiet hours can
  // check it's still the day before: booking_hours_until greater_than 12.
  const bookingAt =
    entityRow && "scheduled_for" in entityRow ? new Date(String((entityRow as { scheduled_for: Json }).scheduled_for)) : null;
  fields.booking_hours_until =
    bookingAt && !Number.isNaN(bookingAt.getTime()) ? Math.floor((bookingAt.getTime() - Date.now()) / 3_600_000) : null;

  // quote.deposit_link_failed: why, and a short quote reference for the owner.
  fields.failure_reason = typeof metadata.failureReason === "string" ? metadata.failureReason : null;
  fields.quote_short_id = quoteId ? quoteId.slice(0, 8) : null;
}

/** The quote Marina made during a call, via the call's lead. */
async function quoteMadeOnCall(context: TenantServiceContext, callId: string): Promise<string | null> {
  try {
    const { data: call } = await context.supabase
      .from("retell_calls")
      .select("lead_id")
      .eq("organization_id", context.organizationId)
      .eq("call_id", callId)
      .maybeSingle();
    const leadId = (call as { lead_id: string | null } | null)?.lead_id;
    if (!leadId) return null;
    const { data: quote } = await context.supabase
      .from("quotes")
      .select("id")
      .eq("organization_id", context.organizationId)
      .eq("source_lead_id", leadId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (quote as { id: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}

// ── Message template data (Task 8) ───────────────────────────────────────────

function readIdField(value: Json | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The tenant's public booking URL for a company, or null when APP_BASE_URL is unset. */
function companyBookingUrl(companyId: string | null): string | null {
  const base = process.env.APP_BASE_URL?.trim().replace(/\/+$/, "");
  return base && companyId ? `${base}/book/${companyId}` : null;
}

async function loadRowById(
  context: TenantServiceContext,
  table: "contacts" | "companies" | "bookings",
  id: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await context.supabase
    .from(table)
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as Record<string, unknown> | null) ?? null;
}

/**
 * Lead intake names a contact with no name "Lead" (see lead-intake/intake.ts splitName) so the
 * CRM row is never blank. Customers must never get "Hi Lead," — in message templates that
 * placeholder (or a blank first name) renders as "there".
 */
export const UNKNOWN_FIRST_NAME_PLACEHOLDER = "Lead";
export const UNKNOWN_FIRST_NAME_GREETING = "there";

export function withGreetingName(contact: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!contact) return contact;
  const raw = typeof contact.first_name === "string" ? contact.first_name.trim() : "";
  if (raw && raw !== UNKNOWN_FIRST_NAME_PLACEHOLDER) return contact;
  return { ...contact, first_name: UNKNOWN_FIRST_NAME_GREETING };
}

/**
 * Load the contact / company / booking (+ quote when in scope) behind an event, so a
 * message template can reference `{{ contact.first_name }}`, `{{ booking.scheduled_for | date }}`,
 * `{{ company.booking_url }}`, etc. Missing entities resolve to null → their tokens render
 * empty. Best-effort reads; scoped to the tenant.
 */
export async function buildMessageTemplateData(
  context: TenantServiceContext,
  eventContext: WorkflowEventContext,
): Promise<MessageTemplateData> {
  const contactId =
    readIdField(eventContext.fields.contact_id) ??
    (eventContext.entityType === "contact" ? eventContext.entityId : null);
  const bookingId =
    readIdField(eventContext.fields.booking_id) ??
    (eventContext.entityType === "booking" ? eventContext.entityId : null);
  const companyId = eventContext.companyId;

  const [contact, company, booking] = await Promise.all([
    contactId ? loadRowById(context, "contacts", contactId) : Promise.resolve(null),
    companyId ? loadRowById(context, "companies", companyId) : Promise.resolve(null),
    bookingId ? loadRowById(context, "bookings", bookingId) : Promise.resolve(null),
  ]);

  const timeZone =
    (typeof company?.timezone === "string" && company.timezone) || process.env.BUSINESS_TIMEZONE?.trim() || "America/Toronto";

  const quoteId = readIdField(eventContext.fields.quote_id);
  const invoiceId = readIdField(eventContext.fields.invoice_id);
  const callId = readIdField(eventContext.fields.call_id);
  const [quote, invoice, call] = await Promise.all([
    quoteId ? loadQuoteForTemplate(context, quoteId, { company, timeZone }) : Promise.resolve(null),
    invoiceId ? loadInvoiceForTemplate(context, invoiceId, company) : Promise.resolve(null),
    callId
      ? loadCallForTemplate(context.supabase, context.organizationId, callId, {
          agentName: await agentNameFor(context, companyId),
          timeZone,
        }).catch((err: unknown) => {
          console.error("[workflow-context] call unavailable:", err instanceof Error ? err.message : err);
          return null;
        })
      : Promise.resolve(null),
  ]);

  return {
    contact: withGreetingName(contact),
    company: company
      ? {
          ...company,
          booking_url: companyBookingUrl(companyId),
          // Friendly alias for the branding column, mirroring booking_url (Task 10).
          review_url: (company as Record<string, unknown>).brand_review_url ?? null,
        }
      : null,
    booking: booking ? withWindowLabels(booking, company, timeZone) : null,
    quote,
    invoice,
    call: call as Record<string, unknown> | null,
    fields: eventContext.fields as Record<string, unknown>,
  };
}
// ── Quote / call / booking-window template helpers ─────────────────────────────

/**
 * `{{ quote.* }}`: the quote row plus what a customer text needs —
 *   quote.public_url (the hosted page: review, approve, pay the deposit)
 *   quote.subtotal / quote.total / quote.deposit ("$672", "$759.36", "$250")
 *   quote.boat ("24 ft bowrider"), quote.number
 *   quote.booked_when ("Tuesday, October 6th in the morning", or "no date yet — call to book")
 *   quote.paid_via (" (via Marina)" when the receptionist sent the deposit link on a call, else "")
 */
async function loadQuoteForTemplate(
  context: TenantServiceContext,
  quoteId: string,
  opts: { company: Record<string, unknown> | null; timeZone: string },
): Promise<Record<string, unknown> | null> {
  const { data } = await context.supabase
    .from("quotes")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("id", quoteId)
    .maybeSingle();
  if (!data) return null;
  const q = data as Record<string, unknown>;
  const cents = (k: string) => Number(q[k] ?? 0);

  let bookedWhen = "no date yet — call to book";
  let paidVia = "";
  try {
    const [{ data: booking }, { data: viaMarina }] = await Promise.all([
      context.supabase
        .from("bookings")
        .select("scheduled_for, window_key")
        .eq("organization_id", context.organizationId)
        .eq("quote_id", quoteId)
        .neq("status", "cancelled")
        .order("scheduled_for", { ascending: true })
        .limit(1)
        .maybeSingle(),
      context.supabase
        .from("quote_events")
        .select("id")
        .eq("organization_id", context.organizationId)
        .eq("quote_id", quoteId)
        .eq("event_type", "deposit_link_sent")
        .eq("metadata->>by", "marina")
        .limit(1),
    ]);
    if (booking) {
      const b = booking as { scheduled_for: string; window_key: string | null };
      const policy = parseBookingPolicy(opts.company?.booking_policy ?? null) ?? DEFAULT_BOOKING_POLICY;
      const w = policy.windows.find((x) => x.key === b.window_key);
      const date = localDate(new Date(b.scheduled_for), opts.timeZone);
      bookedWhen = w ? spokenWindowLabel(date, w) : date;
    }
    if (((viaMarina ?? []) as unknown[]).length > 0) {
      paidVia = ` (via ${await agentNameFor(context, typeof q.company_id === "string" ? q.company_id : null)})`;
    }
  } catch (err) {
    console.error("[workflow-context] quote booking/link details unavailable:", err instanceof Error ? err.message : err);
  }

  return {
    ...q,
    number: q.quote_number ?? null,
    public_url: q.public_token ? `${quotePublicBaseUrlFor(opts.company)}/q/${q.public_token}` : null,
    subtotal: formatDollars(cents("subtotal_cents")),
    total: formatDollars(cents("total_cents")),
    deposit: formatDollars(cents("approved_deposit_cents") || cents("deposit_cents")),
    boat: boatFromSnapshot(q.input_snapshot),
    booked_when: bookedWhen,
    paid_via: paidVia,
  };
}

/**
 * `{{ invoice.* }}`: the invoice row plus what a text needs —
 *   invoice.number, invoice.total / invoice.balance ("$1,234.56"), invoice.due ("October 30, 2026"),
 *   invoice.public_url (the hosted pay page, on the brand's domain).
 */
async function loadInvoiceForTemplate(
  context: TenantServiceContext,
  invoiceId: string,
  company: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
  const { data } = await context.supabase
    .from("invoices")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("id", invoiceId)
    .maybeSingle();
  if (!data) return null;
  return {
    ...data,
    number: data.invoice_number ?? null,
    total: formatDollars(data.total_cents),
    balance: formatDollars(data.balance_due_cents),
    due: calendarDateLabel(data.due_date),
    // Same origin rule as the quote link (invoices/common.ts invoicePublicUrl) — inlined to
    // keep the workflow engine free of an import cycle through the invoice services.
    public_url: `${quotePublicBaseUrlFor(company)}/i/${data.public_token}`,
  };
}

/** "October 30, 2026" from a YYYY-MM-DD calendar date (no time-zone shift). */
function calendarDateLabel(ymd: string | null): string | null {
  if (!ymd) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-CA", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });
}

/** booking.window ("morning") and booking.when ("Tuesday, September 29th in the morning"). */
function withWindowLabels(
  booking: Record<string, unknown>,
  company: Record<string, unknown> | null,
  timeZone: string,
): Record<string, unknown> {
  const key = typeof booking.window_key === "string" ? booking.window_key : null;
  const at = typeof booking.scheduled_for === "string" ? new Date(booking.scheduled_for) : null;
  if (!key || !at || Number.isNaN(at.getTime())) return booking;
  const policy = parseBookingPolicy(company?.booking_policy ?? null) ?? DEFAULT_BOOKING_POLICY;
  const w = policy.windows.find((x) => x.key === key);
  if (!w) return booking;
  return { ...booking, window: w.key, when: spokenWindowLabel(localDate(at, timeZone), w) };
}

async function agentNameFor(context: TenantServiceContext, companyId: string | null): Promise<string> {
  if (!companyId) return DEFAULT_AGENT_NAME;
  const { data } = await context.supabase
    .from("company_voice_profiles")
    .select("dynamic_variables")
    .eq("company_id", companyId)
    .eq("active", true)
    .limit(1)
    .maybeSingle();
  const dyn = (data as { dynamic_variables?: Record<string, unknown> } | null)?.dynamic_variables;
  const name = dyn && typeof dyn.agent_name === "string" ? dyn.agent_name.trim() : "";
  return name || DEFAULT_AGENT_NAME;
}
