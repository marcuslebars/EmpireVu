import { randomBytes } from "node:crypto";

import type { Json } from "@/server/db/database.types";
import { createActivityEvent } from "@/server/services/activity-events";
import { getBusinessTimezone } from "@/server/services/ai";
import { createBooking } from "@/server/services/bookings";
import {
  isValidDateString,
  parseBookingPolicy,
  zonedInstant,
  type BookingPolicy,
} from "@/server/services/booking-windows";
import { createContact } from "@/server/services/contacts";
import type { TenantServiceContext } from "@/server/services/shared";
// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION: this is the ONE request path allowed to use the Supabase
// service-role (RLS-bypassing) client, approved as a named exception to the
// "no service-role in request paths" rule. It is confined to this module. Every
// write below is pinned to the SERVER-resolved A1 org/company — nothing in the
// request payload can choose which org or company is written. No other route may
// import createSupabaseAdminClient.
// ─────────────────────────────────────────────────────────────────────────────
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { parseLeadEnvelope, type LeadEnvelope } from "./envelope";
import { normalizeEmail, normalizePhoneLast10 } from "./matching";
import { leadNotifyAudience, sendLeadNotification, type LeadNotifyAudience, type ReturningInfo } from "./notify";
import { companySlugForSourceSite, LEAD_INTAKE_ORG_SLUG } from "./routing";
import { maybeAutoQuoteLead } from "@/server/services/quotes/auto-quote";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
type AsRecord = Record<string, unknown>;

export interface IntakeResult {
  ok: true;
  leadId: string;
  /**
   * The customer-facing quote link, present only when this lead was
   * auto-quoted.
   *
   * Returned so the SPOKE can offer "pay your deposit" on its own confirmation
   * screen instead of promising an email that may not have been sent. It is a
   * public, single-purpose token URL — the same one that goes in the email —
   * and it is safe to hand back to the browser that just submitted the lead,
   * because that browser is the customer whose quote it is.
   *
   * Absent whenever no quote was created, which is most leads. A spoke must
   * treat it as optional and fall back to its existing copy.
   */
  quoteUrl?: string;
}

function genLeadId(): string {
  return `lead_${randomBytes(8).toString("hex")}`;
}

function splitName(name?: string): { firstName: string; lastName: string | null } {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return { firstName: "Lead", lastName: null };
  const parts = trimmed.split(/\s+/);
  return { firstName: parts[0], lastName: parts.length > 1 ? parts.slice(1).join(" ") : null };
}

export interface PlannedLeadBooking {
  scheduledFor: string;
  windowKey: string | null;
  durationMinutes?: number;
}

/**
 * PURE — where a web-form booking lands on the calendar.
 *
 * The form sends a LOCAL date + time ("2026-10-13", "13:00"). It used to be parsed as
 * `new Date("2026-10-13T13:00")`, which a UTC server reads as 13:00 UTC — 9am in
 * Toronto, in no window — so every web booking showed up in the wrong half-day and the
 * real slot looked free. Now the time is read in the company's zone and, for a company
 * that books by window, snapped to the window it falls in (the latest window starting
 * at or before the time; an earlier time takes the first window), matching how
 * Marina's own and imported bookings are stored.
 */
export function planLeadBooking(
  date: string | undefined,
  time: string | undefined,
  policy: BookingPolicy | null,
  timeZone: string,
): PlannedLeadBooking | null {
  if (!date || !isValidDateString(date)) return null;
  const hhmm = time && /^\d{1,2}:\d{2}$/.test(time.trim()) ? time.trim().padStart(5, "0") : null;
  if (policy && policy.windows.length) {
    const windows = [...policy.windows].sort((a, b) => a.start.localeCompare(b.start));
    const w = (hhmm && [...windows].reverse().find((x) => x.start <= hhmm)) || windows[0];
    return { scheduledFor: zonedInstant(date, w.start, timeZone).toISOString(), windowKey: w.key, durationMinutes: w.durationMinutes };
  }
  return { scheduledFor: zonedInstant(date, hhmm ?? "09:00", timeZone).toISOString(), windowKey: null };
}

