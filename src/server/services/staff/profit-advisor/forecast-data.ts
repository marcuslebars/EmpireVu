/**
 * Loads the cash forecast's inputs (forecast.ts) for one company — service role, every read scoped
 * by organization_id + company_id. Each source is read on its own and TOLERANTLY: a table that
 * isn't there (another role's, e.g. Fleet's `rentals`) or a read that fails just leaves that source
 * out with a note ("HST not included - couldn't read it"), so the forecast never fails as a whole.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { occurrencesBetween } from "@/server/services/recurring/rule";
import { priceOf, readLineItems } from "@/server/services/recurring/service";
import { isImportedPastJob } from "@/server/services/reports/exclusions";
import { lastEndedPeriod, periodContaining, worksheetFor, type HstPeriod } from "@/server/services/staff/tax-clerk/hst";
import { loadTaxClerkCompany } from "@/server/services/staff/tax-clerk/settings";
import { workedMinutes } from "@/server/services/time/logic";
import type { Db } from "./db-types";
import { addDays, clip, daysBetween, localDay, localMidnightIso } from "./format";
import { buildForecast, HORIZON_DAYS, HST_FACTOR, type ExpenseInput, type Forecast, type ForecastInputs, type HstInput, type JobInput, type LabourInput, type OpenInvoiceInput, type PaidInvoiceInput, type PoInput, type QuoteInput, type RenewalInput, type RentalInput, type SeriesInput } from "./forecast";
import { readAll, type ProfitCompany } from "./settings";

const DAY = 86_400_000;
const OPEN_INVOICE = ["sent", "viewed", "partially_paid"];
const COUNTED_INVOICE = ["sent", "viewed", "partially_paid", "paid"];

type Scope = Pick<ProfitCompany, "organizationId" | "companyId" | "timeZone">;

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function chunks<T>(items: T[], size = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Contact id → "Dana Jones" (scoped). */
async function contactNames(db: Db, organizationId: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunks([...new Set(ids)])) {
    const { data, error } = await db.from("contacts").select("id, first_name, last_name").eq("organization_id", organizationId).in("id", part);
    if (error) throw error;
    for (const c of (data ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>) {
      const name = [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
      if (name) out.set(c.id, name);
    }
  }
  return out;
}

const lastName = (name: string | undefined | null) => {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
};

/** Does the org have only this one company? (Then company-less expenses / time are this company's.) */
async function onlyCompany(db: Db, organizationId: string): Promise<boolean> {
  const { data, error } = await db.from("companies").select("id").eq("organization_id", organizationId).limit(2);
  if (error) return false;
  return ((data ?? []) as unknown[]).length === 1;
}

interface Loaded<T> {
  value: T;
  note?: string;
}

async function tolerant<T>(label: string, empty: T, run: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { value: await run() };
  } catch (err) {
    console.error(`[profit-advisor] forecast: ${label} left out:`, err instanceof Error ? err.message : (rec(err).message as string | undefined) ?? err);
    return { value: empty, note: `${label} not included - couldn't read it.` };
  }
}

