/**
 * Agreements: one customer on one plan for one 12-month term (service_agreements), and the ONE
 * recurring_jobs series each agreement drives. docs/ai-staff.md → "Service plans".
 *
 *   pending_owner ─Y─▶ active            (plan_signup approval; per-visit plans, no online payment,
 *   pending_payment ─paid─▶ active        the owner's enroll_customer) / (annual, paid online)
 *   active ─renewal link─▶ renewal_due ─paid / kept─▶ renewed (+ a new active row for the next term)
 *                                       └─ term end + 14 days unpaid ─▶ lapsed
 *   any open ─▶ cancelled (owner declined, never paid, or cancelled in Settings)
 *
 * The series: created by THIS module (createRecurringJob with explicit visit dates), and only ever
 * touched through an agreement's own recurring_job_id, filtered by organization AND company — so
 * no other series (A1's, or anything the owner made by hand) is ever read or changed here.
 * Ending a plan keeps every visit that was done, started, moved by hand or is in the past
 * (recurring/service.ts clearUntouchedFutureVisits).
 *
 * Every state change is a conditional update on the current status, so overlapping workers and a
 * retried webhook can't start, renew or lapse anything twice.
 */
import { randomBytes } from "node:crypto";

import { addDays, localDate } from "@/server/services/booking-windows";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { isQuietHours, sendOwnerSms, type OwnerSmsInput } from "@/server/services/owner-channel/common";
import { clearUntouchedFutureVisits, createRecurringJob, generateVisits } from "@/server/services/recurring/service";
import type { Tables } from "@/server/db/database.types";
import { createPlanApproval, defaultPlanApprovalDeps, PLAN_SIGNUP_KIND, supersedeApproval, type PlanApprovalDeps } from "./approval-kinds";
import { defaultPlanBillingDeps, invoiceStates, isPaid, moneyIn, type IssuedInvoice, type PlanBillingDeps } from "./billing";
import { OPEN_STATUSES, type AgreementSource, type AgreementStatus, type Db, type PlanContact, type ServiceAgreementRow, type ServicePlanRow } from "./db-types";
import { defaultPlanMessageDeps, loadContact, queueAndSend, tenant, type PlanMessageDeps } from "./messages";
import { includedOf, loadPlan, planSchedule } from "./plans";
import { cleanMonths, dayText, longDate, money, termEndFor, termVisitDates, type PlanSchedule } from "./schedule";
import { LAPSE_GRACE_DAYS, loadPlanCompany, type PlanCompany } from "./settings";
import { confirmationText, firstNameOf, PLAN_CONSENT_VERSION, planConsentText, renewedText, signupSummary } from "./texts";

export interface PlanDeps {
  billing: PlanBillingDeps;
  messages: PlanMessageDeps;
  approvals: PlanApprovalDeps;
  ownerSms(admin: AdminClient, input: OwnerSmsInput): Promise<{ status: string }>;
}

export const defaultPlanDeps: PlanDeps = {
  billing: defaultPlanBillingDeps,
  messages: defaultPlanMessageDeps,
  approvals: defaultPlanApprovalDeps,
  ownerSms: (admin, input) => sendOwnerSms(admin, input),
};

/** The first visit can't be sooner than this many days after the plan starts. */
export const FIRST_VISIT_MIN_DAYS = 3;

type Scope = { organizationId: string; companyId: string };

const scopeOf = (company: PlanCompany): Scope => ({ organizationId: company.organizationId, companyId: company.companyId });

export function contactName(contact: Pick<PlanContact, "first_name" | "last_name" | "phone"> | null, fallback?: string | null): string {
  const first = contact?.first_name && !/^\+?\d[\d\s()-]{6,}$/.test(contact.first_name) ? contact.first_name : "";
  return [first, contact?.last_name].filter(Boolean).join(" ").trim() || fallback?.trim() || contact?.phone || "the customer";
}

export function newRenewalToken(): string {
  return randomBytes(16).toString("hex");
}

// ── Reading ─────────────────────────────────────────────────────────────────

export async function loadAgreement(admin: AdminClient, scope: Scope, agreementId: string): Promise<ServiceAgreementRow | null> {
  if (!agreementId) return null;
  const { data, error } = await (admin as Db)
    .from("service_agreements")
    .select("*")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("id", agreementId)
    .maybeSingle();
  if (error) throw error;
  return (data as ServiceAgreementRow | null) ?? null;
}

export async function listAgreements(admin: AdminClient, scope: Scope, statuses?: AgreementStatus[], limit = 500): Promise<ServiceAgreementRow[]> {
  let q = (admin as Db).from("service_agreements").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId);
  if (statuses) q = q.in("status", statuses);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return (data ?? []) as ServiceAgreementRow[];
}

/** Schedule for an agreement: the plan's (weekday / week / time), the agreement's own months. */
function scheduleFor(agreement: Pick<ServiceAgreementRow, "visit_months">, plan: ServicePlanRow | null): PlanSchedule {
  const base = plan ? planSchedule(plan) : { months: [], weekday: 1, week: 1 };
  return { ...base, months: cleanMonths(agreement.visit_months) };
}

// ── Contacts ────────────────────────────────────────────────────────────────

export interface SignupCustomer {
  name: string;
  /** E.164 */
  phone: string;
  email: string | null;
  address: string | null;
  smsConsent: boolean;
}

function splitName(name: string): { first: string; last: string | null } {
  const parts = name.trim().replace(/\s+/g, " ").split(" ");
  return { first: parts[0] ?? name, last: parts.length > 1 ? parts.slice(1).join(" ") : null };
}