/** Resolve the target org + company SERVER-SIDE. The payload cannot influence this. */
async function resolveTarget(
  admin: AdminClient,
  sourceSite: string | null,
): Promise<{ orgId: string | null; companyId: string | null; companyName: string | null }> {
  const { data: org } = await admin
    .from("organizations")
    .select("id")
    .eq("slug", LEAD_INTAKE_ORG_SLUG)
    .maybeSingle();
  const orgId = org?.id ?? null;
  if (!orgId || !sourceSite) return { orgId, companyId: null, companyName: null };

  const slug = companySlugForSourceSite(sourceSite);
  if (!slug) return { orgId, companyId: null, companyName: null };

  const { data: company } = await admin
    .from("companies")
    .select("id, name")
    .eq("organization_id", orgId)
    .eq("slug", slug)
    .maybeSingle();
  return { orgId, companyId: company?.id ?? null, companyName: company?.name ?? null };
}

/**
 * Key-mode target (Task 7): the tenant is pinned by the intake key / voice number, so the
 * payload's sourceSite is NOT consulted for routing (it stays a free-text tag). Only the
 * company name is looked up, for the notification.
 */
async function resolvePinnedTarget(
  admin: AdminClient,
  target: { organizationId: string; companyId: string | null },
): Promise<{ orgId: string | null; companyId: string | null; companyName: string | null }> {
  if (!target.companyId) {
    return { orgId: target.organizationId, companyId: null, companyName: null };
  }
  const { data } = await admin
    .from("companies")
    .select("name")
    .eq("organization_id", target.organizationId)
    .eq("id", target.companyId)
    .maybeSingle();
  return {
    orgId: target.organizationId,
    companyId: target.companyId,
    companyName: (data as { name: string } | null)?.name ?? null,
  };
}

async function insertRawLead(
  admin: AdminClient,
  row: {
    leadId: string;
    orgId: string | null;
    companyId: string | null;
    source: string | null;
    sourceSite: string | null;
    formType: string | null;
    schemaVersion: number | null;
    schemaValid: boolean;
    rawPayload: Json;
    receivedAt: string | null;
  },
): Promise<void> {
  const { error } = await admin.from("raw_leads").insert({
    lead_id: row.leadId,
    organization_id: row.orgId,
    company_id: row.companyId,
    source: row.source,
    source_site: row.sourceSite,
    form_type: row.formType,
    schema_version: row.schemaVersion,
    schema_valid: row.schemaValid,
    needs_attention: !row.schemaValid,
    raw_payload: row.rawPayload,
    received_at: row.receivedAt,
  });
  if (error) throw error;
}

/** Match on normalized email OR phone-last-10, scoped to the lead's brand (company).
 *  Leads are attributed to the brand whose form they came from, so the same person
 *  is a separate contact under each brand they contact. */
async function findExistingContact(
  admin: AdminClient,
  orgId: string,
  companyId: string,
  contact: { email?: string; phone?: string },
): Promise<{ id: string; company_id: string | null; phone: string | null } | null> {
  const email = normalizeEmail(contact.email);
  const phone10 = normalizePhoneLast10(contact.phone);

  if (email) {
    const { data } = await admin
      .from("contacts")
      .select("id, company_id, phone")
      .eq("organization_id", orgId)
      .eq("company_id", companyId)
      .eq("email", email)
      .limit(1);
    if (data && data[0]) return { id: data[0].id, company_id: data[0].company_id, phone: data[0].phone ?? null };
  }

  if (phone10) {
    // Compare last-10 in code (phone formats vary). Bounded fetch; add a normalized
    // phone column + index if the contact volume grows large.
    const { data } = await admin
      .from("contacts")
      .select("id, company_id, phone")
      .eq("organization_id", orgId)
      .eq("company_id", companyId)
      .not("phone", "is", null)
      .limit(2000);
    const hit = (data ?? []).find((c) => normalizePhoneLast10(c.phone) === phone10);
    if (hit) return { id: hit.id, company_id: hit.company_id, phone: hit.phone ?? null };
  }

  return null;
}

/** Names of OTHER brands (companies) in the org where this same email/phone already
 *  exists — a cross-brand overlap flag, without merging the per-brand contacts. */
