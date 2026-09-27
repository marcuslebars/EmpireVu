/**
 * Import the A1 Marine Care site's upcoming bookings + recent quotes into EmpireVu.
 *
 *   npm run job:import-a1-care -- --file a1-care-export.json            # dry run (default)
 *   npm run job:import-a1-care -- --file a1-care-export.json --apply    # write
 *
 * Run it at cutover, right before pointing Marina at EmpireVu, so capacity counts every
 * job already on the calendar and returning callers are recognised. The file comes from
 * a1marinecare/scripts/export-for-empirevu.ts. See services/imports/a1-care.ts for the
 * mapping.
 *
 * Safe to re-run: every quote and booking carries its Care-site id (quotes.notes /
 * bookings.source_call_id) and is skipped when already imported.
 *
 * Deliberately QUIET: nothing here emails or texts a customer or fires an automation.
 * Quotes are written as already-sent (no "your quote" email), their expiry reminder is
 * marked as already handled, and bookings are inserted without booking.created. The
 * day-before reminder will still come from EmpireVu's scheduler — turn off the Care
 * site's own reminder workflow at the same time.
 *
 * Service-role: a job has no RLS identity; the target company is resolved by slug.
 */
import { readFileSync } from "node:fs";

import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { planImport, IMPORT_SOURCE, type PersonKey, type PlannedImportQuote } from "@/server/services/imports/a1-care";
import { parseBookingPolicy, DEFAULT_BOOKING_POLICY } from "@/server/services/booking-windows";
import { priceQuoteForCompany } from "@/server/services/quotes/pricing";
import { createQuote } from "@/server/services/quotes/service";
import { getQuotesConfig } from "@/server/services/quotes/config";
import type { TenantServiceContext } from "@/server/services/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}

const APPLY = process.argv.includes("--apply");
const log = (msg: string) => console.log(`[import-a1-care]${APPLY ? "" : " (dry run)"} ${msg}`);