/** Does the name typed on a public form fit an existing contact? ("Pat" fits "Patricia"; missing parts don't disagree.) PURE. */
export function namesFit(typed: string, contact: Pick<PlanContact, "first_name" | "last_name">): boolean {
  const norm = (v: string | null | undefined) => (v ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (/^\+?\d/.test(contact.first_name ?? "")) return true; // a phone-number placeholder name
  const t = splitName(typed);
  const cf = norm(contact.first_name);
  const cl = norm(contact.last_name);
  const tf = norm(t.first);
  const tl = norm(t.last);
  const firstOk = !cf || !tf || cf.startsWith(tf) || tf.startsWith(cf);
  const lastOk = !cl || !tl || cl === tl;
  return firstOk && lastOk;
}

export interface SignupContact {
  id: string;
  /** Made by this sign-up (else an existing customer matched by phone). */
  created: boolean;
  /** The typed name fits the matched customer (always true for a new contact). */
  fits: boolean;
}

/** What the customer agreed to on the form: kept as evidence (wording + version + when). */
function consentRecord(company: PlanCompany, nowMs: number) {
  return { at: new Date(nowMs).toISOString(), version: PLAN_CONSENT_VERSION, text: planConsentText(company.name) };
}

/**
 * The customer behind a public sign-up: matched by phone (last 10 digits) in this company, else a
 * new contact (inserted directly — no contact.created event, so no lead automation fires; we tell
 * the owner ourselves). An existing customer's details and consent fields are never changed from a
 * public form (anyone can type anyone's number); a ticked consent box is only recorded as evidence
 * in metadata.plan_sms_consent.
 */
export async function contactForSignup(admin: AdminClient, company: PlanCompany, customer: SignupCustomer, nowMs: number): Promise<SignupContact | null> {
  const db = admin as Db;
  const last10 = customer.phone.replace(/\D/g, "").slice(-10);
  const { data: found, error } = await db
    .from("contacts")
    .select("id, first_name, last_name, metadata")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .eq("phone_last10", last10)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw error;
  const existing = ((found ?? []) as Array<Pick<PlanContact, "id" | "first_name" | "last_name" | "metadata">>)[0];
  if (existing) {
    if (customer.smsConsent) {
      const meta = existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata) ? { ...(existing.metadata as Record<string, unknown>) } : {};
      meta.plan_sms_consent = consentRecord(company, nowMs);
      await db.from("contacts").update({ metadata: meta }).eq("organization_id", company.organizationId).eq("id", existing.id);
    }
    return { id: existing.id, created: false, fits: namesFit(customer.name, existing) };
  }
  const { first, last } = splitName(customer.name);
  const { data: created, error: insertError } = await db
    .from("contacts")
    .insert({
      organization_id: company.organizationId,
      company_id: company.companyId,
      first_name: first.slice(0, 80),
      last_name: last?.slice(0, 80) ?? null,
      phone: customer.phone,
      email: customer.email,
      stage: "active",
      metadata: {
        source: "service_plan_signup",
        ...(customer.address ? { service_address: customer.address } : {}),
        ...(customer.smsConsent ? { plan_sms_consent: consentRecord(company, nowMs) } : {}),
      },
      // The box on the sign-up form is express consent to plan texts; without it, the plan
      // itself (once started) is the purchase relationship.
      consent_source: customer.smsConsent ? "express" : "implied_inquiry",
      sms_consent_at: new Date(nowMs).toISOString(),
      notes: "Signed up for a service plan online.",
    })
    .select("id")
    .single();
  if (insertError || !created) return null;
  return { id: (created as { id: string }).id, created: true, fits: true };
}

/** The address a contact has on file (a new sign-up's contact carries the typed one). */
export function storedAddress(contact: Pick<PlanContact, "metadata"> | null): string | null {
  const meta = contact?.metadata && typeof contact.metadata === "object" && !Array.isArray(contact.metadata) ? (contact.metadata as Record<string, unknown>) : {};
  return typeof meta.service_address === "string" && meta.service_address.trim() ? meta.service_address.trim().slice(0, 300) : null;
}

// ── Creating ────────────────────────────────────────────────────────────────

interface NewAgreement {
  plan: ServicePlanRow;
  contactId: string;
  status: Extract<AgreementStatus, "pending_owner" | "pending_payment">;
  source: AgreementSource;
  customer?: Partial<SignupCustomer> | null;
}

/** Insert a pending agreement. An open one for the same customer + plan → that one (`existing`). */
export async function createAgreement(admin: AdminClient, company: PlanCompany, input: NewAgreement, nowMs: number): Promise<{ agreement: ServiceAgreementRow; existing: boolean }> {
  const db = admin as Db;
  const findOpen = async (): Promise<ServiceAgreementRow | null> => {
    const { data: open } = await db
      .from("service_agreements")
      .select("*")
      .eq("organization_id", company.organizationId)
      .eq("company_id", company.companyId)
      .eq("plan_id", input.plan.id)
      .eq("contact_id", input.contactId)
      .in("status", OPEN_STATUSES)
      .limit(1);
    return ((open ?? []) as ServiceAgreementRow[])[0] ?? null;
  };
  // The partial unique index (one open agreement per customer + plan) is the backstop for a race.
  const already = await findOpen();
  if (already) return { agreement: already, existing: true };
  const { data, error } = await db
    .from("service_agreements")
    .insert({
      organization_id: company.organizationId,
      company_id: company.companyId,
      plan_id: input.plan.id,
      contact_id: input.contactId,
      status: input.status,
      source: input.source,
      plan_name: input.plan.name,
      billing: input.plan.billing,
      price_cents: input.plan.price_cents,
      visit_months: cleanMonths(input.plan.visit_months),
      customer_name: input.customer?.name?.slice(0, 120) ?? null,
      customer_phone: input.customer?.phone ?? null,
      customer_email: input.customer?.email ?? null,
      service_address: input.customer?.address?.slice(0, 300) ?? null,
      sms_consent_at: input.customer?.smsConsent ? new Date(nowMs).toISOString() : null,
      sms_consent_text: input.customer?.smsConsent ? `${PLAN_CONSENT_VERSION}: ${planConsentText(company.name)}`.slice(0, 600) : null,
    })
    .select("*")
    .single();
  if (!error && data) return { agreement: data as ServiceAgreementRow, existing: false };
  if ((error as { code?: string } | null)?.code === "23505") {
    const row = await findOpen();
    if (row) return { agreement: row, existing: true };
  }
  throw error ?? new Error("Could not create the agreement.");
}