async function findCrossBrandBrands(
  admin: AdminClient,
  orgId: string,
  companyId: string,
  contact: { email?: string; phone?: string },
): Promise<string[]> {
  const email = normalizeEmail(contact.email);
  const phone10 = normalizePhoneLast10(contact.phone);
  const otherCompanyIds = new Set<string>();

  if (email) {
    const { data } = await admin
      .from("contacts")
      .select("company_id")
      .eq("organization_id", orgId)
      .eq("email", email);
    for (const c of data ?? []) {
      if (c.company_id && c.company_id !== companyId) otherCompanyIds.add(c.company_id);
    }
  }

  if (phone10) {
    const { data } = await admin
      .from("contacts")
      .select("company_id, phone")
      .eq("organization_id", orgId)
      .not("phone", "is", null)
      .limit(2000);
    for (const c of data ?? []) {
      if (c.company_id && c.company_id !== companyId && normalizePhoneLast10(c.phone) === phone10) {
        otherCompanyIds.add(c.company_id);
      }
    }
  }

  if (otherCompanyIds.size === 0) return [];

  const { data: companies } = await admin
    .from("companies")
    .select("id, name")
    .eq("organization_id", orgId)
    .in("id", [...otherCompanyIds]);
  return (companies ?? []).map((c) => c.name as string);
}

/** Prior lead touches for this contact within its own brand (returning-customer info). */
async function buildReturning(
  admin: AdminClient,
  orgId: string,
  contactId: string,
): Promise<ReturningInfo> {
  const { data } = await admin
    .from("activity_events")
    .select("event_type, occurred_at, metadata_json")
    .eq("organization_id", orgId)
    .eq("entity_id", contactId)
    .like("event_type", "lead.%")
    .order("occurred_at", { ascending: false })
    .limit(10);

  const priors = data ?? [];
  const summaries = priors.map((e) => {
    const meta = (e.metadata_json ?? {}) as AsRecord;
    const brand = typeof meta.sourceSite === "string" ? meta.sourceSite : "?";
    const type = e.event_type.replace("lead.", "");
    return `${brand} ${type} (${(e.occurred_at ?? "").slice(0, 10)})`;
  });
  return { priorCount: priors.length, priorSummaries: summaries };
}