async function loadInvoices(db: Db, s: Scope, today: string): Promise<{ open: OpenInvoiceInput[]; paid: PaidInvoiceInput[]; averageJobCents: number | null }> {
  const open = await readAll<Record<string, unknown>>((from, to) =>
    db
      .from("invoices")
      .select("id, invoice_number, contact_id, balance_due_cents, due_date, issue_date, status")
      .eq("organization_id", s.organizationId)
      .eq("company_id", s.companyId)
      .in("status", OPEN_INVOICE)
      .gt("balance_due_cents", 0)
      .order("id", { ascending: true })
      .range(from, to),
  );
  const since = addDays(today, -365);
  const paidRows = await readAll<Record<string, unknown>>((from, to) =>
    db
      .from("invoices")
      .select("contact_id, due_date, issue_date, paid_at, imported_at")
      .eq("organization_id", s.organizationId)
      .eq("company_id", s.companyId)
      .eq("status", "paid")
      .gte("paid_at", `${since}T00:00:00Z`)
      .order("paid_at", { ascending: true })
      .range(from, to),
  );
  const recent = await readAll<Record<string, unknown>>((from, to) =>
    db
      .from("invoices")
      .select("total_cents, status, imported_at, issue_date")
      .eq("organization_id", s.organizationId)
      .eq("company_id", s.companyId)
      .in("status", COUNTED_INVOICE)
      .gte("issue_date", addDays(today, -90))
      .order("issue_date", { ascending: true })
      .range(from, to),
  );
  const names = await contactNames(db, s.organizationId, open.map((i) => str(i.contact_id)).filter((x): x is string => !!x));
  const totals = recent.filter((i) => !i.imported_at && num(i.total_cents) > 0).map((i) => num(i.total_cents));
  return {
    open: open.map((i) => {
      const who = lastName(names.get(String(i.contact_id)));
      return {
        id: String(i.id),
        label: clip([str(i.invoice_number) ?? "Invoice", who].filter(Boolean).join(" "), 40),
        contactId: str(i.contact_id),
        balanceCents: num(i.balance_due_cents),
        dueDate: str(i.due_date),
        issueDate: str(i.issue_date),
      };
    }),
    paid: paidRows
      .filter((i) => !i.imported_at && str(i.paid_at))
      .map((i) => ({ contactId: str(i.contact_id), dueDate: str(i.due_date), issueDate: str(i.issue_date), paidDate: localDay(Date.parse(String(i.paid_at)), s.timeZone) })),
    averageJobCents: totals.length ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : null,
  };
}

/** Booking / quote ids that already have an invoice (it's counted as an invoice, not twice). */
async function invoiced(db: Db, s: Scope, column: "quote_id" | "booking_id", ids: string[], ignore: Set<string> = new Set()): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunks(ids)) {
    const { data, error } = await db.from("invoices").select(`id, ${column}, status`).eq("organization_id", s.organizationId).eq("company_id", s.companyId).in(column, part);
    if (error) throw error;
    for (const r of (data ?? []) as Array<Record<string, unknown>>) if (r.status !== "void" && r.status !== "draft" && str(r[column]) && !ignore.has(String(r.id))) out.add(String(r[column]));
  }
  return out;
}

async function loadQuotes(db: Db, s: Scope, today: string): Promise<{ quotes: QuoteInput[]; quoteIds: Set<string> }> {
  const rows = await readAll<Record<string, unknown>>((from, to) =>
    db
      .from("quotes")
      .select("id, title, contact_id, status, approved_at, approved_total_cents, total_cents, approved_deposit_cents, deposit_cents, deposit_paid_at")
      .eq("organization_id", s.organizationId)
      .eq("company_id", s.companyId)
      .in("status", ["approved", "deposit_paid"])
      .gte("approved_at", `${addDays(today, -365)}T00:00:00Z`)
      .order("id", { ascending: true })
      .range(from, to),
  );
  const ids = rows.map((q) => String(q.id));
  const done = await invoiced(db, s, "quote_id", ids);
  const live = rows.filter((q) => !done.has(String(q.id)));
  const jobDay = new Map<string, string>();
  for (const part of chunks(live.map((q) => String(q.id)))) {
    const { data, error } = await db.from("bookings").select("quote_id, scheduled_for, status").eq("organization_id", s.organizationId).eq("company_id", s.companyId).in("quote_id", part);
    if (error) throw error;
    for (const b of (data ?? []) as Array<Record<string, unknown>>) {
      if (b.status === "cancelled" || !str(b.quote_id)) continue;
      const day = localDay(Date.parse(String(b.scheduled_for)), s.timeZone);
      const prev = jobDay.get(String(b.quote_id));
      if (!prev || day < prev) jobDay.set(String(b.quote_id), day);
    }
  }
  const names = await contactNames(db, s.organizationId, live.map((q) => str(q.contact_id)).filter((x): x is string => !!x));
  return {
    quoteIds: new Set(live.map((q) => String(q.id))),
    quotes: live.map((q) => {
      const total = num(q.approved_total_cents) || num(q.total_cents);
      const deposit = num(q.approved_deposit_cents) || num(q.deposit_cents);
      const depositPaid = Boolean(q.deposit_paid_at) || q.status === "deposit_paid";
      const who = lastName(names.get(String(q.contact_id)));
      return {
        id: String(q.id),
        label: clip([who, str(q.title) ?? "quote"].filter(Boolean).join(" "), 40),
        depositDueCents: depositPaid ? 0 : Math.min(deposit, total),
        balanceCents: Math.max(0, total - Math.min(deposit, total)),
        jobDate: jobDay.get(String(q.id)) ?? null,
      };
    }),
  };
}