/** What the visits of a new term starting today would be (for the owner's text). PURE-ish. */
export function previewVisits(plan: ServicePlanRow, today: string): { termStart: string; termEnd: string; dates: string[] } {
  const termEnd = termEndFor(today);
  return { termStart: today, termEnd, dates: termVisitDates(planSchedule(plan), today, termEnd, addDays(today, FIRST_VISIT_MIN_DAYS)) };
}

// ── The series ──────────────────────────────────────────────────────────────

type Series = Tables<"recurring_jobs"> & { visit_dates?: string[] | null };

async function loadSeries(admin: AdminClient, agreement: Pick<ServiceAgreementRow, "organization_id" | "company_id" | "recurring_job_id">): Promise<Series | null> {
  if (!agreement.recurring_job_id) return null;
  const { data, error } = await (admin as Db)
    .from("recurring_jobs")
    .select("*")
    .eq("organization_id", agreement.organization_id)
    .eq("company_id", agreement.company_id)
    .eq("id", agreement.recurring_job_id)
    .maybeSingle();
  if (error) throw error;
  return (data as Series | null) ?? null;
}

function visitLines(agreement: Pick<ServiceAgreementRow, "billing" | "plan_name" | "price_cents">, priceCents = agreement.price_cents) {
  // Annual plans are paid up front: their visits carry no price (and aren't auto-invoiced, see
  // prepaid.ts). Per-visit plans invoice each visit at the agreed price, like any recurring job.
  return agreement.billing === "per_visit" ? [{ label: `${agreement.plan_name} visit`, quantity: 1, unitPriceCents: priceCents }] : [];
}

/**
 * The agreement's series, created once (idempotent: an agreement that already has one keeps it).
 * Visits inside the 60-day horizon are booked now; the daily recurring sweep books the rest.
 */
export async function ensureSeries(admin: AdminClient, agreement: ServiceAgreementRow, plan: ServicePlanRow | null, nowMs: number, location: string | null = null, today?: string): Promise<string | null> {
  if (agreement.recurring_job_id) return agreement.recurring_job_id;
  if (!agreement.contact_id || !agreement.term_start || !agreement.term_end) return null;
  const included = plan ? includedOf(plan) : [];
  const description = [plan?.description?.trim() || null, included.length ? `Includes: ${included.join("; ")}.` : null, "Service plan visit."].filter(Boolean).join(" ").slice(0, 4000);
  const startDate = agreement.visit_dates[0] ?? agreement.term_start;
  const { series } = await createRecurringJob(
    tenant(admin, agreement.organization_id),
    {
      companyId: agreement.company_id,
      contactId: agreement.contact_id,
      title: agreement.plan_name,
      description,
      location,
      durationMinutes: plan?.duration_minutes ?? 60,
      // The rule is only a label: a series with visit_dates is laid out on exactly those dates.
      frequency: "yearly",
      interval: 1,
      startDate,
      timeOfDay: plan?.time_of_day ?? "09:00",
      endsOn: agreement.term_end >= startDate ? agreement.term_end : startDate,
      lineItems: visitLines(agreement),
    },
    new Date(nowMs),
    { visitDates: agreement.visit_dates },
  );
  const { data: linked } = await (admin as Db)
    .from("service_agreements")
    .update({ recurring_job_id: series.id })
    .eq("organization_id", agreement.organization_id)
    .eq("id", agreement.id)
    .is("recurring_job_id", null)
    .select("id");
  if (((linked ?? []) as unknown[]).length === 0) {
    // Another worker linked its own series first: end ours (it's brand new, nothing done on it).
    await endSeriesById(admin, agreement.organization_id, agreement.company_id, series.id, nowMs, null, today ?? new Date(nowMs).toISOString().slice(0, 10));
    const fresh = await loadAgreement(admin, { organizationId: agreement.organization_id, companyId: agreement.company_id }, agreement.id);
    return fresh?.recurring_job_id ?? null;
  }
  return series.id;
}

/** Add dates to the agreement's series (a renewal), then book what's inside the horizon. */
async function extendSeries(admin: AdminClient, agreement: ServiceAgreementRow, dates: string[], endsOn: string, nowMs: number, linePriceCents?: number, reactivate = false): Promise<void> {
  const series = await loadSeries(admin, agreement);
  if (!series) return;
  const merged = [...new Set([...(series.visit_dates ?? []), ...dates])].sort();
  const patch: Record<string, unknown> = { visit_dates: merged, ends_on: series.ends_on && series.ends_on > endsOn ? series.ends_on : endsOn, generated_through: null };
  if (linePriceCents !== undefined && agreement.billing === "per_visit") patch.line_items = visitLines(agreement, linePriceCents);
  // A lapsed plan paid after all: its (ended) series comes back for the new term.
  if (reactivate && series.status === "ended") patch.status = "active";
  const { data, error } = await (admin as Db)
    .from("recurring_jobs")
    .update(patch)
    .eq("organization_id", agreement.organization_id)
    .eq("company_id", agreement.company_id)
    .eq("id", series.id)
    .select("*");
  if (error) throw error;
  const updated = ((data ?? []) as Series[])[0];
  if (updated) await generateVisits(tenant(admin, agreement.organization_id), updated as Tables<"recurring_jobs">, new Date(nowMs));
}

