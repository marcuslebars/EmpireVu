/**
 * SANCTIONED EXCEPTION (service role): the public customer portal /p/{token}.
 *
 * The customer has no session — the unguessable token IS the credential, exactly as
 * for /q/ and /i/ links. So every function here:
 *   • looks the link up ONLY by its exact token, and refuses a revoked link,
 *   • reads only that link's own organization + company + contact (every query is
 *     pinned to those three ids from the link row — never to anything in the request),
 *   • returns the narrowed PortalView (no internal ids, notes, crew or costs),
 *   • never shows drafts, void invoices, or cancelled / superseded quotes.
 *
 * "Request work" writes a task + activity for the brand and pings owners/admins.
 * Listed in docs/EMPIREVU_RUNBOOK.md (service-role surfaces).
 */
import { z } from "zod";

import type { Tables } from "@/server/db/database.types";
import { companyTimeZone, invoicePublicUrl, loadCompanyForInvoice, todayFor, type Db } from "@/server/services/invoices/common";
import { brandOfCompany } from "@/server/services/invoices/document";
import { notifyPortalRequest } from "@/server/services/push/notify";
import { quotePublicBaseUrlFor } from "@/server/services/quotes/config";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { invoiceState, quoteState, visitStatus, visitWhen, type PortalInvoice, type PortalQuote, type PortalView, type PortalVisit } from "./view";

type Link = Tables<"customer_portal_links">;

const TOKEN_RE = /^[a-f0-9]{40}$/;
const admin = (): Db => createSupabaseAdminClient() as unknown as Db;

async function linkByToken(db: Db, token: string): Promise<Link | null> {
  if (!TOKEN_RE.test(token)) return null;
  const { data, error } = await db.from("customer_portal_links").select("*").eq("token", token).maybeSingle();
  if (error) throw error;
  if (!data || data.revoked_at) return null;
  return data as Link;
}

