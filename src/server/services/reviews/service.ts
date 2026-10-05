/**
 * Review requests — staff side, under the caller's session (RLS scopes every row to
 * their organization; every query also filters organization_id).
 *
 *  - settings: read / save a brand's review link and options
 *  - scheduling: a job marked done / an invoice paid queues ONE ask (never throws —
 *    completing a job or recording a payment must not fail because of this)
 *  - the Reviews page: list + stats, cancel a queued ask
 *  - the contact page: "Ask for a review" now
 */
import { randomBytes } from "node:crypto";

import { z } from "zod";

import type { Tables } from "@/server/db/database.types";
import { toJson } from "@/server/db/json";
import { isEmailSendConfigured } from "@/server/outbound/email";
import { ValidationError } from "@/server/organizations/context";
import { quotePublicBaseUrlFor } from "@/server/services/quotes/config";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import {
  normalizeReviewUrl,
  parseReviewSettings,
  ReviewRuleError,
  reviewTimeZone,
  reviewSettingsSchema,
  scheduleFor,
  type ReviewSettings,
} from "./rules";
import { sendReviewRequestNow, type ReviewSendOutcome } from "./send";

type Row = Tables<"review_requests">;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

/** Recipes that also ask for reviews — running them alongside this would ask twice. */
export const OVERLAPPING_RECIPES = ["review-request", "invoice-paid-thank-you"];

export class ReviewConflictError extends Error {
  constructor(
    message: string,
    readonly code: "asked_recently" | "already_queued",
  ) {
    super(message);
  }
}
export class ReviewNotFoundError extends Error {}

export function newReviewToken(): string {
  return randomBytes(16).toString("hex");
}

// ── Settings ────────────────────────────────────────────────────────────────

export interface ReviewSettingsView {
  companyId: string;
  companyName: string;
  reviewUrl: string | null;
  settings: ReviewSettings;
  /** Where the tracked links will point, e.g. https://quotes.brand.ca/r/… */
  linkBase: string;
  emailConfigured: boolean;
  overlappingAutomations: Array<{ id: string; name: string; slug: string }>;
}

async function loadCompany(ctx: TenantServiceContext, companyId: string) {
  await assertCompanyInOrganization(ctx, companyId);
  const { data, error } = await ctx.supabase
    .from("companies")
    .select("id, name, brand_review_url, review_settings, quote_public_base_url, timezone")
    .eq("organization_id", ctx.organizationId)
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ValidationError("Company not found.");
  return data;
}

export async function getReviewSettings(ctx: TenantServiceContext, companyId: string): Promise<ReviewSettingsView> {
  const company = await loadCompany(ctx, companyId);
  const { data: flows, error } = await ctx.supabase
    .from("workflows")
    .select("id, name, slug, status, company_id")
    .eq("organization_id", ctx.organizationId)
    .in("slug", OVERLAPPING_RECIPES)
    .eq("status", "active");
  if (error) throw error;
  return {
    companyId,
    companyName: company.name,
    reviewUrl: company.brand_review_url?.trim() || null,
    settings: parseReviewSettings(company.review_settings),
    linkBase: `${quotePublicBaseUrlFor(company)}/r/`,
    emailConfigured: isEmailSendConfigured(),
    overlappingAutomations: (flows ?? [])
      .filter((f: { company_id: string | null }) => !f.company_id || f.company_id === companyId)
      .map((f: { id: string; name: string; slug: string }) => ({ id: f.id, name: f.name, slug: f.slug })),
  };
}

export const updateReviewSettingsSchema = z.object({
  reviewUrl: z.string().max(2000).nullable().optional(),
  settings: reviewSettingsSchema.partial().optional(),
});

export async function updateReviewSettings(
  ctx: TenantServiceContext,
  companyId: string,
  input: z.infer<typeof updateReviewSettingsSchema>,
): Promise<ReviewSettingsView> {
  const company = await loadCompany(ctx, companyId);
  let reviewUrl = company.brand_review_url?.trim() || null;
  if (input.reviewUrl !== undefined) {
    try {
      reviewUrl = normalizeReviewUrl(input.reviewUrl);
    } catch (err) {
      if (err instanceof ReviewRuleError) throw new ValidationError(err.message);
      throw err;
    }
  }
  const current = company.review_settings && typeof company.review_settings === "object" && !Array.isArray(company.review_settings) ? (company.review_settings as Record<string, unknown>) : {};
  const next = { ...current, ...(input.settings ?? {}) };
  const effective = parseReviewSettings(next);
  if (effective.enabled && !reviewUrl) throw new ValidationError("Add your review link before turning review requests on.");

  const { error } = await ctx.supabase
    .from("companies")
    .update({ brand_review_url: reviewUrl, review_settings: toJson(next) })
    .eq("organization_id", ctx.organizationId)
    .eq("id", companyId);
  if (error) throw error;
  return getReviewSettings(ctx, companyId);
}