async function loadJobs(db: Db, s: Scope, today: string, end: string, quoteIds: Set<string>): Promise<JobInput[]> {
  const rows = await readAll<Record<string, unknown>>((from, to) =>
    db
      .from("bookings")
      .select("id, title, contact_id, scheduled_for, status, quote_id, recurring_job_id, service_item_id, price_cents, source_call_id, deposit_cents, deposit_paid_at, deposit_invoice_id")
      .eq("organization_id", s.organizationId)
      .eq("company_id", s.companyId)
      .in("status", ["pending", "confirmed"])
      .gte("scheduled_for", localMidnightIso(today, s.timeZone))
      .lt("scheduled_for", localMidnightIso(end, s.timeZone))
      .order("scheduled_for", { ascending: true })
      .range(from, to),
  );
  let list = rows.filter((b) => !isImportedPastJob({ source_call_id: str(b.source_call_id) }) && !(str(b.quote_id) && quoteIds.has(String(b.quote_id))));
  // An online-booking deposit is its own invoice (no booking_id), counted with the open invoices
  // when unpaid and already received when paid — so it's never an invoice "for the job" here.
  const depositInvoices = new Set(list.map((b) => str(b.deposit_invoice_id)).filter((x): x is string => !!x));
  const done = await invoiced(db, s, "booking_id", list.map((b) => String(b.id)), depositInvoices);
  list = list.filter((b) => !done.has(String(b.id)));
  // Warranty / callback visits (Customer care) aren't billed — tolerant: no table → none.
  try {
    const care = new Set<string>();
    for (const part of chunks(list.map((b) => String(b.id)))) {
      const { data, error } = await db.from("care_case_bookings").select("booking_id").eq("organization_id", s.organizationId).in("booking_id", part);
      if (error) throw error;
      for (const r of (data ?? []) as Array<{ booking_id: string }>) care.add(r.booking_id);
    }
    list = list.filter((b) => !care.has(String(b.id)));
  } catch {
    // no Customer care tables here
  }
  const seriesIds = [...new Set(list.map((b) => str(b.recurring_job_id)).filter((x): x is string => !!x))];
  const itemIds = [...new Set(list.map((b) => str(b.service_item_id)).filter((x): x is string => !!x))];
  const seriesPrice = new Map<string, number>();
  for (const part of chunks(seriesIds)) {
    const { data, error } = await db.from("recurring_jobs").select("id, line_items").eq("organization_id", s.organizationId).eq("company_id", s.companyId).in("id", part);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ id: string; line_items: unknown }>) seriesPrice.set(r.id, priceOf(readLineItems(r.line_items)));
  }
  const itemPrice = new Map<string, number>();
  for (const part of chunks(itemIds)) {
    const { data, error } = await db.from("service_catalog_items").select("id, rate_cents, pricing_type").eq("organization_id", s.organizationId).eq("company_id", s.companyId).in("id", part);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ id: string; rate_cents: number; pricing_type: string }>) if (r.pricing_type === "flat" && r.rate_cents > 0) itemPrice.set(r.id, r.rate_cents);
  }
  const names = await contactNames(db, s.organizationId, list.map((b) => str(b.contact_id)).filter((x): x is string => !!x));
  return list.map((b) => {
    const price = num(b.price_cents);
    const series = str(b.recurring_job_id);
    let preTax: number | null = null;
    if (price > 0) preTax = price;
    else if (series && seriesPrice.has(series)) preTax = seriesPrice.get(series) ?? 0; // 0 = a prepaid plan visit
    else if (str(b.service_item_id) && itemPrice.has(String(b.service_item_id))) preTax = itemPrice.get(String(b.service_item_id)) ?? null;
    const who = lastName(names.get(String(b.contact_id)));
    // A deposit with its own invoice (paid, or open and counted there) isn't money still to come.
    const deposit = str(b.deposit_invoice_id) ? num(b.deposit_cents) : 0;
    return {
      id: String(b.id),
      label: clip([who, str(b.title) ?? "job"].filter(Boolean).join(" "), 40),
      date: localDay(Date.parse(String(b.scheduled_for)), s.timeZone),
      expectedCents: preTax == null ? null : Math.max(0, Math.round(preTax * HST_FACTOR) - deposit),
    };
  });
}