async function endSeriesById(admin: AdminClient, organizationId: string, companyId: string, seriesId: string, nowMs: number, keepThrough: string | null, today: string): Promise<number> {
  const db = admin as Db;
  const { data: rows } = await db.from("recurring_jobs").select("id, visit_dates").eq("organization_id", organizationId).eq("company_id", companyId).eq("id", seriesId).limit(1);
  const row = ((rows ?? []) as Array<{ id: string; visit_dates: string[] | null }>)[0];
  if (!row) return 0;
  const kept = keepThrough ? (row.visit_dates ?? []).filter((d) => d <= keepThrough) : (row.visit_dates ?? []).filter((d) => d < today);
  await db.from("recurring_jobs").update({ status: "ended", visit_dates: kept, generated_through: null }).eq("organization_id", organizationId).eq("company_id", companyId).eq("id", seriesId);
  // Only upcoming visits nobody touched come off (moved by hand, started, done: kept).
  return clearUntouchedFutureVisits(tenant(admin, organizationId), seriesId, new Date(nowMs));
}

/** End the agreement's own series. Returns how many upcoming visits came off the calendar. */
async function endSeries(admin: AdminClient, company: PlanCompany, agreement: ServiceAgreementRow, nowMs: number, keepThrough: string | null): Promise<number> {
  if (!agreement.recurring_job_id) return 0;
  return endSeriesById(admin, agreement.organization_id, agreement.company_id, agreement.recurring_job_id, nowMs, keepThrough, localDate(new Date(nowMs), company.timeZone));
}

// ── Starting ────────────────────────────────────────────────────────────────

export interface StartResult {
  ok: boolean;
  agreement: ServiceAgreementRow | null;
  firstVisit: string | null;
  visits: number;
  texted: string | null;
  reason?: string;
}

/**
 * Start the plan: claim pending → active (term from today, visit dates from the plan), create the
 * series, text the customer. A second call finds nothing to claim (reason "already").
 */
export async function startAgreement(
  admin: AdminClient,
  company: PlanCompany,
  agreement: ServiceAgreementRow,
  // ownerApproved: the owner said Y (or enrolled them), so the address typed on the form is used.
  opts: { nowMs: number; from: AgreementStatus[]; invoice?: IssuedInvoice | null; ownerApproved?: boolean },
  deps: PlanDeps = defaultPlanDeps,
): Promise<StartResult> {
  const db = admin as Db;
  const plan = await loadPlan(admin, scopeOf(company), agreement.plan_id);
  const today = localDate(new Date(opts.nowMs), company.timeZone);
  const termEnd = termEndFor(today);
  const dates = termVisitDates(scheduleFor(agreement, plan), today, termEnd, addDays(today, FIRST_VISIT_MIN_DAYS));
  const invoiceIds = opts.invoice ? [...new Set([...(agreement.invoice_ids ?? []), opts.invoice.id])] : agreement.invoice_ids ?? [];
  const { data: claimed, error } = await db
    .from("service_agreements")
    .update({
      status: "active",
      term_start: today,
      term_end: termEnd,
      visit_dates: dates,
      activated_at: new Date(opts.nowMs).toISOString(),
      invoice_ids: invoiceIds,
      pending_invoice_id: null,
    })
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .eq("id", agreement.id)
    .in("status", opts.from)
    .select("*");
  if (error) throw error;
  const row = ((claimed ?? []) as ServiceAgreementRow[])[0];
  if (!row) return { ok: false, agreement, firstVisit: null, visits: 0, texted: null, reason: "already" };
  const contact = await loadContact(admin, company.organizationId, row.contact_id);
  // A typed address only goes on the calendar once the owner OK'd it; otherwise the one on file
  // (a brand-new contact carries what they typed).
  const location = opts.ownerApproved ? (row.service_address ?? storedAddress(contact)) : storedAddress(contact);
  await ensureSeries(admin, row, plan, opts.nowMs, location, today);
  const body = confirmationText({
    firstName: firstNameOf(contact?.first_name ?? row.customer_name),
    businessName: company.name,
    planName: row.plan_name,
    firstVisit: dates[0] ?? null,
    timeOfDay: plan?.time_of_day ?? "09:00",
    planMonths: row.visit_months,
    invoice: opts.invoice ? { totalCents: opts.invoice.totalCents, url: opts.invoice.url } : null,
  });
  const outcome = await queueAndSend(admin, { company, agreement: row, kind: "confirmation", dedupeKey: row.id, body, nowMs: opts.nowMs }, deps.messages);
  const fresh = (await loadAgreement(admin, scopeOf(company), row.id)) ?? row;
  return { ok: true, agreement: fresh, firstVisit: dates[0] ?? null, visits: dates.length, texted: outcome === "sent" || outcome === "queued" ? body : null };
}

// ── Sign-up ─────────────────────────────────────────────────────────────────

export type SignupResult =
  | { kind: "checkout"; url: string; agreementId: string }
  /** Neutral on purpose: the same page whether the owner was asked now, earlier, or it already runs. */
  | { kind: "requested"; agreementId: string }
  | { kind: "error"; error: string };

/**
 * The public sign-up. Annual plan + the business takes cards online + not someone else's number →
 * the agreement waits on payment (pending_payment) and the customer goes to Checkout for the first
 * year's DRAFT invoice; the webhook issues it and starts the plan. Otherwise → a plan_signup
 * approval. A phone that matches an existing customer under another name always goes to the owner.
 * `returnUrl` is the plan page (Checkout comes back there).
 */