// ── Scheduling (job done / invoice paid) ────────────────────────────────────

export type ScheduleOutcome = { queued: true; requestId: string; scheduledFor: string } | { queued: false; reason: string };

async function queue(
  db: AnyDb,
  input: {
    organizationId: string;
    companyId: string;
    contactId: string;
    source: "job_done" | "invoice_paid";
    bookingId?: string | null;
    invoiceId?: string | null;
    eventAt: string;
    actorProfileId: string | null;
  },
): Promise<ScheduleOutcome> {
  const { data: company, error } = await db
    .from("companies")
    .select("id, review_settings, brand_review_url, timezone")
    .eq("organization_id", input.organizationId)
    .eq("id", input.companyId)
    .maybeSingle();
  if (error) throw error;
  if (!company) return { queued: false, reason: "company not found" };
  const settings = parseReviewSettings(company.review_settings);
  if (!settings.enabled) return { queued: false, reason: "review requests are off" };
  if (settings.trigger !== input.source) return { queued: false, reason: `asks are sent on ${settings.trigger}` };

  // One queued ask per customer at a time (two jobs done the same day → one text).
  const { data: pending, error: e2 } = await db
    .from("review_requests")
    .select("id")
    .eq("organization_id", input.organizationId)
    .eq("company_id", input.companyId)
    .eq("contact_id", input.contactId)
    .in("status", ["scheduled", "sending"])
    .limit(1);
  if (e2) throw e2;
  if ((pending ?? []).length) return { queued: false, reason: "an ask is already queued for this customer" };

  const eventMs = Number.isFinite(Date.parse(input.eventAt)) ? Date.parse(input.eventAt) : Date.now();
  const scheduledFor = new Date(scheduleFor(eventMs, settings, reviewTimeZone(company))).toISOString();
  const { data: inserted, error: e3 } = await db
    .from("review_requests")
    .insert({
      organization_id: input.organizationId,
      company_id: input.companyId,
      contact_id: input.contactId,
      booking_id: input.bookingId ?? null,
      invoice_id: input.invoiceId ?? null,
      source: input.source,
      status: "scheduled",
      scheduled_for: scheduledFor,
      token: newReviewToken(),
      created_by: input.actorProfileId,
    })
    .select("id")
    .single();
  if (e3) {
    if (e3.code === "23505") return { queued: false, reason: "already asked for this job" };
    throw e3;
  }
  return { queued: true, requestId: inserted.id, scheduledFor };
}

/** Job marked done → queue an ask (when the brand asks on job done). Never throws. */
export async function scheduleReviewForCompletedBooking(
  ctx: TenantServiceContext,
  booking: Pick<Tables<"bookings">, "id" | "company_id" | "contact_id"> & { completed_at?: string | null },
): Promise<ScheduleOutcome> {
  try {
    if (!booking.company_id || !booking.contact_id) return { queued: false, reason: "no customer on the job" };
    return await queue(ctx.supabase, {
      organizationId: ctx.organizationId,
      companyId: booking.company_id,
      contactId: booking.contact_id,
      source: "job_done",
      bookingId: booking.id,
      eventAt: booking.completed_at ?? new Date().toISOString(),
      actorProfileId: ctx.actorProfileId,
    });
  } catch (err) {
    console.error("[reviews] could not queue a review request for the job:", err instanceof Error ? err.message : err);
    return { queued: false, reason: "error" };
  }
}

/**
 * Invoice paid → queue an ask (when the brand asks on payment). Never throws. `db` is
 * whatever client marked the invoice paid (staff session or the Stripe webhook's).
 */