/** Active series: visit dates past what's generated (recurring sweep books ~60 days ahead). */
async function loadSeries(db: Db, s: Scope, today: string, end: string): Promise<SeriesInput[]> {
  const rows = await readAll<Record<string, unknown>>((from, to) =>
    db.from("recurring_jobs").select("*").eq("organization_id", s.organizationId).eq("company_id", s.companyId).eq("status", "active").order("id", { ascending: true }).range(from, to),
  );
  const out: SeriesInput[] = [];
  for (const r of rows) {
    const price = priceOf(readLineItems(r.line_items));
    if (!(price > 0)) continue;
    const generated = str(r.generated_through);
    const from = generated && addDays(generated, 1) > today ? addDays(generated, 1) : today;
    if (from > end) continue;
    const explicit = Array.isArray(r.visit_dates) ? (r.visit_dates as unknown[]).filter((d): d is string => typeof d === "string") : null;
    const dates = explicit
      ? explicit.filter((d) => d >= from && d < end)
      : occurrencesBetween(
          {
            frequency: r.frequency as "weekly" | "monthly" | "yearly",
            interval: Math.max(1, num(r.interval_count) || 1),
            weekdays: Array.isArray(r.weekdays) ? (r.weekdays as number[]) : undefined,
            startDate: String(r.start_date),
            endsOn: str(r.ends_on),
            maxOccurrences: num(r.max_occurrences) || null,
          },
          from,
          addDays(end, -1),
          60,
        );
    if (dates.length) out.push({ id: String(r.id), label: clip(str(r.title) ?? "Recurring visit", 40), visitCents: Math.round(price * HST_FACTOR), dates });
  }
  return out;
}

async function loadRenewals(db: Db, s: Scope, today: string, end: string): Promise<RenewalInput[]> {
  const { data, error } = await db
    .from("service_agreements")
    .select("id, plan_name, customer_name, status, billing, price_cents, renewal_price_cents, term_end, renewed_by_agreement_id, renewal_declined_at")
    .eq("organization_id", s.organizationId)
    .eq("company_id", s.companyId)
    .in("status", ["active", "renewal_due"])
    .gte("term_end", today)
    .lt("term_end", end)
    .limit(2000);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>)
    .filter((a) => a.billing === "annual" && !a.renewed_by_agreement_id && !a.renewal_declined_at)
    .map((a) => ({
      id: String(a.id),
      label: clip(`${lastName(str(a.customer_name)) ?? "Plan"} ${str(a.plan_name) ?? "plan"} renewal`, 40),
      date: String(a.term_end),
      cents: Math.round((num(a.renewal_price_cents) || num(a.price_cents)) * HST_FACTOR),
    }));
}

async function loadExpenses(db: Db, s: Scope, today: string, single: boolean): Promise<ExpenseInput[]> {
  const read = (companyNull: boolean) =>
    readAll<Record<string, unknown>>((from, to) => {
      let q = db.from("expenses").select("spent_on, category, amount_cents").eq("organization_id", s.organizationId);
      q = companyNull ? q.is("company_id", null) : q.eq("company_id", s.companyId);
      return q.gte("spent_on", addDays(today, -90)).lt("spent_on", today).order("spent_on", { ascending: true }).range(from, to);
    });
  const rows = [...(await read(false)), ...(single ? await read(true) : [])];
  return rows.map((e) => ({ spentOn: String(e.spent_on), category: str(e.category) ?? "other", amountCents: num(e.amount_cents) }));
}