export async function publicSignup(
  admin: AdminClient,
  company: PlanCompany,
  plan: ServicePlanRow,
  customer: SignupCustomer,
  nowMs: number,
  deps: PlanDeps = defaultPlanDeps,
  returnUrl = "",
): Promise<SignupResult> {
  if (!plan.active || !company.settings.enabled) return { kind: "error", error: "This plan isn't taking sign-ups right now." };
  const match = await contactForSignup(admin, company, customer, nowMs);
  if (!match) return { kind: "error", error: "We couldn't save your details. Please try again." };
  const online = plan.billing === "annual" && match.fits && (await deps.billing.stripeReady(company.companyId));
  const { agreement, existing } = await createAgreement(admin, company, { plan, contactId: match.id, status: online ? "pending_payment" : "pending_owner", source: "public", customer }, nowMs);
  if (existing) {
    // Never reveal whether a number is already on a plan: the same neutral answer unless this is
    // the same person coming back to pay.
    if (agreement.status === "pending_payment" && match.fits && agreement.pending_invoice_id) {
      const url = await deps.billing.planCheckoutUrl(admin, { organizationId: company.organizationId, companyId: company.companyId, agreementId: agreement.id, invoiceId: agreement.pending_invoice_id, returnUrl });
      if (url) return { kind: "checkout", url, agreementId: agreement.id };
    }
    return { kind: "requested", agreementId: agreement.id };
  }
  if (online) {
    const today = localDate(new Date(nowMs), company.timeZone);
    try {
      const invoice = await deps.billing.draftTermInvoice(admin, {
        organizationId: company.organizationId,
        companyId: company.companyId,
        contactId: match.id,
        title: `${plan.name} - service plan`,
        lineLabel: `${plan.name} - service plan, 12 months`,
        lineDescription: [`From ${longDate(today)} to ${longDate(termEndFor(today))}.`, includedOf(plan).length ? `Each visit: ${includedOf(plan).join("; ")}.` : null].filter(Boolean).join(" "),
        priceCents: plan.price_cents,
        dueDate: today,
        pauseReminders: true,
        internalNote: `Service plan sign-up (agreement ${agreement.id}). Issued when it's paid online.`,
      });
      await (admin as Db)
        .from("service_agreements")
        .update({ pending_invoice_id: invoice.id, invoice_ids: [invoice.id] })
        .eq("organization_id", company.organizationId)
        .eq("id", agreement.id);
      const url = await deps.billing.planCheckoutUrl(admin, { organizationId: company.organizationId, companyId: company.companyId, agreementId: agreement.id, invoiceId: invoice.id, returnUrl });
      if (url) return { kind: "checkout", url, agreementId: agreement.id };
      // Checkout couldn't start: drop the draft (no number was used) and ask the owner instead.
      await deps.billing.voidUnpaid(admin, company.organizationId, invoice.id, "Service plan sign-up - online payment couldn't start.");
    } catch (err) {
      console.error("[service-plans] sign-up payment couldn't start:", err instanceof Error ? err.message : err);
    }
    const { data: moved } = await (admin as Db)
      .from("service_agreements")
      .update({ status: "pending_owner", pending_invoice_id: null, invoice_ids: [] })
      .eq("organization_id", company.organizationId)
      .eq("id", agreement.id)
      .eq("status", "pending_payment")
      .select("*");
    const row = ((moved ?? []) as ServiceAgreementRow[])[0];
    if (!row) return { kind: "error", error: "We couldn't start the payment. Please try again in a few minutes." };
    const contact = await loadContact(admin, company.organizationId, match.id);
    await askOwnerToStart(admin, company, plan, row, contact, { askedInlineTo: null, ownerAsked: false, nowMs }, deps);
    return { kind: "requested", agreementId: agreement.id };
  }
  const contact = await loadContact(admin, company.organizationId, match.id);
  await askOwnerToStart(admin, company, plan, agreement, contact, { askedInlineTo: null, ownerAsked: false, nowMs }, deps);
  return { kind: "requested", agreementId: agreement.id };
}

/** The plan_signup approval for a pending_owner agreement. Returns the code + summary. */
export async function askOwnerToStart(
  admin: AdminClient,
  company: PlanCompany,
  plan: ServicePlanRow,
  agreement: ServiceAgreementRow,
  contact: PlanContact | null,
  opts: { askedInlineTo: string | null; ownerAsked: boolean; nowMs: number },
  deps: PlanDeps = defaultPlanDeps,
): Promise<{ id: string; shortCode: number | null; summary: string }> {
  const today = localDate(new Date(opts.nowMs), company.timeZone);
  const preview = previewVisits(plan, today);
  const sendsInvoice = plan.billing === "annual";
  // A public sign-up whose phone matched a customer under another name: show both.
  const typed = agreement.source === "public" && agreement.customer_name?.trim() ? agreement.customer_name.trim() : null;
  const mismatch = typed && contact && !namesFit(typed, contact) ? contactName(contact) : null;
  const summary = signupSummary({
    customerName: mismatch && typed ? typed : contactName(contact, agreement.customer_name),
    matchedCustomer: mismatch,
    address: agreement.source === "public" ? agreement.service_address : null,
    customerPhone: contact?.phone ?? agreement.customer_phone,
    planName: agreement.plan_name,
    billing: agreement.billing,
    priceCents: agreement.price_cents,
    months: agreement.visit_months,
    firstVisit: preview.dates[0] ?? null,
    sendsInvoice,
    ownerAsked: opts.ownerAsked,
  });
  const approval = await createPlanApproval(
    admin,
    {
      organizationId: company.organizationId,
      companyId: company.companyId,
      contactId: agreement.contact_id,
      kind: PLAN_SIGNUP_KIND,
      summary,
      payload: { agreementId: agreement.id, planId: plan.id, priceCents: agreement.price_cents, billing: agreement.billing },
      askedInlineTo: opts.askedInlineTo,
    },
    opts.nowMs,
    deps.approvals,
  );
  const { data: linked } = await (admin as Db)
    .from("service_agreements")
    .update({ approval_id: approval.id, decision_claimed_at: null })
    .eq("organization_id", company.organizationId)
    .eq("id", agreement.id)
    .eq("status", "pending_owner")
    .select("id");
  if (((linked ?? []) as unknown[]).length === 0) {
    await supersedeApproval(admin, approval.id);
    throw new Error("The sign-up changed before the owner could be asked.");
  }
  return approval;
}

