import { z } from "zod";

import { proposedSlotSchema, type LeadAnalysis, type ProposedSlot } from "@/server/ai/claude";
import type { Inserts, Json, Tables } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";
import { sendEmail } from "@/server/outbound/email";
import { sendSms } from "@/server/outbound/sms";
import { createActivityEvent } from "@/server/services/activity-events";
import { analyzeContact } from "@/server/services/ai";
import { createBooking } from "@/server/services/bookings";
import { assertContactInOrganization, insertRow, type TenantServiceContext } from "@/server/services/shared";

export type AiDraft = Tables<"ai_drafts">;

export const updateDraftInputSchema = z.object({
  emailSubject: z.string().max(300).nullable().optional(),
  emailBody: z.string().max(20000).nullable().optional(),
  smsBody: z.string().max(1600).nullable().optional(),
});

export type UpdateDraftInput = z.infer<typeof updateDraftInputSchema>;

export const confirmSlotInputSchema = z.object({
  startsAt: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
});

export type ConfirmSlotInput = z.infer<typeof confirmSlotInputSchema>;

/**
 * Activity events are validated by a DB trigger (set_activity_event_scope) that
 * resolves entity_type through resolve_trace_entity — which only knows company,
 * contact, booking, task, workflow, workflow_run and activity_event. Pointing a
 * related_entity_type at "ai_draft" would raise, so the draft is referenced
 * through metadata and the event is anchored to the contact.
 */
async function recordDraftEvent(
  context: TenantServiceContext,
  draft: AiDraft,
  eventType: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await createActivityEvent(context, {
      companyId: draft.company_id,
      entityId: draft.contact_id,
      entityType: "contact",
      eventType,
      metadata: { draftId: draft.id, ...metadata },
    });
  } catch (error) {
    // The message has already reached the customer by this point. Losing the
    // timeline entry is bad; pretending the send failed would be worse.
    console.error(`[ai-drafts] failed to record ${eventType} for draft ${draft.id}:`, error);
  }
}

async function updateDraftRow(
  context: TenantServiceContext,
  draftId: string,
  payload: Partial<Inserts<"ai_drafts">>,
): Promise<AiDraft> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (context.supabase.from("ai_drafts") as any)
    .update(payload)
    .eq("organization_id", context.organizationId)
    .eq("id", draftId)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data as AiDraft;
}

export async function getDraft(context: TenantServiceContext, draftId: string): Promise<AiDraft> {
  const { data, error } = await context.supabase
    .from("ai_drafts")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("id", draftId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new ValidationError("Draft not found.");
  }

  return data as AiDraft;
}

export async function listDraftsForContact(
  context: TenantServiceContext,
  contactId: string,
): Promise<AiDraft[]> {
  await assertContactInOrganization(context, contactId);

  const { data, error } = await context.supabase
    .from("ai_drafts")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []) as AiDraft[];
}

/**
 * Run Claude over the contact and persist the result as a reviewable draft.
 * Returns the typed analysis alongside the row so callers don't have to re-parse
 * the stored JSON.
 */