export async function scheduleReviewForPaidInvoice(
  db: AnyDb,
  invoice: Pick<Tables<"invoices">, "id" | "organization_id" | "company_id" | "contact_id"> & { paid_at?: string | null },
): Promise<ScheduleOutcome> {
  try {
    if (!invoice.contact_id) return { queued: false, reason: "no customer on the invoice" };
    return await queue(db, {
      organizationId: invoice.organization_id,
      companyId: invoice.company_id,
      contactId: invoice.contact_id,
      source: "invoice_paid",
      invoiceId: invoice.id,
      eventAt: invoice.paid_at ?? new Date().toISOString(),
      actorProfileId: null,
    });
  } catch (err) {
    console.error("[reviews] could not queue a review request for the invoice:", err instanceof Error ? err.message : err);
    return { queued: false, reason: "error" };
  }
}

// ── Reviews page ────────────────────────────────────────────────────────────

export interface ReviewRequestView {
  id: string;
  contactId: string;
  customerName: string;
  jobTitle: string | null;
  source: Row["source"];
  status: Row["status"];
  channel: Row["channel"];
  scheduledFor: string;
  sentAt: string | null;
  clickedAt: string | null;
  clickCount: number;
  reason: string | null;
}

export interface ReviewRequestList {
  requests: ReviewRequestView[];
  stats: { sent: number; clicked: number; clickRate: number | null; queued: number; skipped: number };
}

export const listQuerySchema = z.object({
  companyId: z.string().uuid().nullish(),
  days: z.coerce.number().int().min(1).max(730).default(90),
  status: z.enum(["scheduled", "sent", "skipped", "failed", "cancelled"]).nullish(),
});