// ── Paid invoices (webhook + sweep) ─────────────────────────────────────────

/** A lapsed plan paid within this many days of lapsing comes back (renewed); later → the owner decides. */
export const REACTIVATE_DAYS = 60;

export type SettleOutcome = "started" | "renewed" | "reactivated" | "owner_told" | "noop";

/**
 * An invoice of a plan was paid: start the sign-up, renew the plan, or bring back a plan that
 * lapsed recently. Money that arrives for a plan we can't restart (cancelled, lapsed long ago) is
 * never silently kept: the owner is texted once. Called by the Stripe Connect webhook right after
 * the payment is recorded, by the payments sweep (which also catches an e-Transfer the owner
 * recorded) and by the lapse check. Idempotent; never throws.
 */
export async function settlePlanInvoice(admin: AdminClient, invoiceId: string, nowMs: number, deps: PlanDeps = defaultPlanDeps, loadCompany?: (orgId: string, companyId: string) => Promise<PlanCompany | null>): Promise<SettleOutcome> {
  try {
    const { data } = await (admin as Db).from("service_agreements").select("*").eq("pending_invoice_id", invoiceId).limit(1);
    const agreement = ((data ?? []) as ServiceAgreementRow[])[0];
    if (!agreement) return "noop";
    const state = (await invoiceStates(admin, agreement.organization_id, [invoiceId])).get(invoiceId);
    const company = loadCompany ? await loadCompany(agreement.organization_id, agreement.company_id) : await loadPlanCompany(admin, agreement.organization_id, agreement.company_id);
    if (!company || !company.doneForYou) return "noop";
    if (agreement.status === "pending_payment" && isPaid(state)) {
      const started = await startAgreement(admin, company, agreement, { nowMs, from: ["pending_payment"] }, deps);
      if (started.ok) await tellOwnerPaidSignup(admin, company, started, state?.totalCents ?? 0, nowMs, deps);
      return started.ok ? "started" : "noop";
    }
    if ((agreement.status === "active" || agreement.status === "renewal_due") && isPaid(state)) {
      const renewed = await renewAgreement(admin, company, agreement, nowMs, deps);
      return renewed.ok ? "renewed" : "noop";
    }
    if (!moneyIn(state)) return "noop";
    const today = localDate(new Date(nowMs), company.timeZone);
    if (agreement.status === "lapsed" && agreement.term_end && addDays(agreement.term_end, LAPSE_GRACE_DAYS + REACTIVATE_DAYS) >= today) {
      const renewed = await renewAgreement(admin, company, agreement, nowMs, deps, { fromLapsed: true });
      if (renewed.ok) {
        await tellOwnerOnce(admin, company, agreement, `reactivated:${invoiceId}`, nowMs, deps, (who) => `${who} paid for ${agreement.plan_name} after it lapsed, so I renewed it and put their visits back on the calendar.`);
        return "reactivated";
      }
      return "noop";
    }
    if (agreement.status === "lapsed" || agreement.status === "cancelled") {
      const told = await tellOwnerOnce(admin, company, agreement, `paid_after:${invoiceId}`, nowMs, deps, (who) =>
        `${who} paid ${money(state?.amountPaidCents ?? 0)} for ${agreement.plan_name}, but that plan is ${agreement.status}. Nothing was booked - restart it in Settings or refund them.`,
      );
      return told ? "owner_told" : "noop";
    }
    return "noop";
  } catch (err) {
    console.error(`[service-plans] settling invoice ${invoiceId} failed:`, err instanceof Error ? err.message : err);
    return "noop";
  }
}

/** One owner text per key (claimed in service_plan_runs). Sent any time: it's about money. */
async function tellOwnerOnce(admin: AdminClient, company: PlanCompany, agreement: ServiceAgreementRow, key: string, nowMs: number, deps: PlanDeps, body: (who: string) => string): Promise<boolean> {
  if (!company.ownerPhone) return false;
  const { error } = await (admin as Db).from("service_plan_runs").insert({ company_id: company.companyId, kind: "owner_text", run_key: key.slice(0, 200) });
  if (error) return false;
  const contact = await loadContact(admin, company.organizationId, agreement.contact_id);
  await deps.ownerSms(admin, { to: company.ownerPhone, organizationId: company.organizationId, companyId: company.companyId, platformBrand: company.platformBrand, body: body(contactName(contact, agreement.customer_name)) });
  return true;
}

async function tellOwnerPaidSignup(admin: AdminClient, company: PlanCompany, started: StartResult, paidCents: number, nowMs: number, deps: PlanDeps): Promise<void> {
  const row = started.agreement;
  if (!row || !company.ownerPhone || isQuietHours(nowMs, company.timeZone)) return;
  const { data: claim } = await (admin as Db)
    .from("service_agreements")
    .update({ owner_notified_at: new Date(nowMs).toISOString() })
    .eq("organization_id", company.organizationId)
    .eq("id", row.id)
    .is("owner_notified_at", null)
    .select("id");
  if (((claim ?? []) as unknown[]).length === 0) return;
  const contact = await loadContact(admin, company.organizationId, row.contact_id);
  const first = started.firstVisit ? ` First visit ${dayText(started.firstVisit)} is on the calendar.` : "";
  await deps.ownerSms(admin, {
    to: company.ownerPhone,
    organizationId: company.organizationId,
    companyId: company.companyId,
    platformBrand: company.platformBrand,
    body: `New plan: ${contactName(contact, row.customer_name)} signed up for ${row.plan_name} and paid ${money(paidCents)} online.${first}`,
  });
}

// ── Renewing ────────────────────────────────────────────────────────────────

export interface RenewResult {
  ok: boolean;
  next: ServiceAgreementRow | null;
  reason?: string;
}

