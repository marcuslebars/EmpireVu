import type { Tables } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";
import type { TenantServiceContext } from "@/server/services/shared";
import {
  analyzeLead,
  isAIConfigured,
  type BusySlot,
  type LeadAnalysis,
  type SchedulingContext,
} from "@/server/ai/claude";

/** How far ahead the AI is allowed to see (and propose) when suggesting booking slots. */
const SCHEDULING_HORIZON_DAYS = 14;

export function getBusinessTimezone(): string {
  return process.env.BUSINESS_TIMEZONE ?? "America/Toronto";
}

/** The app's public origin (e.g. https://empirevu.com) for customer-facing links. Null if unset. */
export function getAppBaseUrl(): string | null {
  const raw = process.env.APP_BASE_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

/**
 * The company's real calendar for the next two weeks, so proposed slots don't
 * collide with work already booked. Cancelled jobs don't block a slot.
 */
async function loadSchedulingContext(
  context: TenantServiceContext,
  companyId: string | null,
  nowIso: string,
): Promise<SchedulingContext> {
  const scheduling: SchedulingContext = {
    busy: [],
    nowIso,
    timezone: getBusinessTimezone(),
  };

  if (!companyId) {
    return scheduling;
  }

  const horizonIso = new Date(
    new Date(nowIso).getTime() + SCHEDULING_HORIZON_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data, error } = await context.supabase
    .from("bookings")
    .select("title, scheduled_for, duration_minutes, status")
    .eq("organization_id", context.organizationId)
    .eq("company_id", companyId)
    .neq("status", "cancelled")
    .gte("scheduled_for", nowIso)
    .lte("scheduled_for", horizonIso)
    .order("scheduled_for", { ascending: true });

  if (error) {
    throw error;
  }

  const rows = (data ?? []) as Array<
    Pick<Tables<"bookings">, "title" | "scheduled_for" | "duration_minutes">
  >;

  scheduling.busy = rows.map(
    (row): BusySlot => ({
      durationMinutes: row.duration_minutes ?? 30,
      startsAt: row.scheduled_for,
      title: row.title,
    }),
  );

  return scheduling;
}

export async function analyzeContact(
  context: TenantServiceContext,
  contactId: string,
): Promise<LeadAnalysis> {
  if (!isAIConfigured()) {
    throw new ValidationError(
      "AI is not configured. Set ANTHROPIC_API_KEY on the server to enable AI features.",
    );
  }

  const { data, error } = await context.supabase
    .from("contacts")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("id", contactId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const contact = data as Tables<"contacts"> | null;
  if (!contact) {
    throw new ValidationError("Contact not found.");
  }

  let companyName: string | null = null;
  if (contact.company_id) {
    const { data: companyData } = await context.supabase
      .from("companies")
      .select("name")
      .eq("organization_id", context.organizationId)
      .eq("id", contact.company_id)
      .maybeSingle();
    companyName = (companyData as { name: string } | null)?.name ?? null;
  }

  const metadata =
    contact.metadata && typeof contact.metadata === "object" && !Array.isArray(contact.metadata)
      ? (contact.metadata as Record<string, unknown>)
      : {};

  const scheduling = await loadSchedulingContext(
    context,
    contact.company_id,
    new Date().toISOString(),
  );

  const appBaseUrl = getAppBaseUrl();
  const bookingUrl =
    appBaseUrl && contact.company_id ? `${appBaseUrl}/book/${contact.company_id}` : null;

  return analyzeLead({
    firstName: contact.first_name,
    lastName: contact.last_name,
    email: contact.email,
    phone: contact.phone,
    stage: contact.stage,
    notes: contact.notes,
    companyName,
    createdAt: contact.created_at,
    metadata,
    scheduling,
    bookingUrl,
  });
}