export async function listReviewRequests(ctx: TenantServiceContext, q: z.infer<typeof listQuerySchema>): Promise<ReviewRequestList> {
  const since = new Date(Date.now() - q.days * 86_400_000).toISOString();
  let query = ctx.supabase.from("review_requests").select("*").eq("organization_id", ctx.organizationId).gte("created_at", since);
  if (q.companyId) query = query.eq("company_id", q.companyId);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(1000);
  if (error) throw error;
  const rows = (data ?? []) as Row[];

  const contactIds = [...new Set(rows.map((r) => r.contact_id))];
  const bookingIds = [...new Set(rows.map((r) => r.booking_id).filter((v): v is string => !!v))];
  const [contacts, bookings] = await Promise.all([
    contactIds.length
      ? ctx.supabase.from("contacts").select("id, first_name, last_name").eq("organization_id", ctx.organizationId).in("id", contactIds.slice(0, 1000))
      : Promise.resolve({ data: [], error: null }),
    bookingIds.length
      ? ctx.supabase.from("bookings").select("id, title").eq("organization_id", ctx.organizationId).in("id", bookingIds.slice(0, 1000))
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (contacts.error) throw contacts.error;
  if (bookings.error) throw bookings.error;
  const names = new Map((contacts.data ?? []).map((c: { id: string; first_name: string | null; last_name: string | null }) => [c.id, [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || "Customer"]));
  const titles = new Map((bookings.data ?? []).map((b: { id: string; title: string }) => [b.id, b.title]));

  const sent = rows.filter((r) => r.status === "sent");
  const clicked = sent.filter((r) => r.click_count > 0).length;
  const stats = {
    sent: sent.length,
    clicked,
    clickRate: sent.length ? clicked / sent.length : null,
    queued: rows.filter((r) => r.status === "scheduled" || r.status === "sending").length,
    skipped: rows.filter((r) => r.status === "skipped" || r.status === "failed").length,
  };
  const visible = q.status ? rows.filter((r) => (q.status === "scheduled" ? r.status === "scheduled" || r.status === "sending" : r.status === q.status)) : rows;
  return {
    stats,
    requests: visible.slice(0, 300).map((r) => ({
      id: r.id,
      contactId: r.contact_id,
      customerName: names.get(r.contact_id) ?? "Customer",
      jobTitle: r.booking_id ? (titles.get(r.booking_id) ?? null) : null,
      source: r.source,
      status: r.status,
      channel: r.channel,
      scheduledFor: r.scheduled_for,
      sentAt: r.sent_at,
      clickedAt: r.clicked_at,
      clickCount: r.click_count,
      reason: r.reason,
    })),
  };
}

/** Don't send a queued ask. */
export async function cancelReviewRequest(ctx: TenantServiceContext, requestId: string): Promise<void> {
  const { data, error } = await ctx.supabase
    .from("review_requests")
    .update({ status: "cancelled", reason: "Cancelled before it went out.", updated_at: new Date().toISOString() })
    .eq("organization_id", ctx.organizationId)
    .eq("id", requestId)
    .eq("status", "scheduled")
    .select("id");
  if (error) throw error;
  if (!(data ?? []).length) throw new ReviewNotFoundError("That request isn't waiting to go out any more.");
}

// ── Contact page ────────────────────────────────────────────────────────────

export interface ContactReviewStatus {
  reviewUrlSet: boolean;
  last: { status: Row["status"]; sentAt: string | null; scheduledFor: string; clickedAt: string | null; channel: Row["channel"]; reason: string | null } | null;
}

async function contactRow(ctx: TenantServiceContext, contactId: string) {
  const { data, error } = await ctx.supabase.from("contacts").select("id, company_id").eq("organization_id", ctx.organizationId).eq("id", contactId).maybeSingle();
  if (error) throw error;
  if (!data) throw new ReviewNotFoundError("Contact not found.");
  return data as { id: string; company_id: string };
}

export async function contactReviewStatus(ctx: TenantServiceContext, contactId: string): Promise<ContactReviewStatus> {
  const contact = await contactRow(ctx, contactId);
  const [{ data: company }, { data: last, error }] = await Promise.all([
    ctx.supabase.from("companies").select("brand_review_url").eq("organization_id", ctx.organizationId).eq("id", contact.company_id).maybeSingle(),
    ctx.supabase
      .from("review_requests")
      .select("status, sent_at, scheduled_for, clicked_at, channel, reason")
      .eq("organization_id", ctx.organizationId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);
  if (error) throw error;
  const l = (last ?? [])[0] as Row | undefined;
  return {
    reviewUrlSet: Boolean(company?.brand_review_url?.trim()),
    last: l ? { status: l.status, sentAt: l.sent_at, scheduledFor: l.scheduled_for, clickedAt: l.clicked_at, channel: l.channel, reason: l.reason } : null,
  };
}

export const askSchema = z.object({
  channel: z.enum(["sms", "email"]).nullish(),
  /** Send even though this customer was asked inside the cooldown. */
  force: z.boolean().optional(),
});

/** "Ask for a review" now, by hand. */
export async function askForReview(ctx: TenantServiceContext, contactId: string, input: z.infer<typeof askSchema>): Promise<ReviewSendOutcome> {
  const contact = await contactRow(ctx, contactId);
  const company = await loadCompany(ctx, contact.company_id);
  if (!company.brand_review_url?.trim()) throw new ValidationError("Add your review link first (Settings → Reviews).");
  const settings = parseReviewSettings(company.review_settings);

  const { data: open } = await ctx.supabase
    .from("review_requests")
    .select("id")
    .eq("organization_id", ctx.organizationId)
    .eq("contact_id", contactId)
    .eq("status", "sending")
    .limit(1);
  if ((open ?? []).length) throw new ReviewConflictError("A review request to this customer is going out right now.", "already_queued");

  if (!input.force && settings.cooldownDays > 0) {
    const since = new Date(Date.now() - settings.cooldownDays * 86_400_000).toISOString();
    const { data: recent, error } = await ctx.supabase
      .from("review_requests")
      .select("sent_at")
      .eq("organization_id", ctx.organizationId)
      .eq("contact_id", contactId)
      .eq("status", "sent")
      .gte("sent_at", since)
      .order("sent_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    if ((recent ?? []).length) {
      const when = new Date((recent![0] as { sent_at: string }).sent_at).toLocaleDateString("en-CA", { month: "short", day: "numeric" });
      throw new ReviewConflictError(`This customer was already asked on ${when}.`, "asked_recently");
    }
  }

  // A manual ask replaces any automatic one still waiting, so they aren't asked twice.
  await ctx.supabase
    .from("review_requests")
    .update({ status: "cancelled", reason: "Replaced by a request sent by hand.", updated_at: new Date().toISOString() })
    .eq("organization_id", ctx.organizationId)
    .eq("contact_id", contactId)
    .eq("status", "scheduled");

  const { data: inserted, error } = await ctx.supabase
    .from("review_requests")
    .insert({
      organization_id: ctx.organizationId,
      company_id: contact.company_id,
      contact_id: contactId,
      source: "manual",
      status: "scheduled",
      scheduled_for: new Date().toISOString(),
      token: newReviewToken(),
      created_by: ctx.actorProfileId,
    })
    .select("id")
    .single();
  if (error) throw error;
  return sendReviewRequestNow(ctx, inserted.id, input.channel ?? null);
}