/** Parse a valid envelope into contacts + activity (+ booking). Best-effort. */
async function parseIntoRecords(
  admin: AdminClient,
  args: {
    orgId: string;
    companyId: string;
    envelope: LeadEnvelope;
    leadId: string;
    workflowTrigger?: HandleLeadIntakeOptions["workflowTrigger"];
  },
): Promise<{ contactId: string; matched: boolean; returning: ReturningInfo | null; crossBrandBrands: string[] }> {
  const { orgId, companyId, envelope, leadId, workflowTrigger } = args;
  // Express consent only when the form captured an explicit opt-in (website forms);
  // every other path keeps recording the inquiry as implied consent, unchanged.
  const expressConsent = envelope.meta?.smsConsent?.granted === true;
  const consentSource = expressConsent ? "express_optin" : "implied_inquiry";
  const consentAt = envelope.meta?.smsConsent?.capturedAt ?? envelope.receivedAt ?? new Date().toISOString();
  const ctx: TenantServiceContext = {
    organizationId: orgId,
    actorProfileId: null,
    supabase: admin,
  };

  // Match only within THIS brand (the form's company); the same person can be a
  // separate contact per brand. Cross-brand overlap is surfaced as a flag, not a merge.
  const existing = await findExistingContact(admin, orgId, companyId, envelope.contact);
  const crossBrandBrands = await findCrossBrandBrands(admin, orgId, companyId, envelope.contact);

  let contactId: string;
  let matched = false;
  let returning: ReturningInfo | null = null;

  // Express consent attaches to a matched contact ONLY when it is about that contact's
  // phone: the submitted number equals the contact's (last 10), or the contact has no
  // phone yet (we set it). A match by email with a different number never grants express
  // consent — the opt-in stays on the raw lead / activity as evidence only.
  let expressApplied = expressConsent;
  let fillPhone = false;
  if (existing && expressConsent) {
    const submitted10 = normalizePhoneLast10(envelope.contact.phone);
    const existing10 = normalizePhoneLast10(existing.phone);
    if (!existing10 && submitted10) {
      fillPhone = true;
    } else if (!submitted10 || existing10 !== submitted10) {
      expressApplied = false;
    }
  }
  const matchedConsentSource = expressApplied ? consentSource : "implied_inquiry";

  if (existing) {
    matched = true;
    contactId = existing.id;
    if (fillPhone && envelope.contact.phone) {
      const { error: phoneError } = await admin
        .from("contacts")
        .update({ phone: envelope.contact.phone })
        .eq("organization_id", orgId)
        .eq("company_id", companyId)
        .eq("id", contactId)
        .is("phone", null);
      if (phoneError) throw phoneError;
    }
    // A manually added contact may have no inquiry consent yet. Record this new
    // inquiry just as we do for a new contact, without replacing prior consent or
    // clearing an SMS opt-out. The predicates also protect a concurrent opt-out.
    const { error } = await admin
      .from("contacts")
      .update({
        sms_consent_at: expressApplied ? consentAt : envelope.receivedAt ?? new Date().toISOString(),
        consent_source: matchedConsentSource,
      })
      .eq("organization_id", orgId)
      .eq("company_id", companyId)
      .eq("id", contactId)
      .is("sms_consent_at", null)
      .is("consent_source", null)
      .is("sms_opt_out_at", null);
    if (error) throw error;
    if (expressApplied) {
      // An explicit opt-in upgrades a prior IMPLIED consent to express. It never
      // touches an opted-out contact, and never rewrites an existing express record.
      const { error: upgradeError } = await admin
        .from("contacts")
        .update({ sms_consent_at: consentAt, consent_source: consentSource })
        .eq("organization_id", orgId)
        .eq("company_id", companyId)
        .eq("id", contactId)
        .eq("consent_source", "implied_inquiry")
        .is("sms_opt_out_at", null);
      if (upgradeError) throw upgradeError;
    }
    returning = await buildReturning(admin, orgId, contactId);
  } else {
    const { firstName, lastName } = splitName(envelope.contact.name);
    const created = await createContact(
      ctx,
      {
        companyId,
        firstName,
        lastName,
        email: envelope.contact.email ?? null,
        phone: envelope.contact.phone ?? null,
        notes: envelope.message ?? null,
        // Implied consent (Task 8): the lead initiated contact via this inquiry (CASL).
        // A ticked opt-in checkbox on a website form records express consent instead.
        smsConsentAt: expressConsent ? consentAt : envelope.receivedAt ?? new Date().toISOString(),
        consentSource,
        metadata: {
          source: envelope.source,
          sourceSite: envelope.sourceSite,
          formType: envelope.formType,
          asset: envelope.asset ?? null,
          meta: envelope.meta ?? null,
        },
      },
      // Spokes/phone leads: no workflow dispatch (the intake notifies directly). Website
      // forms opt in via `workflowTrigger`, and the contact.created event is stamped with
      // the unauthenticated source so the Task 5 paid-action guard throttles it.
      workflowTrigger
        ? {
            dispatchWorkflow: true,
            eventMetadata: {
              source: workflowTrigger.source,
              ...(workflowTrigger.paidActionsVerified === undefined
                ? {}
                : { paidActionsVerified: workflowTrigger.paidActionsVerified }),
            },
          }
        : { dispatchWorkflow: false },
    );
    contactId = created.id;
  }

  // The contact is always in this lead's company (matched within-brand or newly
  // created here), so activity + bookings scope cleanly to `companyId`.
  // Record the lead touch (for both new and returning contacts).
  await createActivityEvent(ctx, {
    companyId,
    entityType: "contact",
    entityId: contactId,
    eventType: `lead.${envelope.formType}`,
    metadata: {
      leadId,
      source: envelope.source,
      sourceSite: envelope.sourceSite,
      formType: envelope.formType,
      message: envelope.message ?? null,
      lineItems: envelope.lineItems ?? null,
      asset: envelope.asset ?? null,
      matched,
      crossBrandBrands,
      ...(envelope.meta?.smsConsent
        ? {
            smsConsent: envelope.meta.smsConsent,
            // Whether the opt-in was recorded on the contact (false = a matched contact
            // whose phone differs from the submitted one; evidence kept here only).
            smsConsentApplied: expressApplied,
            ...(expressConsent && !expressApplied ? { smsConsentPhone: envelope.contact.phone ?? null } : {}),
          }
        : {}),
      ...(workflowTrigger?.paidActionsVerified === false
        ? { paidActionsSkipped: "bot_check_unverified" }
        : {}),
    },
    occurredAt: envelope.receivedAt,
  });

  if (envelope.formType === "booking") {
    const { data: company } = await ctx.supabase
      .from("companies")
      .select("timezone, booking_policy")
      .eq("id", companyId)
      .maybeSingle();
    const timeZone = (company as { timezone?: string | null } | null)?.timezone || getBusinessTimezone();
    const policy = parseBookingPolicy((company as { booking_policy?: unknown } | null)?.booking_policy ?? null);
    const planned = planLeadBooking(envelope.meta?.preferredDate, envelope.meta?.preferredTime, policy, timeZone);
    if (planned) {
      // A double-submitted form (or one already on the calendar) must not take a second slot.
      const { data: existing } = await ctx.supabase
        .from("bookings")
        .select("id")
        .eq("organization_id", ctx.organizationId)
        .eq("company_id", companyId)
        .eq("contact_id", contactId)
        .eq("scheduled_for", planned.scheduledFor)
        .neq("status", "cancelled")
        .limit(1);
      if (!((existing ?? []) as unknown[]).length) {
        await createBooking(
          ctx,
          {
            companyId,
            contactId,
            title: `Lead booking — ${envelope.source}`,
            description: envelope.message ?? null,
            scheduledFor: planned.scheduledFor,
            windowKey: planned.windowKey,
            ...(planned.durationMinutes ? { durationMinutes: planned.durationMinutes } : {}),
          },
          { dispatchWorkflow: false },
        );
      }
    }
  }

  return { contactId, matched, returning, crossBrandBrands };
}