export async function createDraftForContact(
  context: TenantServiceContext,
  contactId: string,
  options: { workflowId?: string | null } = {},
): Promise<{ analysis: LeadAnalysis; draft: AiDraft }> {
  await assertContactInOrganization(context, contactId);

  const { data, error } = await context.supabase
    .from("contacts")
    .select("company_id")
    .eq("organization_id", context.organizationId)
    .eq("id", contactId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const contact = data as Pick<Tables<"contacts">, "company_id"> | null;
  if (!contact) {
    throw new ValidationError("Contact not found.");
  }

  const analysis = await analyzeContact(context, contactId);

  const payload = {
    analysis: analysis as unknown as Json,
    company_id: contact.company_id,
    contact_id: contactId,
    created_by: context.actorProfileId,
    email_body: analysis.draftedEmail.body,
    email_subject: analysis.draftedEmail.subject,
    organization_id: context.organizationId,
    proposed_slots: analysis.proposedSlots as unknown as Json,
    sms_body: analysis.draftedSms,
    workflow_id: options.workflowId ?? null,
  } satisfies Inserts<"ai_drafts">;

  const draft = await insertRow(context, "ai_drafts", payload);

  return { analysis, draft };
}

export async function updateDraft(
  context: TenantServiceContext,
  draftId: string,
  input: UpdateDraftInput,
): Promise<AiDraft> {
  const draft = await getDraft(context, draftId);

  const payload: Partial<Inserts<"ai_drafts">> = {};
  if (input.emailSubject !== undefined) {
    payload.email_subject = input.emailSubject;
  }
  if (input.emailBody !== undefined) {
    payload.email_body = input.emailBody;
  }
  if (input.smsBody !== undefined) {
    payload.sms_body = input.smsBody;
  }

  if (Object.keys(payload).length === 0) {
    return draft;
  }

  return updateDraftRow(context, draftId, payload);
}

async function loadContactForSend(
  context: TenantServiceContext,
  contactId: string,
): Promise<Tables<"contacts">> {
  const { data, error } = await context.supabase
    .from("contacts")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("id", contactId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new ValidationError("Contact not found.");
  }

  return data as Tables<"contacts">;
}

export async function sendDraftEmail(
  context: TenantServiceContext,
  draftId: string,
): Promise<AiDraft> {
  const draft = await getDraft(context, draftId);

  if (draft.email_status === "sent") {
    throw new ValidationError("This email has already been sent.");
  }

  const subject = draft.email_subject?.trim();
  const body = draft.email_body?.trim();

  if (!subject || !body) {
    throw new ValidationError("The email draft is empty.");
  }

  const contact = await loadContactForSend(context, draft.contact_id);
  if (!contact.email) {
    throw new ValidationError("This contact has no email address to send to.");
  }

  try {
    await sendEmail({ body, subject, to: contact.email });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateDraftRow(context, draftId, { email_error: message, email_status: "failed" });
    throw error;
  }

  const sent = await updateDraftRow(context, draftId, {
    email_error: null,
    email_sent_at: new Date().toISOString(),
    email_status: "sent",
  });

  await recordDraftEvent(context, sent, "ai_draft.email_sent", {
    subject,
    to: contact.email,
  });

  return sent;
}

export async function sendDraftSms(
  context: TenantServiceContext,
  draftId: string,
): Promise<AiDraft> {
  const draft = await getDraft(context, draftId);

  if (draft.sms_status === "sent") {
    throw new ValidationError("This SMS has already been sent.");
  }

  const body = draft.sms_body?.trim();
  if (!body) {
    throw new ValidationError("The SMS draft is empty.");
  }

  const contact = await loadContactForSend(context, draft.contact_id);
  if (!contact.phone) {
    throw new ValidationError("This contact has no phone number to send to.");
  }

  try {
    await sendSms({ body, to: contact.phone });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateDraftRow(context, draftId, { sms_error: message, sms_status: "failed" });
    throw error;
  }

  const sent = await updateDraftRow(context, draftId, {
    sms_error: null,
    sms_sent_at: new Date().toISOString(),
    sms_status: "sent",
  });

  await recordDraftEvent(context, sent, "ai_draft.sms_sent", { to: contact.phone });

  return sent;
}

export function readProposedSlots(draft: AiDraft): ProposedSlot[] {
  const parsed = z.array(proposedSlotSchema).safeParse(draft.proposed_slots);
  return parsed.success ? parsed.data : [];
}

/**
 * Turn one AI-proposed slot into a real booking. The slot must be one the AI
 * actually proposed — this endpoint confirms a suggestion, it is not a general
 * booking API (that already exists), so it can't be used to write arbitrary times.
 */
export async function confirmProposedSlot(
  context: TenantServiceContext,
  draftId: string,
  input: ConfirmSlotInput,
): Promise<{ booking: Tables<"bookings">; draft: AiDraft }> {
  const draft = await getDraft(context, draftId);

  if (draft.booking_id) {
    throw new ValidationError("A booking has already been created from this draft.");
  }

  const slot = readProposedSlots(draft).find((candidate) => candidate.startsAt === input.startsAt);
  if (!slot) {
    throw new ValidationError("That time is not one of the proposed slots.");
  }

  const contact = await loadContactForSend(context, draft.contact_id);
  const contactName = [contact.first_name, contact.last_name].filter(Boolean).join(" ");

  const booking = await createBooking(context, {
    companyId: draft.company_id,
    contactId: draft.contact_id,
    description: slot.reason,
    durationMinutes: slot.durationMinutes,
    scheduledFor: slot.startsAt,
    title: input.title ?? `Booking — ${contactName || "new lead"}`.slice(0, 200),
  });

  const updated = await updateDraftRow(context, draftId, { booking_id: booking.id });

  return { booking, draft: updated };
}
