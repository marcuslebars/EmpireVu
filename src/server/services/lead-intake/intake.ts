import { randomBytes } from "node:crypto";

import type { Json } from "@/server/db/database.types";
import { createActivityEvent } from "@/server/services/activity-events";
import { createBooking } from "@/server/services/bookings";
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
import { sendLeadNotification, type ReturningInfo } from "./notify";
import { companySlugForSourceSite, LEAD_INTAKE_ORG_SLUG } from "./routing";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
type AsRecord = Record<string, unknown>;

export interface IntakeResult {
  ok: true;
  leadId: string;
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

function parsePreferredDate(date?: string, time?: string): string | null {
  if (!date) return null;
  const d = new Date(time ? `${date}T${time}` : date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
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

/** Org-wide match on normalized email OR phone-last-10. */
async function findExistingContact(
  admin: AdminClient,
  orgId: string,
  contact: { email?: string; phone?: string },
): Promise<{ id: string; company_id: string | null } | null> {
  const email = normalizeEmail(contact.email);
  const phone10 = normalizePhoneLast10(contact.phone);

  if (email) {
    const { data } = await admin
      .from("contacts")
      .select("id, company_id")
      .eq("organization_id", orgId)
      .eq("email", email)
      .limit(1);
    if (data && data[0]) return data[0];
  }

  if (phone10) {
    // Compare last-10 in code (phone formats vary). Bounded fetch; add a normalized
    // phone column + index if the contact volume grows large.
    const { data } = await admin
      .from("contacts")
      .select("id, company_id, phone")
      .eq("organization_id", orgId)
      .not("phone", "is", null)
      .limit(2000);
    const hit = (data ?? []).find((c) => normalizePhoneLast10(c.phone) === phone10);
    if (hit) return { id: hit.id, company_id: hit.company_id };
  }

  return null;
}

async function buildReturning(
  admin: AdminClient,
  orgId: string,
  contactId: string,
  newCompanyId: string | null,
): Promise<ReturningInfo> {
  const { data } = await admin
    .from("activity_events")
    .select("event_type, company_id, occurred_at, metadata_json")
    .eq("organization_id", orgId)
    .eq("entity_id", contactId)
    .like("event_type", "lead.%")
    .order("occurred_at", { ascending: false })
    .limit(10);

  const priors = data ?? [];
  const crossBrand = priors.some((e) => e.company_id && e.company_id !== newCompanyId);
  const summaries = priors.map((e) => {
    const meta = (e.metadata_json ?? {}) as AsRecord;
    const brand = typeof meta.sourceSite === "string" ? meta.sourceSite : "?";
    const type = e.event_type.replace("lead.", "");
    return `${brand} ${type} (${(e.occurred_at ?? "").slice(0, 10)})`;
  });
  return { priorCount: priors.length, priorSummaries: summaries, crossBrand };
}

/** Parse a valid envelope into contacts + activity (+ booking). Best-effort. */
async function parseIntoRecords(
  admin: AdminClient,
  args: { orgId: string; companyId: string; envelope: LeadEnvelope; leadId: string },
): Promise<{ contactId: string; matched: boolean; returning: ReturningInfo | null }> {
  const { orgId, companyId, envelope, leadId } = args;
  const ctx = {
    organizationId: orgId,
    actorProfileId: null,
    supabase: admin,
  } as unknown as TenantServiceContext;

  const existing = await findExistingContact(admin, orgId, envelope.contact);

  let contactId: string;
  let matched = false;
  let returning: ReturningInfo | null = null;

  if (existing) {
    matched = true;
    contactId = existing.id;
    returning = await buildReturning(admin, orgId, contactId, companyId);
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
        metadata: {
          source: envelope.source,
          sourceSite: envelope.sourceSite,
          formType: envelope.formType,
          asset: envelope.asset ?? null,
          meta: envelope.meta ?? null,
        },
      },
      { dispatchWorkflow: false },
    );
    contactId = created.id;
  }

  // Activity events + bookings are DB-trigger-scoped to the CONTACT's company.
  // For a matched cross-brand contact (same person, a different A1 brand), the
  // contact's company differs from this lead's — use the contact's so the
  // trigger ("... must match the ... contact company") passes. The lead's real
  // brand is preserved in the activity metadata (sourceSite).
  const contactCompanyId = existing ? existing.company_id : companyId;

  // Record the lead touch (for both new and returning contacts).
  await createActivityEvent(ctx, {
    companyId: contactCompanyId,
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
    },
    occurredAt: envelope.receivedAt,
  });

  if (envelope.formType === "booking") {
    const when = parsePreferredDate(envelope.meta?.preferredDate, envelope.meta?.preferredTime);
    if (when) {
      await createBooking(
        ctx,
        {
          companyId: contactCompanyId ?? companyId,
          contactId,
          title: `Lead booking — ${envelope.source}`,
          description: envelope.message ?? null,
          scheduledFor: when,
        },
        { dispatchWorkflow: false },
      );
    }
  }

  return { contactId, matched, returning };
}

/**
 * Handle an authenticated lead intake. Never drops a lead:
 *   1) write raw_leads (durable) FIRST — a throw here fails the request (no false success);
 *   2) parse valid envelopes into contacts/activity/bookings — errors degrade, lead is kept;
 *   3) notify — best-effort, never fails the request.
 */
export async function handleLeadIntake(rawBody: string, parsedBody: unknown): Promise<IntakeResult> {
  const leadId = genLeadId();
  const admin = createSupabaseAdminClient();

  const parse = parseLeadEnvelope(parsedBody);
  const envelope = parse.envelope;

  const bodyRecord = (parsedBody && typeof parsedBody === "object" ? parsedBody : null) as AsRecord | null;
  const schemaVersion = typeof bodyRecord?.schemaVersion === "number" ? bodyRecord.schemaVersion : null;
  const rawPayload = (bodyRecord ?? { _unparseable: rawBody }) as Json;

  const { orgId, companyId, companyName } = await resolveTarget(admin, envelope?.sourceSite ?? null);

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
  if (parse.valid && envelope && orgId && companyId) {
    try {
      const enriched = await parseIntoRecords(admin, { orgId, companyId, envelope, leadId });
      returning = enriched.returning;
      await admin
        .from("raw_leads")
        .update({ contact_id: enriched.contactId, matched: enriched.matched, needs_attention: false })
        .eq("lead_id", leadId);
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

  // (3) Notify — best-effort.
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
    });
  } catch (err) {
    console.error("[intake] notification failed:", err);
  }

  return { ok: true, leadId };
}