/** The renewal was paid (annual) or kept (per visit): renewed + the next term as a new active row. */
export async function renewAgreement(admin: AdminClient, company: PlanCompany, old: ServiceAgreementRow, nowMs: number, deps: PlanDeps = defaultPlanDeps, opts: { fromLapsed?: boolean } = {}): Promise<RenewResult> {
  const db = admin as Db;
  if (!old.term_end || !old.contact_id) return { ok: false, next: null, reason: "no term" };
  const previousStatus = old.status;
  const { data: claimed } = await db
    .from("service_agreements")
    .update({ status: "renewed" })
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .eq("id", old.id)
    .in("status", opts.fromLapsed ? ["lapsed"] : ["active", "renewal_due"])
    .select("*");
  const claimedRow = ((claimed ?? []) as ServiceAgreementRow[])[0];
  if (!claimedRow) return { ok: false, next: null, reason: "already" };
  const plan = await loadPlan(admin, scopeOf(company), old.plan_id);
  const start = addDays(old.term_end, 1);
  const end = termEndFor(start);
  const dates = termVisitDates(scheduleFor(old, plan), start, end);
  const price = old.renewal_price_cents ?? old.price_cents;
  const { data: inserted, error } = await db
    .from("service_agreements")
    .insert({
      organization_id: company.organizationId,
      company_id: company.companyId,
      plan_id: old.plan_id,
      contact_id: old.contact_id,
      status: "active",
      source: "renewal",
      plan_name: old.plan_name,
      billing: old.billing,
      price_cents: price,
      visit_months: old.visit_months,
      term_start: start,
      term_end: end,
      visit_dates: dates,
      recurring_job_id: old.recurring_job_id,
      invoice_ids: old.pending_invoice_id ? [old.pending_invoice_id] : [],
      previous_agreement_id: old.id,
      activated_at: new Date(nowMs).toISOString(),
      customer_name: old.customer_name,
      customer_phone: old.customer_phone,
      customer_email: old.customer_email,
      service_address: old.service_address,
      sms_consent_at: old.sms_consent_at,
      sms_consent_text: old.sms_consent_text,
    })
    .select("*")
    .single();
  if (error || !inserted) {
    await db.from("service_agreements").update({ status: previousStatus }).eq("organization_id", company.organizationId).eq("id", old.id).eq("status", "renewed");
    throw error ?? new Error("Could not create the next term.");
  }
  const next = inserted as ServiceAgreementRow;
  await db.from("service_agreements").update({ renewed_by_agreement_id: next.id, pending_invoice_id: null }).eq("organization_id", company.organizationId).eq("id", old.id);
  const contact = await loadContact(admin, company.organizationId, next.contact_id);
  const today = localDate(new Date(nowMs), company.timeZone);
  if (next.recurring_job_id && (await loadSeries(admin, next))) await extendSeries(admin, next, dates, end, nowMs, price, opts.fromLapsed === true);
  else await ensureSeries(admin, { ...next, recurring_job_id: null }, plan, nowMs, storedAddress(contact) ?? next.service_address, today);
  const body = renewedText({
    firstName: firstNameOf(contact?.first_name ?? next.customer_name),
    businessName: company.name,
    planName: next.plan_name,
    termEnd: end,
    nextVisit: dates[0] ?? null,
    timeOfDay: plan?.time_of_day ?? "09:00",
  });
  await queueAndSend(admin, { company, agreement: next, kind: "renewed", dedupeKey: old.id, body, nowMs }, deps.messages);
  return { ok: true, next };
}

/**
 * Put the next term's visits on the series while the renewal is open ("pay now to keep their
 * spring visit"); a lapse takes the untouched ones off again.
 */
export async function addNextTermVisits(admin: AdminClient, company: PlanCompany, agreement: ServiceAgreementRow, nowMs: number): Promise<string[]> {
  if (!agreement.term_end) return [];
  const plan = await loadPlan(admin, scopeOf(company), agreement.plan_id);
  const start = addDays(agreement.term_end, 1);
  const end = termEndFor(start);
  const dates = termVisitDates(scheduleFor(agreement, plan), start, end);
  if (dates.length && agreement.recurring_job_id) await extendSeries(admin, agreement, dates, end, nowMs);
  return dates;
}

// ── Ending ──────────────────────────────────────────────────────────────────

/**
 * Lapsed: the renewal link went out and wasn't paid 14 days after the term ended. Visits after the
 * term that nobody touched come off. Never lapses a plan whose renewal is paid (→ renewed instead)
 * or still clearing (a bank debit / pending payment → wait), and never one whose customer was never
 * sent a renewal link (renewals off, or the owner said no: the term just ends, no "wasn't paid").
 * An issued renewal invoice stays payable for REACTIVATE_DAYS (paying it brings the plan back);
 * an un-numbered online draft is voided (the renewal page makes a fresh one).
 */
