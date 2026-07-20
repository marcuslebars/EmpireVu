import { format, parseISO } from "date-fns";

import type { TelnyxAdminClient } from "./tenant";

export interface CustomerLookup {
  customerName: string;
  interactionMode: "returning_customer" | "new_lead";
  lastServiceSummary: string | null;
}

/** What the greeting falls back to whenever we can't match (or run out of time). */
export const FALLBACK_LOOKUP: CustomerLookup = {
  customerName: "there",
  interactionMode: "new_lead",
  lastServiceSummary: null,
};

/**
 * Build "shrink wrap + winterization, Oct 2025" from the caller's completed jobs.
 * Titles are free text, so this stays a short human phrase, not a parse.
 */
function buildLastServiceSummary(
  bookings: Array<{ scheduled_for: string; title: string }>,
): string | null {
  if (bookings.length === 0) return null;

  const labels = bookings
    .slice(0, 2)
    .map((booking) => booking.title.trim())
    .filter(Boolean);
  if (labels.length === 0) return null;

  const mostRecent = bookings[0].scheduled_for;
  let when = "";
  try {
    when = format(parseISO(mostRecent), "MMM yyyy");
  } catch {
    when = "";
  }

  return when ? `${labels.join(" + ")}, ${when}` : labels.join(" + ");
}

/**
 * Look the caller up by normalized phone.
 *
 * The queries form a dependency chain (contact, then that contact's jobs), so
 * they can't be run together — each is a single indexed hit
 * (contacts_org_phone_last10_idx, then bookings by contact_id), and the caller
 * bounds the whole thing with an 800ms race so a slow database degrades the
 * greeting instead of the call.
 */
export async function lookupCustomerByPhone(
  admin: TelnyxAdminClient,
  args: { companyId: string | null; organizationId: string | null; phoneLast10: string | null },
): Promise<CustomerLookup> {
  const { companyId, organizationId, phoneLast10 } = args;
  if (!organizationId || !phoneLast10) {
    return FALLBACK_LOOKUP;
  }

  let contactQuery = admin
    .from("contacts")
    .select("id, first_name")
    .eq("organization_id", organizationId)
    .eq("phone_last10", phoneLast10);

  // Leads are attributed per brand, so prefer the brand that was dialled.
  if (companyId) {
    contactQuery = contactQuery.eq("company_id", companyId);
  }

  const { data: contacts, error } = await contactQuery.limit(1);
  if (error) throw error;

  const contact = contacts?.[0];
  if (!contact) {
    return FALLBACK_LOOKUP;
  }

  const firstName = contact.first_name?.trim();
  const customerName = firstName && firstName.toLowerCase() !== "lead" ? firstName : "there";

  const { data: bookings } = await admin
    .from("bookings")
    .select("title, scheduled_for")
    .eq("organization_id", organizationId)
    .eq("contact_id", contact.id)
    .eq("status", "completed")
    .order("scheduled_for", { ascending: false })
    .limit(3);

  return {
    customerName,
    interactionMode: "returning_customer",
    lastServiceSummary: buildLastServiceSummary(bookings ?? []),
  };
}