export async function getPortal(token: string, now: Date = new Date()): Promise<PortalView | null> {
  const db = admin();
  const link = await linkByToken(db, token);
  if (!link) return null;
  const org = link.organization_id;

  const [company, contactRes, bookingsRes, quotesRes, invoicesRes] = await Promise.all([
    loadCompanyForInvoice(db, org, link.company_id),
    db.from("contacts").select("first_name, last_name").eq("organization_id", org).eq("id", link.contact_id).maybeSingle(),
    db
      .from("bookings")
      .select("title, scheduled_for, status, location, en_route_at, started_at")
      .eq("organization_id", org)
      .eq("company_id", link.company_id)
      .eq("contact_id", link.contact_id)
      .in("status", ["pending", "confirmed", "completed"])
      .order("scheduled_for", { ascending: false })
      .limit(200),
    db
      .from("quotes")
      .select("quote_number, title, status, superseded_by, total_cents, approved_total_cents, valid_until, public_token, created_at")
      .eq("organization_id", org)
      .eq("company_id", link.company_id)
      .eq("contact_id", link.contact_id)
      .order("created_at", { ascending: false })
      .limit(50),
    db
      .from("invoices")
      .select("invoice_number, title, status, issue_date, due_date, total_cents, balance_due_cents, pending_payment_cents, public_token, currency, created_at")
      .eq("organization_id", org)
      .eq("company_id", link.company_id)
      .eq("contact_id", link.contact_id)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);
  for (const r of [contactRes, bookingsRes, quotesRes, invoicesRes]) if (r.error) throw r.error;
  if (!contactRes.data) return null; // contact deleted

  const tz = companyTimeZone(company);
  const today = todayFor(company, now);
  const nowIso = now.toISOString();

  const upcoming: PortalVisit[] = [];
  const past: PortalVisit[] = [];
  for (const b of bookingsRes.data ?? []) {
    const status = visitStatus(b);
    const v: PortalVisit = { title: b.title, ...visitWhen(b.scheduled_for, tz), location: b.location ?? null, status };
    // Upcoming = not done and not long gone; today's unfinished visit stays "upcoming".
    if (status !== "done" && (b.scheduled_for >= nowIso || v.date === today)) upcoming.push(v);
    else if (status === "done") past.push(v);
  }
  upcoming.reverse(); // soonest first

  const quoteBase = quotePublicBaseUrlFor(company);
  const quotes: PortalQuote[] = [];
  for (const q of quotesRes.data ?? []) {
    const state = quoteState(q);
    if (!state) continue;
    quotes.push({
      number: q.quote_number,
      title: q.title,
      totalCents: q.approved_total_cents ?? q.total_cents,
      status: state,
      validUntil: q.valid_until ? q.valid_until.slice(0, 10) : null,
      url: `${quoteBase}/q/${q.public_token}`,
    });
  }

  const invoices: PortalInvoice[] = [];
  let balance = 0;
  let overdue = 0;
  let currency = "CAD";
  for (const inv of invoicesRes.data ?? []) {
    const state = invoiceState(inv, today);
    if (!state) continue;
    currency = inv.currency || currency;
    if (state !== "paid") balance += inv.balance_due_cents;
    if (state === "overdue") overdue += inv.balance_due_cents;
    invoices.push({
      number: inv.invoice_number,
      title: inv.title,
      issueDate: inv.issue_date,
      dueDate: inv.due_date,
      totalCents: inv.total_cents,
      balanceCents: inv.balance_due_cents,
      status: state,
      url: invoicePublicUrl(company, inv.public_token),
    });
  }

  // Best-effort view stamp (never blocks the page).
  void db
    .from("customer_portal_links")
    .update({ last_viewed_at: nowIso, view_count: (link.view_count ?? 0) + 1 })
    .eq("id", link.id)
    .then(({ error }) => error && console.error("[portal] view stamp failed:", error.message));

  return {
    brand: brandOfCompany(company),
    customerName: contactRes.data.first_name?.trim() || "there",
    currency,
    balanceCents: balance,
    overdueCents: overdue,
    upcoming: upcoming.slice(0, 20),
    past: past.slice(0, 10),
    quotes: quotes.slice(0, 20),
    invoices: invoices.slice(0, 30),
  };
}

export const portalRequestSchema = z.object({
  message: z.string().trim().min(3, "Tell us a little about what you need.").max(2000),
  preferredDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
});

/** "Request work": a task for the brand (high priority), an activity entry, and a push to owners/admins. */
export async function requestWork(token: string, input: z.infer<typeof portalRequestSchema>): Promise<boolean> {
  const db = admin();
  const link = await linkByToken(db, token);
  if (!link) return false;
  const { data: contact } = await db
    .from("contacts")
    .select("first_name, last_name, phone, email")
    .eq("organization_id", link.organization_id)
    .eq("id", link.contact_id)
    .maybeSingle();
  if (!contact) return false;
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim() || "A customer";
  const when = input.preferredDate ? `\nPreferred date: ${input.preferredDate}` : "";
  const reach = [contact.phone, contact.email].filter(Boolean).join(" · ");

  const { error } = await db.from("tasks").insert({
    organization_id: link.organization_id,
    company_id: link.company_id,
    contact_id: link.contact_id,
    title: `Work request from ${name}`.slice(0, 200),
    description: `${input.message}${when}${reach ? `\n\nContact: ${reach}` : ""}\n\n(Sent from their customer portal.)`.slice(0, 3000),
    priority: "high",
    status: "todo",
  });
  if (error) throw error;

  await db
    .from("activity_events")
    .insert({
      organization_id: link.organization_id,
      company_id: link.company_id,
      entity_type: "contact",
      entity_id: link.contact_id,
      event_type: "contact.portal_request",
      metadata_json: { message: input.message.slice(0, 500), preferredDate: input.preferredDate ?? null },
      occurred_at: new Date().toISOString(),
    })
    .then(({ error: e }) => e && console.error("[portal] activity failed:", e.message));

  await notifyPortalRequest({ organizationId: link.organization_id, companyId: link.company_id, contactId: link.contact_id, name, message: input.message });
  return true;
}

