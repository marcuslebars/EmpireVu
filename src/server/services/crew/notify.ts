/**
 * Tell crew they've been put on a job: a push (if they have the app) and an email.
 * Best-effort — assigning never fails because a notification did.
 */
import type { Tables } from "@/server/db/database.types";
import { isEmailSendConfigured, sendEmail } from "@/server/outbound/email";
import { getAppBaseUrl } from "@/server/services/ai";
import { notifyJobAssigned } from "@/server/services/push/notify";
import type { TenantServiceContext } from "@/server/services/shared";
import { formatJobWhen } from "./logic";

export interface AssignmentMessage {
  subject: string;
  pushTitle: string;
  pushBody: string;
  text: string;
}

export function renderAssignmentMessage(input: {
  title: string;
  when: string;
  location: string | null;
  customer: string | null;
  companyName: string | null;
  assignedBy: string | null;
  link: string | null;
}): AssignmentMessage {
  const where = input.location ? ` · ${input.location}` : "";
  const lines = [
    `You're on a job${input.companyName ? ` for ${input.companyName}` : ""}:`,
    "",
    input.title,
    `When: ${input.when}`,
    input.location ? `Where: ${input.location}` : null,
    input.customer ? `Customer: ${input.customer}` : null,
    input.assignedBy ? `Assigned by ${input.assignedBy}` : null,
    "",
    input.link ? `Open the job (checklist, photos, directions): ${input.link}` : "Open My Jobs to see the checklist.",
  ].filter((l): l is string => l !== null);
  return {
    subject: `New job: ${input.title} — ${input.when}`,
    pushTitle: `New job: ${input.title}`,
    pushBody: `${input.when}${where}`,
    text: lines.join("\n"),
  };
}

export async function notifyCrewAssigned(ctx: TenantServiceContext, booking: Tables<"bookings">, profileIds: string[]): Promise<void> {
  try {
    const [{ data: people }, { data: company }, { data: contact }, { data: actor }] = await Promise.all([
      ctx.supabase.from("profiles").select("id, email").in("id", profileIds),
      ctx.supabase.from("companies").select("name, timezone").eq("organization_id", ctx.organizationId).eq("id", booking.company_id).maybeSingle(),
      booking.contact_id
        ? ctx.supabase.from("contacts").select("first_name, last_name").eq("organization_id", ctx.organizationId).eq("id", booking.contact_id).maybeSingle()
        : Promise.resolve({ data: null }),
      ctx.actorProfileId
        ? ctx.supabase.from("profiles").select("full_name, email").eq("id", ctx.actorProfileId).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const base = getAppBaseUrl();
    const message = renderAssignmentMessage({
      title: booking.title,
      when: formatJobWhen(booking.scheduled_for, company?.timezone ?? null),
      location: booking.location ?? null,
      customer: contact ? [contact.first_name, contact.last_name].filter(Boolean).join(" ") || null : null,
      companyName: company?.name ?? null,
      assignedBy: actor?.full_name || actor?.email || null,
      link: base ? `${base}/jobs/${booking.id}` : null,
    });

    await notifyJobAssigned({
      organizationId: ctx.organizationId,
      companyId: booking.company_id,
      bookingId: booking.id,
      title: message.pushTitle,
      body: message.pushBody,
      recipientIds: profileIds,
    });

    const notified: string[] = [];
    if (isEmailSendConfigured()) {
      for (const person of people ?? []) {
        if (!person.email) continue;
        try {
          await sendEmail({ to: person.email, subject: message.subject, body: message.text, fromName: company?.name ?? undefined });
          notified.push(person.id);
        } catch (err) {
          console.error("[crew] assignment email failed:", err instanceof Error ? err.message : err);
        }
      }
    }
    if (notified.length) {
      await ctx.supabase
        .from("booking_assignments")
        .update({ notified_at: new Date().toISOString() })
        .eq("organization_id", ctx.organizationId)
        .eq("booking_id", booking.id)
        .in("profile_id", notified);
    }
  } catch (err) {
    console.error("[crew] notify failed:", err instanceof Error ? err.message : err);
  }
}