async function loadLabour(db: Db, s: Scope, nowMs: number, single: boolean): Promise<LabourInput[]> {
  const since = new Date(nowMs - 28 * DAY).toISOString();
  const read = (companyNull: boolean) =>
    readAll<Record<string, unknown>>((from, to) => {
      let q = db.from("time_entries").select("profile_id, started_at, ended_at, break_minutes").eq("organization_id", s.organizationId);
      q = companyNull ? q.is("company_id", null) : q.eq("company_id", s.companyId);
      return q.gte("started_at", since).order("started_at", { ascending: true }).range(from, to);
    });
  const entries = [...(await read(false)), ...(single ? await read(true) : [])].filter((e) => str(e.ended_at));
  const minutes = new Map<string, number>();
  for (const e of entries) {
    const m = workedMinutes({ started_at: String(e.started_at), ended_at: String(e.ended_at), break_minutes: num(e.break_minutes) });
    minutes.set(String(e.profile_id), (minutes.get(String(e.profile_id)) ?? 0) + m);
  }
  if (minutes.size === 0) return [];
  const { data, error } = await db.from("member_pay_rates").select("profile_id, hourly_cost_cents").eq("organization_id", s.organizationId);
  if (error) throw error;
  const rates = new Map(((data ?? []) as Array<{ profile_id: string; hourly_cost_cents: number }>).map((r) => [r.profile_id, r.hourly_cost_cents]));
  return [...minutes.entries()].map(([profileId, m]) => ({ profileId, minutes: m, rateCents: rates.get(profileId) ?? null }));
}

/** HST returns whose payment falls in the window (the Tax Clerk's worksheet). Registrants only. */
/** A running HST period is only scaled up once it has this many days in it. */
const MIN_HST_DAYS = 7;

async function loadHst(admin: AdminClient, s: Scope, today: string, end: string, notes: string[]): Promise<HstInput[]> {
  const company = await loadTaxClerkCompany(admin, s.organizationId, s.companyId);
  if (!company || !company.settings.hst.registrant) return [];
  const settings = { frequency: company.settings.hst.frequency, fiscalYearEndMonth: company.settings.hst.fiscalYearEndMonth, filer: company.settings.hst.filer };
  const periods: HstPeriod[] = [];
  const seen = new Set<string>();
  for (let p: HstPeriod = lastEndedPeriod(today, settings); p.start <= end && periods.length < 6; p = periodContaining(addDays(p.end, 1), settings)) {
    if (seen.has(p.start)) break;
    seen.add(p.start);
    if (p.paymentDueDate >= today && p.paymentDueDate < end) periods.push(p);
  }
  const out: HstInput[] = [];
  for (const p of periods) {
    let cents: number;
    if (p.end >= today) {
      // Not over yet: scale what's in so far (today included) to the whole period — once there's
      // about a week of it; earlier than that, one invoice would swing the guess wildly.
      const length = daysBetween(p.start, p.end) + 1;
      const elapsed = daysBetween(p.start, today) + 1;
      if (elapsed < MIN_HST_DAYS) {
        notes.push(`${p.label} HST not included yet - too early in the period to tell.`);
        continue;
      }
      const w = await worksheetFor(admin, { organizationId: s.organizationId, companyId: s.companyId, settings: { hst: settings } }, p);
      cents = Math.round((w.netCents * length) / elapsed);
    } else {
      cents = (await worksheetFor(admin, { organizationId: s.organizationId, companyId: s.companyId, settings: { hst: settings } }, p)).netCents;
    }
    if (cents > 0) out.push({ label: `${p.label} HST${p.end >= today ? " (so far, scaled)" : ""}`, dueDate: p.paymentDueDate, cents });
  }
  return out;
}

async function loadPos(db: Db, s: Scope): Promise<PoInput[]> {
  const { data, error } = await db
    .from("purchase_orders")
    .select("po_number, needed_by, est_total_cents, status, job_label")
    .eq("organization_id", s.organizationId)
    .eq("company_id", s.companyId)
    .in("status", ["approved", "sent", "confirmed", "ready"])
    .limit(500);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((p) => ({ label: clip(`${str(p.po_number) ?? "PO"} ${str(p.job_label) ?? ""}`, 40), neededBy: str(p.needed_by), cents: num(p.est_total_cents) }));
}