async function findOrCreateContact(
  db: Db,
  company: { id: string; organization_id: string },
  p: PersonKey,
  consentAt: string,
  cache: Map<string, string>,
): Promise<{ id: string | null; created: boolean }> {
  const key = p.phoneLast10 ?? p.email ?? `name:${p.name.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return { id: hit, created: false };

  let found: { id: string } | null = null;
  if (p.phoneLast10) {
    const { data } = await db
      .from("contacts")
      .select("id")
      .eq("organization_id", company.organization_id)
      .eq("company_id", company.id)
      .eq("phone_last10", p.phoneLast10)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    found = data;
  }
  if (!found && p.email) {
    const { data } = await db
      .from("contacts")
      .select("id")
      .eq("organization_id", company.organization_id)
      .eq("company_id", company.id)
      .ilike("email", p.email)
      .limit(1)
      .maybeSingle();
    found = data;
  }
  if (found) {
    cache.set(key, found.id);
    return { id: found.id, created: false };
  }
  if (!APPLY) {
    cache.set(key, `new:${key}`);
    return { id: `new:${key}`, created: true };
  }
  const { data: created, error } = await db
    .from("contacts")
    .insert({
      organization_id: company.organization_id,
      company_id: company.id,
      first_name: p.firstName,
      last_name: p.lastName,
      phone: p.phone,
      email: p.email,
      stage: "lead",
      // They asked us for a quote / booking on the Care site: implied consent (CASL),
      // dated from that inquiry.
      sms_consent_at: consentAt,
      consent_source: "implied_inquiry",
      notes: "Imported from the A1 Marine Care site.",
    })
    .select("id")
    .single();
  if (error) throw error;
  cache.set(key, created.id);
  return { id: created.id, created: true };
}

async function alreadyImportedQuote(db: Db, companyId: string, a1Id: string): Promise<string | null> {
  const { data } = await db
    .from("quotes")
    .select("id")
    .eq("company_id", companyId)
    .eq("source", IMPORT_SOURCE)
    .ilike("notes", `%a1marinecare quote ${a1Id}%`)
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

async function importQuote(
  db: Db,
  ctx: TenantServiceContext,
  company: { id: string; organization_id: string },
  q: PlannedImportQuote,
  contactId: string | null,
  report: Record<string, number>,
  mismatches: string[],
): Promise<string | null> {
  const existing = await alreadyImportedQuote(db, company.id, q.a1Id);
  if (existing) {
    report.quotesSkipped += 1;
    return existing;
  }
  if (q.manualReview || q.quotedCents == null) {
    report.quotesManual += 1;
    return null; // no price to carry over; the contact is still imported
  }

  // Price from the Care catalog; if it disagrees with what the customer was told, the
  // customer's number wins as a single custom line.
  const priced = await priceQuoteForCompany(company.id, { services: q.services, hullType: q.hullType });
  const matches = priced.subtotalCents === q.quotedCents;
  if (!matches) {
    mismatches.push(`${q.person.name} (${q.lengthFt} ft ${q.hullType}): quoted $${(q.quotedCents / 100).toFixed(2)}, EmpireVu prices $${(priced.subtotalCents / 100).toFixed(2)} — keeping the quoted amount`);
  }
  if (!APPLY) {
    report.quotesCreated += 1;
    return `new:${q.a1Id}`;
  }

  const draft = await createQuote(ctx, {
    contactId: contactId && !contactId.startsWith("new:") ? contactId : null,
    companyId: company.id,
    services: matches ? q.services : [],
    customLines: matches ? [] : [{ label: "Mobile shrink wrap (as quoted)", description: `${q.lengthFt} ft ${q.hullType}`, amountCents: q.quotedCents }],
    hullType: q.hullType,
    title: `Mobile shrink wrap — ${q.lengthFt} ft ${q.hullType === "other" ? "boat" : q.hullType}`,
    source: IMPORT_SOURCE,
    notes: q.notes,
  });

  const validUntil = new Date(Date.parse(q.createdAt) + getQuotesConfig().expiryDays * 86_400_000).toISOString();
  const { error } = await db
    .from("quotes")
    .update({
      status: q.paid ? "deposit_paid" : "sent",
      sent_at: q.createdAt,
      valid_until: validUntil,
      expires_at: validUntil,
      deposit_paid_at: q.paid?.at ?? null,
      // Already told about this quote by the Care site — no "expiring soon" email from here.
      expiry_reminder_sent_at: new Date().toISOString(),
    })
    .eq("id", draft.id);
  if (error) throw error;

  if (q.linkSent) {
    await db.from("quote_events").insert({
      organization_id: company.organization_id,
      quote_id: draft.id,
      event_type: "deposit_link_sent",
      actor_profile_id: null,
      metadata: { by: "import", source: IMPORT_SOURCE },
    });
  }
  report.quotesCreated += 1;
  return draft.id;
}

async function main(): Promise<number> {
  const file = arg("file");
  if (!file) {
    console.error("Usage: npm run job:import-a1-care -- --file a1-care-export.json [--apply] [--company a1-marine-care]");
    return 1;
  }
  const plan = planImport(JSON.parse(readFileSync(file, "utf8")));
  const slug = arg("company") ?? "a1-marine-care";

  const db = createSupabaseAdminClient() as Db;
  const { data: company, error: companyError } = await db
    .from("companies")
    .select("id, organization_id, name, booking_policy")
    .eq("slug", slug)
    .maybeSingle();
  if (companyError) throw companyError;
  if (!company) {
    console.error(`[import-a1-care] no company with slug "${slug}".`);
    return 1;
  }
  const policy = parseBookingPolicy(company.booking_policy) ?? DEFAULT_BOOKING_POLICY;
  const ctx: TenantServiceContext = { organizationId: company.organization_id, actorProfileId: null, supabase: db };
  log(`into ${company.name}: ${plan.quotes.length} quotes, ${plan.bookings.length} upcoming bookings in the file.`);

  const report = {
    contactsCreated: 0,
    quotesCreated: 0,
    quotesSkipped: 0,
    quotesManual: 0,
    bookingsCreated: 0,
    bookingsSkipped: 0,
  };
  const mismatches: string[] = [];
  const contactCache = new Map<string, string>();
  const quoteIdByA1 = new Map<string, string | null>();
  const contactByA1Quote = new Map<string, string | null>();

  for (const q of plan.quotes) {
    const contact = await findOrCreateContact(db, company, q.person, q.createdAt, contactCache);
    if (contact.created) report.contactsCreated += 1;
    contactByA1Quote.set(q.a1Id, contact.id);
    quoteIdByA1.set(q.a1Id, await importQuote(db, ctx, company, q, contact.id, report, mismatches));
  }

  for (const b of plan.bookings) {
    const { data: existing } = await db
      .from("bookings")
      .select("id")
      .eq("company_id", company.id)
      .eq("source", IMPORT_SOURCE)
      .eq("source_call_id", b.sourceRef)
      .limit(1)
      .maybeSingle();
    if (existing) {
      report.bookingsSkipped += 1;
      continue;
    }
    let contactId = b.a1QuoteId ? contactByA1Quote.get(b.a1QuoteId) ?? null : null;
    if (!contactId) {
      const contact = await findOrCreateContact(db, company, b.person, b.createdAt, contactCache);
      if (contact.created) report.contactsCreated += 1;
      contactId = contact.id;
    }
    const quoteId = b.a1QuoteId ? quoteIdByA1.get(b.a1QuoteId) ?? null : null;
    const window = b.windowKey ? policy.windows.find((w) => w.key === b.windowKey) : null;
    if (APPLY) {
      const { error } = await db.from("bookings").insert({
        organization_id: company.organization_id,
        company_id: company.id,
        contact_id: contactId && !contactId.startsWith("new:") ? contactId : null,
        quote_id: quoteId && !quoteId.startsWith("new:") ? quoteId : null,
        title: b.title,
        description: b.description,
        scheduled_for: b.scheduledFor,
        duration_minutes: window?.durationMinutes ?? b.durationMinutes,
        status: b.status,
        window_key: b.windowKey,
        source: IMPORT_SOURCE,
        source_call_id: b.sourceRef,
        created_by: null,
      });
      if (error) throw error;
    }
    report.bookingsCreated += 1;
  }

  log(
    `contacts +${report.contactsCreated} · quotes +${report.quotesCreated} (already there ${report.quotesSkipped}, ` +
      `no price to carry ${report.quotesManual}) · bookings +${report.bookingsCreated} (already there ${report.bookingsSkipped}).`,
  );
  for (const m of mismatches) log(`price differs: ${m}`);
  if (!APPLY) log("Nothing was written. Re-run with --apply to import.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[import-a1-care] failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