/**
 * Handle an authenticated lead intake. Never drops a lead:
 *   1) write raw_leads (durable) FIRST — a throw here fails the request (no false success);
 *   2) parse valid envelopes into contacts/activity/bookings — errors degrade, lead is kept;
 *   3) notify — best-effort, never fails the request.
 */
export interface HandleLeadIntakeOptions {
  /**
   * When set (key mode / voice number), the tenant is pinned by the caller and the
   * payload's sourceSite is NOT used for routing — only stored as a tag. When omitted
   * (legacy HMAC mode), the org/company are resolved from sourceSite as before.
   */
  target?: { organizationId: string; companyId: string | null };
  /**
   * Opt-in (website forms only): dispatch `contact.created` for a NEW contact so the
   * tenant's automations (new-lead owner alert, instant reply) run, stamping the event
   * with `source` (e.g. "public_form") so the paid-action guard treats it as
   * unauthenticated-sourced. Omitted = unchanged behavior (no dispatch) for every
   * existing caller — the A1 spokes, Retell/Telnyx phone leads, the onboarding test lead.
   */
  workflowTrigger?: {
    source: string;
    /**
     * False when the submission's bot check did not actually verify (Turnstile unset or
     * degraded): the lead + owner alert still happen, but the paid-action guard refuses
     * customer-facing paid actions (send_sms / call_lead) for this trigger.
     */
    paidActionsVerified?: boolean;
  };
}