export async function lapseAgreement(admin: AdminClient, company: PlanCompany, agreement: ServiceAgreementRow, nowMs: number, deps: PlanDeps = defaultPlanDeps): Promise<{ ok: boolean; removed: number; reason?: string }> {
  if (!agreement.renewal_texted_at) return { ok: false, removed: 0, reason: "no renewal link sent" };
  if (agreement.pending_invoice_id) {
    const state = (await invoiceStates(admin, company.organizationId, [agreement.pending_invoice_id])).get(agreement.pending_invoice_id);
    if (isPaid(state)) {
      await settlePlanInvoice(admin, agreement.pending_invoice_id, nowMs, deps, async () => company);
      return { ok: false, removed: 0, reason: "paid" };
    }
    if (state && state.pendingPaymentCents > 0) return { ok: false, removed: 0, reason: "payment clearing" };
  }
  const { data: claimed } = await (admin as Db)
    .from("service_agreements")
    .update({ status: "lapsed", lapsed_at: new Date(nowMs).toISOString() })
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .eq("id", agreement.id)
    .in("status", ["active", "renewal_due"])
    .select("*");
  const row = ((claimed ?? []) as ServiceAgreementRow[])[0];
  if (!row) return { ok: false, removed: 0 };
  if (row.pending_invoice_id) {
    const state = (await invoiceStates(admin, company.organizationId, [row.pending_invoice_id])).get(row.pending_invoice_id);
    if (state?.status === "draft" && state.amountPaidCents === 0 && state.pendingPaymentCents === 0) {
      await deps.billing.voidUnpaid(admin, company.organizationId, row.pending_invoice_id, "Service plan renewal not paid - plan lapsed.");
      await (admin as Db).from("service_agreements").update({ pending_invoice_id: null }).eq("organization_id", company.organizationId).eq("id", row.id);
    }
  }
  const removed = await endSeries(admin, company, row, nowMs, row.term_end);
  if (company.ownerPhone) {
    const contact = await loadContact(admin, company.organizationId, row.contact_id);
    const off = removed > 0 ? ` I took ${removed} upcoming visit${removed === 1 ? "" : "s"} off the calendar.` : "";
    await deps.ownerSms(admin, {
      to: company.ownerPhone,
      organizationId: company.organizationId,
      companyId: company.companyId,
      platformBrand: company.platformBrand,
      body: `${contactName(contact, row.customer_name)}'s ${row.plan_name} plan lapsed: the renewal wasn't paid by ${longDate(addDays(row.term_end ?? localDate(new Date(nowMs), company.timeZone), 14))}.${off} If they pay in the next ${REACTIVATE_DAYS} days, I'll renew it.`,
    });
  }
  return { ok: true, removed };
}

/** Cancel an open agreement (the owner said no, it was never paid, or the owner cancelled it). */
export async function cancelAgreement(
  admin: AdminClient,
  company: PlanCompany,
  agreement: ServiceAgreementRow,
  reason: string,
  nowMs: number,
  deps: PlanDeps = defaultPlanDeps,
): Promise<{ ok: boolean; removed: number; agreement: ServiceAgreementRow | null }> {
  const { data: claimed } = await (admin as Db)
    .from("service_agreements")
    .update({ status: "cancelled", cancelled_at: new Date(nowMs).toISOString(), cancel_reason: reason.slice(0, 300) })
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .eq("id", agreement.id)
    .in("status", OPEN_STATUSES)
    .select("*");
  const row = ((claimed ?? []) as ServiceAgreementRow[])[0];
  if (!row) return { ok: false, removed: 0, agreement: null };
  if (row.pending_invoice_id) {
    const state = (await invoiceStates(admin, company.organizationId, [row.pending_invoice_id])).get(row.pending_invoice_id);
    if (state && !isPaid(state) && state.status !== "void" && state.amountPaidCents === 0 && state.pendingPaymentCents === 0) {
      await deps.billing.voidUnpaid(admin, company.organizationId, row.pending_invoice_id, `Service plan ${reason}.`);
    }
  }
  const removed = await endSeries(admin, company, row, nowMs, null);
  return { ok: true, removed, agreement: row };
}

/**
 * Stripe Connect webhook hook (src/app/api/webhooks/stripe/connect/route.ts): right after an
 * invoice payment was recorded, start / renew the plan it belongs to. Not a plan invoice → one
 * indexed read, nothing else. Never throws (the payments sweep is the backstop).
 */
export async function onPlanInvoicePayment(admin: AdminClient, invoiceId: string | null, nowMs: number = Date.now()): Promise<void> {
  if (!invoiceId) return;
  await settlePlanInvoice(admin, invoiceId, nowMs);
}

interface CheckoutSessionLike {
  id: string;
  metadata?: Record<string, string> | null;
}

/**
 * Stripe Connect webhook, `checkout.session.completed` for a session WE opened for a plan
 * (metadata.plan_agreement_id): issue the DRAFT term invoice now that it's paid (number + dates,
 * no email), record the payment on it through the ordinary invoice handler (receipt, balance,
 * events), then start / renew the plan. The account the event came from must own the agreement's
 * company and the session must be for the agreement's own pending invoice; anything else is left to
 * the ordinary invoice handler. Idempotent on retries (the payment is keyed by PaymentIntent).
 */
export async function onPlanCheckoutCompleted<S extends CheckoutSessionLike, R>(
  admin: AdminClient,
  session: S,
  accountId: string,
  recordPayment: (session: S) => Promise<R>,
  nowMs: number = Date.now(),
  deps: PlanDeps = defaultPlanDeps,
): Promise<R> {
  const agreementId = session.metadata?.plan_agreement_id ?? "";
  const invoiceId = session.metadata?.invoice_id ?? "";
  try {
    const { data } = agreementId ? await (admin as Db).from("service_agreements").select("*").eq("id", agreementId).maybeSingle() : { data: null };
    const agreement = (data as ServiceAgreementRow | null) ?? null;
    if (agreement && invoiceId && agreement.pending_invoice_id === invoiceId) {
      const { data: owner } = await (admin as Db).from("companies").select("stripe_connected_account_id").eq("organization_id", agreement.organization_id).eq("id", agreement.company_id).maybeSingle();
      if ((owner as { stripe_connected_account_id?: string | null } | null)?.stripe_connected_account_id === accountId) {
        await deps.billing.issueDraft(admin, agreement.organization_id, invoiceId);
      }
    }
  } catch (err) {
    // The payment is still recorded below; an unissued draft is reported by the sweep's log.
    console.error(`[service-plans] issuing plan invoice ${invoiceId} failed:`, err instanceof Error ? err.message : err);
  }
  const result = await recordPayment(session);
  if (invoiceId) await settlePlanInvoice(admin, invoiceId, nowMs, deps);
  return result;
}