/** Fleet's rentals, if that table exists here (no hard dependency on its shape). */
async function loadRentals(db: Db, s: Scope, today: string, timeZone: string): Promise<RentalInput[]> {
  const { data, error } = await db.from("rentals").select("*").eq("organization_id", s.organizationId).eq("company_id", s.companyId).is("returned_at", null).limit(200);
  if (error) throw error;
  const day = (v: unknown) => (str(v) ? (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : localDay(Date.parse(String(v)), timeZone)) : null);
  const out: RentalInput[] = [];
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    // Fleet's column is rate_cents_per_day (20261014130000); the others are tolerated.
    const daily = num(r.rate_cents_per_day) || num(r.rate_per_day_cents) || num(r.daily_rate_cents) || num(r.rate_cents);
    if (!(daily > 0)) continue;
    const from = day(r.out_at) ?? today;
    const to = day(r.due_back_at) ?? addDays(today, 7);
    out.push({ label: clip(`${str(r.item) ?? str(r.name) ?? "Rental"}${str(r.vendor) ? ` (${str(r.vendor)})` : ""}`, 40), from, to: to < today ? today : to, dailyCents: daily });
  }
  return out;
}

/** Everything the forecast needs for one company, as of `nowMs`. */
export async function loadForecastInputs(admin: AdminClient, company: Scope, nowMs: number): Promise<ForecastInputs> {
  const db = admin as Db;
  const today = localDay(nowMs, company.timeZone);
  const end = addDays(today, HORIZON_DAYS);
  const single = await onlyCompany(db, company.organizationId);
  const notes: string[] = [];
  const take = <T>(l: Loaded<T>): T => {
    if (l.note) notes.push(l.note);
    return l.value;
  };
  const invoices = take(await tolerant("Invoices", { open: [], paid: [], averageJobCents: null }, () => loadInvoices(db, company, today)));
  const quotes = take(await tolerant("Approved quotes", { quotes: [], quoteIds: new Set<string>() }, () => loadQuotes(db, company, today)));
  const [jobs, series, renewals, expenses, labour, hst, pos, rentals] = await Promise.all([
    tolerant("Booked jobs", [] as JobInput[], () => loadJobs(db, company, today, end, quotes.quoteIds)),
    tolerant("Recurring visits", [] as SeriesInput[], () => loadSeries(db, company, today, end)),
    tolerant("Plan renewals", [] as RenewalInput[], () => loadRenewals(db, company, today, end)),
    tolerant("Expenses", [] as ExpenseInput[], () => loadExpenses(db, company, today, single)),
    tolerant("Payroll", [] as LabourInput[], () => loadLabour(db, company, nowMs, single)),
    tolerant("HST", [] as HstInput[], () => loadHst(admin, company, today, end, notes)),
    tolerant("Purchase orders", [] as PoInput[], () => loadPos(db, company)),
    // Fleet may not exist on this server: no note when the table simply isn't there.
    loadRentals(db, company, today, company.timeZone).then((value) => ({ value }), () => ({ value: [] as RentalInput[] })),
  ]);
  return {
    today,
    openInvoices: invoices.open,
    paidHistory: invoices.paid,
    quotes: quotes.quotes,
    jobs: take(jobs),
    series: take(series),
    renewals: take(renewals),
    expenses: take(expenses),
    labour: take(labour),
    averageJobCents: invoices.averageJobCents,
    hst: take(hst),
    pos: take(pos),
    rentals: rentals.value,
    notes,
  };
}

/** The forecast for one company now (never throws: a total failure gives null). */
export async function forecastFor(admin: AdminClient, company: Pick<ProfitCompany, "organizationId" | "companyId" | "timeZone" | "settings">, nowMs: number): Promise<Forecast | null> {
  try {
    const inputs = await loadForecastInputs(admin, company, nowMs);
    return buildForecast(inputs, { cushionCents: company.settings.tightCushionCents });
  } catch (err) {
    console.error("[profit-advisor] forecast failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