export async function handleLeadIntake(
  rawBody: string,
  parsedBody: unknown,
  options: HandleLeadIntakeOptions = {},
): Promise<IntakeResult> {
  const leadId = genLeadId();
  // Set only if the lead is auto-quoted; returned to the spoke so it can offer
  // payment on its own confirmation screen.
  let quoteUrl: string | undefined;
  const admin = createSupabaseAdminClient();

  const parse = parseLeadEnvelope(parsedBody);
  const envelope = parse.envelope;

  const bodyRecord = (parsedBody && typeof parsedBody === "object" ? parsedBody : null) as AsRecord | null;
  const schemaVersion = typeof bodyRecord?.schemaVersion === "number" ? bodyRecord.schemaVersion : null;
  const rawPayload = (bodyRecord ?? { _unparseable: rawBody }) as Json;

  const { orgId, companyId, companyName } = options.target
    ? await resolvePinnedTarget(admin, options.target)
    : await resolveTarget(admin, envelope?.sourceSite ?? null);

  // (1) DURABLE-FIRST. If this throws, the caller returns 500 — we never confirm
  // success without a durable record.
  await insertRawLead(admin, {
    leadId,
    orgId,
    companyId,
    source: envelope?.source ?? null,
    sourceSite: envelope?.sourceSite ?? null,
    formType: envelope?.formType ?? null,
    schemaVersion,
    schemaValid: parse.valid,
    rawPayload,
    receivedAt: envelope?.receivedAt ?? null,
  });

  // (2) Enrichment — never fails the request.
  let returning: ReturningInfo | null = null;
  let crossBrandBrands: string[] = [];
  if (parse.valid && envelope && orgId && companyId) {
    try {
      const enriched = await parseIntoRecords(admin, {
        orgId,
        companyId,
        envelope,
        leadId,
        workflowTrigger: options.workflowTrigger,
      });
      returning = enriched.returning;
      crossBrandBrands = enriched.crossBrandBrands;
      // Urgent phone-leads (Retell post-call analysis) stay flagged for attention even on
      // a clean enrichment, so they surface in the needs-attention queue for an immediate
      // callback. Only phone-leads set meta.urgent — every other spoke leaves it undefined,
      // so this clears to false exactly as before.
      const urgent = envelope.meta?.urgent === true;
      await admin
        .from("raw_leads")
        .update({ contact_id: enriched.contactId, matched: enriched.matched, needs_attention: urgent })
        .eq("lead_id", leadId);
      // Additive: Phase 5 self-serve. If the lead qualifies, create and send a
      // real quote so the customer can approve and pay a deposit without waiting
      // for a callback. Gated by SELF_SERVE_QUOTES_ENABLED on top of the quotes
      // flag, and NEVER THROWS — a lead that cannot be auto-quoted is a normal
      // lead, handled exactly as it is today.
      const auto = await maybeAutoQuoteLead(envelope, {
        organizationId: orgId,
        companyId,
        contactId: enriched.contactId,
        leadId,
      });
      // Handed back to the spoke so it can show a pay button. Only set when a
      // quote actually exists and is payable.
      if (auto.created && auto.quoteUrl) quoteUrl = auto.quoteUrl;
    } catch (err) {
      console.error("[intake] enrichment failed (lead kept in raw_leads):", err);
      // Enrichment failed after the durable write — flag for attention so the lead
      // isn't left looking processed (contact_id stays null).
      try {
        await admin.from("raw_leads").update({ needs_attention: true }).eq("lead_id", leadId);
      } catch (flagErr) {
        console.error("[intake] failed to flag needs_attention after enrichment error:", flagErr);
      }
    }
  } else if (parse.valid) {
    // Valid envelope but org/company unresolved (unknown brand or unseeded company).
    // Keep it raw and flag for attention so it is not silently unrouted.
    try {
      await admin.from("raw_leads").update({ needs_attention: true }).eq("lead_id", leadId);
    } catch (err) {
      console.error("[intake] flagging unrouted lead failed:", err);
    }
  }

  // (3) Notify the operator — best-effort, house orgs only. A CrankLeads org's lead (customer
  //     name / phone / email) never goes to the platform mailbox; its owner gets the org's own
  //     new-lead alert. Fail closed: if we can't tell whose org it is, don't send.
  let audience: LeadNotifyAudience = "none";
  try {
    if (orgId) {
      const { data: orgRow, error: orgError } = await admin.from("organizations").select("platform_brand, crankleads_tier").eq("id", orgId).maybeSingle();
      if (orgError) throw orgError;
      audience = leadNotifyAudience((orgRow as { platform_brand: string | null; crankleads_tier: string | null } | null) ?? null, true);
    } else {
      audience = leadNotifyAudience(null, false);
    }
  } catch (err) {
    console.error("[intake] org brand lookup failed — operator lead copy skipped:", err instanceof Error ? err.message : err);
  }
  if (audience === "operator") {
    try {
      await sendLeadNotification({
        leadId,
        source: envelope?.source ?? null,
        sourceSite: envelope?.sourceSite ?? null,
        formType: envelope?.formType ?? null,
        schemaValid: parse.valid,
        companyName,
        contact: envelope?.contact ?? {},
        message: envelope?.message ?? null,
        lineItems: envelope?.lineItems ?? null,
        returning,
        crossBrandBrands,
        urgent: envelope?.meta?.urgent === true,
      });
    } catch (err) {
      console.error("[intake] notification failed:", err);
    }
  }

  return quoteUrl ? { ok: true, leadId, quoteUrl } : { ok: true, leadId };
}
