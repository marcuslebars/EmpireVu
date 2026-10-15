/**
 * Phase 2 — the AI staff (docs/ai-staff.md), end to end on the done-for-you e2e stack
 * (scripts/e2e-dfy/README.md → "Phase 2 AI staff"). Real local Postgres (every migration) +
 * PostgREST + Next + the app's own worker code (inbound queue drain, runScheduler → the staff
 * sweeps) in this process; Twilio / Anthropic / Google Places / Environment Canada / Resend / Stripe are
 * the fakes in fakes.mjs (the "model" is scripted and builds every reply only from what it was
 * sent), storage is the gateway's stub. Run with scripts/e2e-dfy/staff.sh.
 *
 * The clock is moved to a Sunday 09:05 Toronto first, then forward through one week:
 *   Sun 09:05  routes · Estimator (photo → estimate → "Y n $900" → quote) · Bookkeeper (nothing on a
 *              Sunday, payment plan → Y, "who owes me")
 *   Sun 15:05  Dispatcher weather check → one weather_reschedule → Y → moved + texted
 *   Sun 18:05  crew schedule text
 *   Mon 08:30  no reminder before 9 · 09:30 reminder with pay link, queued plan text goes out
 *   Mon 09:45  crew job completed → no update text
 *   Mon 10:05  Marketer monthly win-back → approval → Y → throttled sends, STOP
 *   Tue 09:30  quote follow-up at +2d · Fri 09:30 the Estimator's own nudge at +5d
 *   then the house (A1-style) tenant: nothing happened there, and its SMS agent tool list is
 *   the Phase 1 list.
 */
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import Stripe from "stripe";

import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createDoneForYouCheckout } from "@/server/services/done-for-you/checkout";
import { claimBillingEventJobs } from "@/server/services/billing/jobs";
import { processBillingEventJob } from "@/server/services/billing/events";
import { switchOnEverything } from "@/server/services/dfy/switch-on";
import { processInboundWebhookJobs } from "@/server/services/inbound-webhook-jobs";
import { allAgentTools } from "@/server/services/sms-agent/tools";
import { activeRolesFor, resetStaffSweepClock, roleAgentTools, roleOwnerTools } from "@/server/services/staff/registry";
import { resumeDueWorkflowRuns, runScheduler } from "@/server/services/workflow-engine/scheduler";
import { claimWorkflowEventJobs, processWorkflowEventJob } from "@/server/services/workflow-event-jobs";

type Admin = ReturnType<typeof createSupabaseAdminClient>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any; // the Phase 2 tables aren't in database.types.ts yet

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
};
const HOUSE_APP = env("APP_BASE_URL");
const SUPABASE = env("NEXT_PUBLIC_SUPABASE_URL");
const CAPTURE = env("E2E_CAPTURE_LOG");
const OUT = env("E2E_STAFF_OUT", join(env("E2E_ROOT"), "staff-out"));
const CLOCK_FILE = env("E2E_CLOCK_FILE");
const PLATFORM = env("TWILIO_FROM_NUMBER");
const PASSWORD = "e2e-password-123";
const FAKES = `http://127.0.0.1:${env("E2E_FAKES_PORT")}`;
const TZ = "America/Toronto";

mkdirSync(OUT, { recursive: true });
const admin: Admin = createSupabaseAdminClient();
const db = admin as Db;

// ── reporting ────────────────────────────────────────────────────────────────
const results: Array<{ step: string; ok: boolean; notes: string[] }> = [];
let current: { step: string; ok: boolean; notes: string[] } | null = null;
let checks = 0;
let failedChecks = 0;
function check(cond: unknown, message: string): boolean {
  const ok = Boolean(cond);
  checks += 1;
  if (!ok) failedChecks += 1;
  console.log(`   ${ok ? "ok  " : "FAIL"} ${message}`);
  if (current) {
    current.notes.push(`${ok ? "ok" : "FAIL"}: ${message}`);
    if (!ok) current.ok = false;
  }
  return ok;
}
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n== ${name}`);
  current = { step: name, ok: true, notes: [] };
  try {
    await fn();
  } catch (err) {
    current.ok = false;
    failedChecks += 1;
    current.notes.push(`ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    console.log(`   ERROR ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
  results.push(current);
  current = null;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const torontoTime = (ms: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);
const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

// ── local dates / the fake clock ─────────────────────────────────────────────
function localParts(ms: number): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  );
}
const localDate = (ms: number) => {
  const p = localParts(ms);
  return `${p.year}-${p.month}-${p.day}`;
};
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Toronto local date + "HH:MM" → epoch ms (DST-aware). */
function at(date: string, hhmm: string): number {
  const probe = Date.parse(`${date}T${hhmm}:00Z`);
  const off = new Date(probe).toLocaleString("en-US", { timeZone: TZ, timeZoneName: "shortOffset" }).match(/GMT([+-]\d+)/)?.[1] ?? "-4";
  const h = Number(off);
  return Date.parse(`${date}T${hhmm}:00${h < 0 ? "-" : "+"}${String(Math.abs(h)).padStart(2, "0")}:00`);
}
function clockOffsetMinutes(): number {
  return Number(readFileSync(CLOCK_FILE, "utf8").trim().replace(/m$/, ""));
}
async function clockTo(targetMs: number): Promise<void> {
  const delta = Math.ceil((targetMs - Date.now()) / 60_000);
  if (delta <= 0) {
    console.log(`   (clock already at ${torontoTime(Date.now())})`);
    return;
  }
  const next = clockOffsetMinutes() + delta;
  writeFileSync(CLOCK_FILE, `${next >= 0 ? "+" : ""}${next}m\n`);
  await sleep(2500);
  console.log(`   clock → ${new Date().toISOString()} (${torontoTime(Date.now())} Toronto)`);
}

// ── captured third-party traffic ─────────────────────────────────────────────
interface Captured {
  t: string;
  kind: string;
  to?: string;
  from?: string;
  body?: string;
  [k: string]: unknown;
}
function captured(): Captured[] {
  return readFileSync(CAPTURE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Captured);
}
let mark = 0;
const sinceMark = () => captured().slice(mark);
const setMark = () => {
  mark = captured().length;
};
const smsTo = (list: Captured[], phone: string) => list.filter((c) => c.kind === "sms" && c.to === phone);
const allSms = (list: Captured[]) => list.filter((c) => c.kind === "sms");

// ── the worker loop (inbound queue + workflow events) and the scheduler tick ──
async function drain(): Promise<void> {
  // The workflow-event worker's loop body (src/server/workers/workflow-event-worker.ts).
  for (let i = 0; i < 8; i++) {
    const jobs = await claimWorkflowEventJobs(admin, { limit: 20, staleAfterSeconds: 900, workerId: "e2e-worker" });
    for (const job of jobs) await processWorkflowEventJob(admin, job).catch((e) => console.log("   workflow job error", e instanceof Error ? e.message : e));
    const inbound = await processInboundWebhookJobs(admin, { batch: 20, staleAfterSeconds: 900, workerId: "e2e-worker" });
    const resumed = await resumeDueWorkflowRuns(admin, { batch: 20, staleAfterSeconds: 900 });
    if (jobs.length === 0 && inbound === 0 && resumed === 0) break;
  }
}
/** One workflow-events worker tick: runScheduler (→ every staff sweep, throttle reset) + the queues. */
async function tick(): Promise<void> {
  resetStaffSweepClock();
  await runScheduler(admin, { workerId: "e2e-worker" });
  await drain();
}

// ── Twilio webhooks, signed ──────────────────────────────────────────────────
function twilioSignature(url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", env("TWILIO_AUTH_TOKEN")).update(Buffer.from(data, "utf8")).digest("base64");
}
let sidSeq = 0;
const newSid = (prefix: string) => `${prefix}${Date.now().toString(16)}${(++sidSeq).toString(16).padStart(4, "0")}`.padEnd(34, "0").slice(0, 34);
async function text(from: string, to: string, body: string, media: Array<{ url: string; type: string }> = []): Promise<void> {
  const params: Record<string, string> = { AccountSid: env("TWILIO_ACCOUNT_SID"), MessageSid: newSid(media.length ? "MM" : "SM"), From: from, To: to, Body: body, NumMedia: String(media.length) };
  media.forEach((m, i) => {
    params[`MediaUrl${i}`] = m.url;
    params[`MediaContentType${i}`] = m.type;
  });
  const url = `${HOUSE_APP}/api/twilio/sms/inbound`;
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(url, params) }, body: new URLSearchParams(params).toString() });
  if (res.status !== 200) console.log(`   inbound SMS webhook → ${res.status} ${await res.text()}`);
  await drain();
}
async function fakeControl(patch: Record<string, unknown>): Promise<void> {
  await fetch(`${FAKES}/__control`, { method: "POST", body: JSON.stringify(patch) });
}

// ── the app's API as a signed-in user (Bearer token from the auth stub) ──────
async function signInToken(email: string): Promise<string> {
  const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, { method: "POST", headers: { "content-type": "application/json", apikey: env("NEXT_PUBLIC_SUPABASE_ANON_KEY") }, body: JSON.stringify({ email, password: PASSWORD }) });
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error(`sign in ${email}: ${res.status} ${JSON.stringify(body)}`);
  return body.access_token;
}
async function api(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const res = await fetch(`${HOUSE_APP}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(t) as Record<string, unknown>;
  } catch {
    /* not json */
  }
  return { status: res.status, json, text: t };
}

// ── purchase (checkout → signed Stripe webhook → billing worker) ─────────────
interface Buyer {
  name: string;
  email: string;
  phone: string;
  businessName: string;
  businessType: string;
  tier: "catch" | "close" | "front_desk";
  orgId?: string;
  companyId?: string;
  purchaseId?: string;
  catcher?: string;
}
function fakeStripe(): Stripe {
  let n = 0;
  return {
    checkout: { sessions: { create: async () => ({ id: `cs_test_st_${Date.now().toString(36)}${++n}`, url: "https://checkout.stripe.test/c/pay/x" }) } },
    coupons: { retrieve: async () => ({ valid: false }) },
  } as unknown as Stripe;
}
async function buy(buyer: Buyer): Promise<void> {
  const checkout = await createDoneForYouCheckout(admin, { tier: buyer.tier, name: buyer.name, email: buyer.email, phone: buyer.phone, businessName: buyer.businessName, businessType: buyer.businessType }, fakeStripe());
  buyer.purchaseId = checkout.purchaseId;
  const suffix = checkout.purchaseId.slice(0, 8);
  const event = {
    id: `evt_st_${suffix}`,
    object: "event",
    type: "checkout.session.completed",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: {
      object: {
        id: checkout.sessionId,
        object: "checkout.session",
        mode: "subscription",
        payment_status: "paid",
        status: "complete",
        customer: `cus_st_${suffix}`,
        subscription: `sub_st_${suffix}`,
        customer_email: buyer.email,
        customer_details: { email: buyer.email, name: buyer.name, phone: buyer.phone },
        client_reference_id: checkout.purchaseId,
        metadata: { source: "crankleads", purchaseId: checkout.purchaseId, tier: buyer.tier, plan: "starter", businessName: buyer.businessName, businessType: buyer.businessType, ownerName: buyer.name, ownerPhone: buyer.phone, utm: "{}" },
      },
    },
  };
  const payload = JSON.stringify(event);
  const header = new Stripe(env("STRIPE_SECRET_KEY")).webhooks.generateTestHeaderString({ payload, secret: env("STRIPE_WEBHOOK_SECRET") });
  const res = await fetch(`${HOUSE_APP}/api/webhooks/stripe`, { method: "POST", headers: { "stripe-signature": header, "content-type": "application/json" }, body: payload });
  check(res.status === 200, `Stripe webhook accepted (${res.status})`);
  for (let i = 0; i < 3; i++) {
    const jobs = await claimBillingEventJobs(admin, { limit: 10, staleAfterSeconds: 900, workerId: "e2e-billing" });
    for (const job of jobs) await processBillingEventJob(admin, job).catch((e) => console.log("   billing job error", e));
    if (jobs.length === 0) break;
  }
  const { data: purchase } = await admin.from("crankleads_purchases").select("*").eq("id", checkout.purchaseId).single();
  buyer.orgId = purchase?.organization_id ?? undefined;
  buyer.companyId = purchase?.company_id ?? undefined;
  check(purchase?.status === "provisioned", `purchase provisioned (${purchase?.status} ${purchase?.last_error ?? ""})`);
}

// ════════════════════════════════════════════════════════════════════════════
const dana: Buyer = { name: "Dana Whitfield", email: "dana@northshoresnow.ca", phone: "+17055550142", businessName: "Northshore Snow & Lawn", businessType: "Property maintenance & snow", tier: "close" };
const RILEY = { first: "Riley", last: "Shaw", phone: "+17055550201" }; // estimator
const BOB = { first: "Bob", last: "Jones", phone: "+17055550202" }; // overdue invoice → reminder
const PAT = { first: "Pat", last: "Kerr", phone: "+17055550203" }; // payment plan
const SAM = { first: "Sam", last: "Lee", phone: "+17055550204" }; // weather job 1
const JO = { first: "Jo", last: "Park", phone: "+17055550205" }; // weather job 2
const AL = { first: "Al", last: "Grant", phone: "+17055550206" }; // crew job customer
const MIKE = { name: "Mike Tran", email: "mike@northshoresnow.ca", phone: "+17055550290" }; // crew
const PAST = [
  { first: "Ava", last: "Stone", phone: "+17055550311", monthsAgo: 10 },
  { first: "Ben", last: "Ross", phone: "+17055550312", monthsAgo: 12 },
  { first: "Cara", last: "Diaz", phone: "+17055550313", monthsAgo: 14 },
  { first: "Dev", last: "Shah", phone: "+17055550314", monthsAgo: 16 },
  { first: "Eli", last: "Ward", phone: "+17055550315", monthsAgo: 18 },
  { first: "Fay", last: "Cole", phone: "+17055550316", monthsAgo: 20 },
  { first: "Gus", last: "Hall", phone: "+17055550317", monthsAgo: 13 },
  { first: "Gina", last: "Hall", phone: "+17055550317", monthsAgo: 11 }, // same number as Gus
  { first: "Hal", last: "Recent", phone: "+17055550318", monthsAgo: 3 }, // too recent
  { first: "Ivy", last: "Old", phone: "+17055550319", monthsAgo: 30 }, // too old
];
const WINBACK_NUMBERS = [...new Set(PAST.filter((p) => p.monthsAgo >= 9 && p.monthsAgo <= 24).map((p) => p.phone))];
const HOUSE = { owner: "+17055550111", catcher: "+17055550161", customer: "+17055550190", debtor: "+17055550191", past: "+17055550192", crew: "+17055550193", jobCustomer: "+17055550194" };

const ids: Record<string, string> = {};
let houseIds: { orgId: string; companyId: string } | null = null;
let SUNDAY = "";
let danaToken = "";
let mikeProfileId = "";
let quoteSentAtMs = 0;

async function contact(scope: { orgId: string; companyId: string }, p: { first: string; last: string; phone: string }, extra: Record<string, unknown> = {}): Promise<string> {
  const row = must(
    await db.from("contacts").insert({ organization_id: scope.orgId, company_id: scope.companyId, first_name: p.first, last_name: p.last, phone: p.phone, ...extra }).select("id").single(),
    `contact ${p.first}`,
  ) as { id: string };
  return row.id;
}
async function invoice(scope: { orgId: string; companyId: string }, contactId: string, input: { number: string; cents: number; dueDaysAgo: number; title: string }): Promise<string> {
  const today = localDate(Date.now());
  const row = must(
    await db
      .from("invoices")
      .insert({
        organization_id: scope.orgId,
        company_id: scope.companyId,
        contact_id: contactId,
        invoice_number: input.number,
        public_token: `inv_${input.number.toLowerCase().replace(/[^a-z0-9]/g, "")}_${Math.random().toString(36).slice(2, 10)}`,
        status: "sent",
        title: input.title,
        line_items: [{ label: input.title, quantity: 1, unit_cents: input.cents, amount_cents: input.cents }],
        subtotal_cents: input.cents,
        total_cents: input.cents,
        balance_due_cents: input.cents,
        issue_date: addDays(today, -input.dueDaysAgo - 14),
        due_date: addDays(today, -input.dueDaysAgo),
        sent_at: new Date(Date.now() - (input.dueDaysAgo + 14) * 86_400_000).toISOString(),
      })
      .select("id")
      .single(),
    `invoice ${input.number}`,
  ) as { id: string };
  return row.id;
}
async function booking(scope: { orgId: string; companyId: string }, input: { contactId: string | null; title: string; at: number; minutes: number; status?: string; serviceItemId?: string | null; location?: string }): Promise<string> {
  const row = must(
    await db
      .from("bookings")
      .insert({
        organization_id: scope.orgId,
        company_id: scope.companyId,
        contact_id: input.contactId,
        title: input.title,
        scheduled_for: new Date(input.at).toISOString(),
        duration_minutes: input.minutes,
        status: input.status ?? "confirmed",
        service_item_id: input.serviceItemId ?? null,
        location: input.location ?? null,
        ...(input.status === "completed" ? { completed_at: new Date(input.at + input.minutes * 60_000).toISOString() } : {}),
      })
      .select("id")
      .single(),
    `booking ${input.title}`,
  ) as { id: string };
  return row.id;
}
async function crewMember(orgId: string, person: { name: string; email: string }): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email: person.email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: person.name } });
  if (error || !data.user) throw new Error(`crew user: ${error?.message}`);
  const profileId = data.user.id;
  const { data: prof } = await db.from("profiles").select("id").eq("id", profileId).maybeSingle();
  if (!prof) must(await db.from("profiles").insert({ id: profileId, email: person.email, full_name: person.name }).select("id").single(), "crew profile");
  else await db.from("profiles").update({ full_name: person.name }).eq("id", profileId);
  must(await db.from("organization_memberships").insert({ organization_id: orgId, profile_id: profileId, role: "member" }).select("id").single(), "crew membership");
  return profileId;
}
async function latestApproval(companyId: string, kind: string): Promise<{ id: string; short_code: number; status: string; summary: string; payload: Record<string, unknown>; result: Record<string, unknown> | null } | null> {
  const { data } = await db.from("owner_approvals").select("*").eq("company_id", companyId).eq("kind", kind).order("created_at", { ascending: false }).limit(1);
  return (data ?? [])[0] ?? null;
}

async function seedHouse(): Promise<void> {
  const org = must(await db.from("organizations").insert({ name: "A1 Group (house)", slug: "a1-group-house-st", subscription_status: "active" }).select("id").single(), "house org") as { id: string };
  const company = must(
    await db
      .from("companies")
      .insert({ organization_id: org.id, name: "A1 Marine Care", slug: "a1-marine-care-st", timezone: TZ, owner_phone_e164: HOUSE.owner, owner_phone_verified_at: new Date().toISOString(), owner_email: "owner@a1.test", website: "https://a1marine.test", google_place_id: "ChIJn0rthSh0reSn0wMidland01" })
      .select("id")
      .single(),
    "house company",
  ) as { id: string };
  must(await db.from("voice_numbers").insert({ organization_id: org.id, company_id: company.id, provider: "twilio", mode: "missed_call_catcher", phone_e164: HOUSE.catcher, active: true }).select("id").single(), "house number");
  houseIds = { orgId: org.id, companyId: company.id };
  const scope = houseIds;
  // The same shapes the CrankLeads company gets: an overdue invoice, a past customer, jobs tomorrow, a crew cell.
  const debtor = await contact(scope, { first: "Hank", last: "Owes", phone: HOUSE.debtor });
  await invoice(scope, debtor, { number: "A1-0001", cents: 80000, dueDaysAgo: 5, title: "Winterize boat" });
  const past = await contact(scope, { first: "Paula", last: "Past", phone: HOUSE.past });
  await booking(scope, { contactId: past, title: "Shrink wrap", at: Date.now() - 365 * 86_400_000, minutes: 60, status: "completed" });
  const jobCust = await contact(scope, { first: "Jill", last: "Dock", phone: HOUSE.jobCustomer });
  const tomorrow = addDays(localDate(Date.now()), 1);
  const houseJob = await booking(scope, { contactId: jobCust, title: "Dock repair", at: at(tomorrow, "10:00"), minutes: 120, location: "1 Harbour Rd, Midland" });
  ids.houseJob = houseJob;
  const crew = await crewMember(org.id, { name: "Hugo Crew", email: "hugo@a1.test" });
  must(await db.from("organization_memberships").update({ phone_e164: HOUSE.crew }).eq("organization_id", org.id).eq("profile_id", crew).select("id"), "house crew phone");
  must(await db.from("booking_assignments").insert({ organization_id: org.id, booking_id: houseJob, profile_id: crew }).select("id").single(), "house assignment");
  await db.from("companies").update({ latitude: 44.75, longitude: -79.89 }).eq("id", company.id);
}

async function main(): Promise<void> {
  // ── start on a Sunday 09:05 (so every weekday / hour rule below is deterministic) ──
  {
    const p = localParts(Date.now());
    const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
    SUNDAY = addDays(localDate(Date.now()), wd === 0 ? 0 : 7 - wd);
    await clockTo(at(SUNDAY, "09:05"));
    console.log(`clock now ${new Date().toISOString()} (${torontoTime(Date.now())} Toronto); Sunday = ${SUNDAY}`);
  }
  const MONDAY = addDays(SUNDAY, 1);
  const TUESDAY = addDays(SUNDAY, 2);
  const FRIDAY = addDays(SUNDAY, 5);
  const scope = () => ({ orgId: dana.orgId!, companyId: dana.companyId! });

  await step("0. seed: a live CrankLeads Close company (purchase → switch-on → live) with customers, invoices, jobs, a crew cell, past customers; a house tenant with the same", async () => {
    await seedHouse();
    await buy(dana);
    const { data: numbers } = await admin.from("voice_numbers").select("phone_e164, mode").eq("company_id", dana.companyId!);
    dana.catcher = (numbers ?? []).find((n) => n.mode === "missed_call_catcher")?.phone_e164;
    check(dana.catcher?.startsWith("+1705"), `company number ${dana.catcher}`);
    must(
      await db
        .from("companies")
        .update({
          hours: { summary: "Monday: 7:00 AM – 6:00 PM; Tuesday: 7:00 AM – 6:00 PM; Wednesday: 7:00 AM – 6:00 PM; Thursday: 7:00 AM – 6:00 PM; Friday: 7:00 AM – 6:00 PM; Saturday: 8:00 AM – 12:00 PM; Sunday: Closed" },
          service_area: "Midland and surrounding area",
          timezone: TZ,
          owner_email: dana.email,
          website: "https://northshoresnow.ca",
          google_place_id: "ChIJn0rthSh0reSn0wMidland01",
        })
        .eq("id", dana.companyId!)
        .select("id"),
      "company facts",
    );
    const items = must(
      await db
        .from("service_catalog_items")
        .upsert(
          [
            { organization_id: dana.orgId!, company_id: dana.companyId!, service_key: "seasonal_double_driveway", label: "Seasonal snow contract — double driveway", pricing_type: "flat", rate_cents: 65000, minimum_cents: 0, active: true, sort_order: 1 },
            { organization_id: dana.orgId!, company_id: dana.companyId!, service_key: "spring_cleanup", label: "Spring cleanup", pricing_type: "flat", rate_cents: 25000, minimum_cents: 0, active: true, sort_order: 2 },
          ],
          { onConflict: "company_id,service_key" },
        )
        .select("id, service_key"),
      "catalog",
    ) as Array<{ id: string; service_key: string }>;
    ids.cleanupItem = items.find((i) => i.service_key === "spring_cleanup")!.id;
    const switched = await switchOnEverything({ organizationId: dana.orgId!, actorProfileId: null, supabase: admin as never }, dana.companyId!, "close");
    console.log(`   switch-on: ${JSON.stringify(switched).slice(0, 200)}`);
    const now = new Date().toISOString();
    must(await db.from("crankleads_purchases").update({ live_at: now, setup_followups_exempt_at: now }).eq("id", dana.purchaseId!).select("id"), "live");

    // Bookkeeper: Bob's invoice was due 3 days before Monday (so Monday is day 3 → the first text); Pat owes $1,200.
    ids.bob = await contact(scope(), BOB);
    ids.bobInvoice = await invoice(scope(), ids.bob, { number: "INV-2026-0012", cents: 124000, dueDaysAgo: 2, title: "Fall cleanup" });
    ids.pat = await contact(scope(), PAT);
    ids.patInvoice = await invoice(scope(), ids.pat, { number: "INV-2026-0013", cents: 120000, dueDaysAgo: 9, title: "Interlock repair" });
    // Dispatcher: two weather-sensitive (spring cleanup) jobs Monday, one crew job Monday (not weather-sensitive).
    ids.sam = await contact(scope(), SAM);
    ids.jo = await contact(scope(), JO);
    ids.al = await contact(scope(), AL);
    ids.samJob = await booking(scope(), { contactId: ids.sam, title: "Spring cleanup", at: at(MONDAY, "09:00"), minutes: 120, serviceItemId: ids.cleanupItem, location: "12 Bay St, Midland" });
    ids.joJob = await booking(scope(), { contactId: ids.jo, title: "Spring cleanup", at: at(MONDAY, "13:00"), minutes: 120, serviceItemId: ids.cleanupItem, location: "40 Elm St, Midland" });
    ids.alJob = await booking(scope(), { contactId: ids.al, title: "Salt driveway and walkway", at: at(MONDAY, "08:00"), minutes: 60, location: "88 King St, Midland" });
    mikeProfileId = await crewMember(dana.orgId!, MIKE);
    must(await db.from("booking_assignments").insert({ organization_id: dana.orgId!, booking_id: ids.alJob, profile_id: mikeProfileId }).select("id").single(), "assignment");
    // Marketer: past customers (a completed job N months ago each).
    for (const p of PAST) {
      // Ben came in through a web form 14 months ago: implied consent, long lapsed (his purchase still allows the campaign).
      const id = await contact(scope(), p, p.first === "Ben" ? { consent_source: "implied_inquiry", sms_consent_at: new Date(Date.now() - 425 * 86_400_000).toISOString() } : {});
      ids[`past:${p.first}`] = id;
      await booking(scope(), { contactId: id, title: "Fall cleanup", at: Date.now() - p.monthsAgo * 30.4 * 86_400_000, minutes: 90, status: "completed" });
    }
    await drain();
    setMark();
  });

  await step("R. the role settings routes and the member-cell routes answer for the owner (real Next routes, Bearer token)", async () => {
    danaToken = await signInToken(dana.email);
    const base = `/api/organizations/${dana.orgId}/companies/${dana.companyId}/ai-settings`;
    for (const key of ["estimator", "collections", "dispatch", "marketing"]) {
      const r = await api(danaToken, "GET", `${base}/${key}`);
      check(r.status === 200, `GET ai-settings/${key} → ${r.status}${r.status !== 200 ? ` ${r.text.slice(0, 200)}` : ""}`);
    }
    const est = await api(danaToken, "GET", `${base}/estimator`);
    console.log(`   estimator settings: ${JSON.stringify(est.json).slice(0, 300)}`);
    const patch = await api(danaToken, "PATCH", `${base}/dispatch`, { weather: { enabled: true, sensitive: ["spring_cleanup"] } });
    check(patch.status === 200, `PATCH ai-settings/dispatch weather.sensitive = [spring_cleanup] → ${patch.status} ${patch.status !== 200 ? patch.text.slice(0, 200) : ""}`);
    const { data: c } = await db.from("companies").select("ai_settings").eq("id", dana.companyId!).single();
    const dispatch = (c?.ai_settings as Record<string, Record<string, Record<string, unknown>>>)?.dispatch;
    check(JSON.stringify(dispatch?.weather?.sensitive) === '["spring_cleanup"]', `stored ai_settings.dispatch.weather.sensitive ${JSON.stringify(dispatch?.weather?.sensitive)}`);
    const phone = await api(danaToken, "PUT", `/api/organizations/${dana.orgId}/members/${mikeProfileId}/phone`, { phone: "705-555-0290" });
    check(phone.status === 200, `owner sets the crew member's cell → ${phone.status} ${phone.status !== 200 ? phone.text.slice(0, 200) : ""}`);
    const { data: m } = await db.from("organization_memberships").select("phone_e164").eq("organization_id", dana.orgId!).eq("profile_id", mikeProfileId).single();
    check(m?.phone_e164 === MIKE.phone, `organization_memberships.phone_e164 = ${m?.phone_e164}`);
    const phones = await api(danaToken, "GET", `/api/organizations/${dana.orgId}/members/phones`);
    check(phones.status === 200 && phones.text.includes("0290"), `GET members/phones lists the cell (${phones.status})`);
    // A crew member can't set someone else's cell.
    const mikeToken = await signInToken(MIKE.email);
    const ownerProfile = (await db.from("organization_memberships").select("profile_id").eq("organization_id", dana.orgId!).eq("role", "owner").single()).data?.profile_id;
    const denied = await api(mikeToken, "PUT", `/api/organizations/${dana.orgId}/members/${ownerProfile}/phone`, { phone: "705-555-0299" });
    check(denied.status === 403 || denied.status === 404, `a member can't change the owner's cell (${denied.status})`);
    // Members can read the role settings; only owners/admins can change them.
    const mikeRead = await api(mikeToken, "GET", `${base}/marketing`);
    check(mikeRead.status === 200, `a member can read ai-settings/marketing (${mikeRead.status})`);
    const mikeWrite = await api(mikeToken, "PATCH", `${base}/marketing`, { winBack: { enabled: false } });
    check(mikeWrite.status === 403, `a member can't PATCH ai-settings/marketing (${mikeWrite.status})`);
    // RLS: a member reads the role tables of their own org through PostgREST, never writes.
    const rest = await fetch(`${SUPABASE}/rest/v1/estimate_requests?select=id&limit=1`, { headers: { apikey: env("NEXT_PUBLIC_SUPABASE_ANON_KEY"), authorization: `Bearer ${mikeToken}` } });
    check(rest.status === 200, `member SELECT estimate_requests via PostgREST → ${rest.status}`);
    const write = await fetch(`${SUPABASE}/rest/v1/marketing_campaigns`, {
      method: "POST",
      headers: { apikey: env("NEXT_PUBLIC_SUPABASE_ANON_KEY"), authorization: `Bearer ${danaToken}`, "content-type": "application/json" },
      body: JSON.stringify({ organization_id: dana.orgId, company_id: dana.companyId, kind: "win_back", status: "sending", message: "x" }),
    });
    check(write.status === 401 || write.status === 403, `even the owner can't INSERT marketing_campaigns from the client (${write.status})`);
    setMark();
  });

  await step("E1. Estimator: photo + 'how much to fix my fascia?' → request_estimate → photo stored → ai_estimate to the owner (no price to the customer)", async () => {
    const mediaUrl = `https://api.twilio.com/2010-04-01/Accounts/${env("TWILIO_ACCOUNT_SID")}/Messages/MM${"c".repeat(32)}/Media/ME${"d".repeat(32)}`;
    await text(RILEY.phone, dana.catcher!, "Hi, a branch tore the fascia off the front of the house. How much to fix my fascia?", [{ url: mediaUrl, type: "image/png" }]);
    const got = sinceMark();
    const turns = got.filter((c) => c.kind === "anthropic" && c.purpose === "sms_agent");
    check(turns.some((t) => (t.tools as string[] | undefined)?.includes("request_estimate")), "the SMS agent is offered request_estimate (estimator on for this company)");
    const vision = got.filter((c) => c.kind === "anthropic" && c.purpose === "estimator_vision");
    check(vision.length === 1 && Number(vision[0].images) === 1, `ONE vision estimate call with the photo (${vision.length}, images ${vision[0]?.images})`);
    check(/fascia/i.test(String(vision[0]?.described)), "the customer's words reached the estimator (fenced)");
    const { data: contactRow } = await db.from("contacts").select("id").eq("company_id", dana.companyId!).eq("phone_last10", RILEY.phone.slice(-10)).maybeSingle();
    ids.riley = contactRow?.id;
    const { data: est } = await db.from("estimate_requests").select("*").eq("company_id", dana.companyId!).eq("contact_id", ids.riley);
    const e = (est ?? [])[0];
    check((est ?? []).length === 1 && e.status === "awaiting_owner", `estimate_requests: one, awaiting_owner (${e?.status} ${e?.error ?? ""})`);
    check(e?.estimate?.subtotalCents === 75000 && e?.estimate?.taxCents === 9750, `estimate priced with the quote math: ${e?.estimate?.subtotalCents} + HST ${e?.estimate?.taxCents}`);
    const photo = (e?.photos ?? [])[0];
    check(photo?.storage_path?.startsWith(`${dana.orgId}/${dana.companyId}/${e?.id}/`), `photo copied to quote-photos at ${photo?.storage_path}`);
    const stored = await fetch(`${SUPABASE}/storage/v1/object/quote-photos/${photo?.storage_path ?? "-"}`, { headers: { authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}` } });
    const bytes = Buffer.from(await stored.arrayBuffer());
    check(stored.status === 200 && bytes.subarray(1, 4).toString() === "PNG" && existsSync(join(env("E2E_ROOT"), "storage", "quote-photos", photo?.storage_path ?? "-")), `the photo's bytes are in the private quote-photos bucket (${stored.status}, ${bytes.length} bytes)`);
    const appr = await latestApproval(dana.companyId!, "ai_estimate");
    ids.estimateApproval = appr?.id ?? "";
    check(appr?.status === "pending" && e?.approval_id === appr?.id, `ai_estimate approval #${appr?.short_code} pending and linked`);
    const ask = smsTo(got, dana.phone).find((m) => /AI estimate/i.test(String(m.body)));
    check(ask && ask.from === PLATFORM, `owner asked from the platform number: "${String(ask?.body).slice(0, 260)}"`);
    check(/\$750/.test(String(ask?.body)) && /HST/.test(String(ask?.body)) && /Confidence: medium/i.test(String(ask?.body)) && new RegExp(`Y ${appr?.short_code} \\$price`).test(String(ask?.body)), "owner text: lines, $750 + HST, confidence, 'Y n $price'");
    const toRiley = smsTo(got, RILEY.phone);
    check(toRiley.length === 1 && toRiley[0].from === dana.catcher, `one reply to the customer from the company number: "${toRiley[0]?.body}"`);
    check(!/\$\s?\d/.test(String(toRiley[0]?.body)), "the customer is NOT told any price before the owner approves");
    setMark();
  });

  await step("E2. owner 'Y n $900' → quote (source estimator, $900 + HST) → link texted to the customer once; estimate sent", async () => {
    const appr = await latestApproval(dana.companyId!, "ai_estimate");
    await text(dana.phone, PLATFORM, `Y ${appr?.short_code} $900`);
    const got = sinceMark();
    quoteSentAtMs = Date.now();
    const toRiley = smsTo(got, RILEY.phone);
    check(toRiley.length === 1 && /\/q\//.test(String(toRiley[0]?.body)) && /\$900/.test(String(toRiley[0]?.body)) && toRiley[0].from === dana.catcher, `customer gets the $900 quote link from the company number: "${toRiley[0]?.body}"`);
    const ownerLine = smsTo(got, dana.phone);
    check(ownerLine.length === 1 && ownerLine[0].from === PLATFORM, `owner result line: "${ownerLine[0]?.body}"`);
    const { data: quotes } = await db.from("quotes").select("id, source, subtotal_cents, total_cents, status, sent_at").eq("company_id", dana.companyId!).eq("contact_id", ids.riley);
    const q = (quotes ?? [])[0];
    ids.rileyQuote = q?.id;
    check((quotes ?? []).length === 1 && q.source === "estimator" && q.subtotal_cents === 90000 && q.total_cents === 101700, `one quote: source ${q?.source}, ${q?.subtotal_cents} → ${q?.total_cents} with HST (${q?.status})`);
    const { data: e } = await db.from("estimate_requests").select("status, quote_id, decision_claimed_at").eq("approval_id", appr?.id).single();
    check(e?.status === "sent" && e?.quote_id === q?.id && e?.decision_claimed_at, `estimate_requests → sent, quote linked (${e?.status})`);
    const after = await latestApproval(dana.companyId!, "ai_estimate");
    check(after?.status === "executed", `approval executed (${after?.status})`);
    setMark();
    await text(dana.phone, PLATFORM, `Y ${appr?.short_code}`);
    check(smsTo(sinceMark(), RILEY.phone).length === 0, "a repeat 'Y' sends nothing again");
    setMark();
  });

  await step("B1. Bookkeeper: Sunday → no reminder texts (Mon–Sat only); 'can I do 3 payments?' → payment_plan → owner Y → plan + confirmation queued for Monday 9am", async () => {
    await tick();
    let got = sinceMark();
    check(smsTo(got, BOB.phone).length === 0 && smsTo(got, PAT.phone).length === 0, "no reminder texts on a Sunday");
    const { data: none } = await db.from("invoice_reminder_texts").select("id").eq("company_id", dana.companyId!);
    check((none ?? []).length === 0, `no invoice_reminder_texts claimed (${(none ?? []).length})`);
    setMark();
    await text(PAT.phone, dana.catcher!, "Hi, I can't pay the whole $1,200 right now - can I do 3 payments?");
    got = sinceMark();
    const turns = got.filter((c) => c.kind === "anthropic" && c.purpose === "sms_agent");
    check(turns.some((t) => (t.tools as string[] | undefined)?.includes("request_payment_plan")), "the SMS agent is offered request_payment_plan");
    const appr = await latestApproval(dana.companyId!, "payment_plan");
    check(appr?.status === "pending", `payment_plan approval #${appr?.short_code} pending`);
    const ask = smsTo(got, dana.phone).find((m) => /payment plan/i.test(String(m.body)));
    check(ask && ask.from === PLATFORM && /3 payments of \$400/.test(String(ask.body)) && /INV-2026-0013/.test(String(ask.body)), `owner asked: "${String(ask?.body).slice(0, 300)}"`);
    const toPat = smsTo(got, PAT.phone);
    check(toPat.length === 1 && /check/i.test(String(toPat[0].body)) && !/\$/.test(String(toPat[0].body)), `customer told we're checking (no promise): "${toPat[0]?.body}"`);
    setMark();
    await text(dana.phone, PLATFORM, `Y ${appr?.short_code}`);
    got = sinceMark();
    const result = smsTo(got, dana.phone);
    check(result.length === 1 && /plan/i.test(String(result[0].body)), `owner result: "${result[0]?.body}"`);
    const { data: plans } = await db.from("payment_plans").select("status, total_cents, instalments, approval_id").eq("invoice_id", ids.patInvoice);
    check((plans ?? []).length === 1 && plans![0].status === "active" && plans![0].total_cents === 120000 && (plans![0].instalments as unknown[]).length === 3, `payment_plans: one active, 3 instalments, $1,200 (${JSON.stringify(plans?.[0]?.instalments)?.slice(0, 160)})`);
    const { data: coll } = await db.from("invoice_collections").select("hold_reason, hold_until").eq("invoice_id", ids.patInvoice).single();
    check(coll?.hold_reason === "payment_plan" && coll?.hold_until, `reminders held by the plan until ${coll?.hold_until}`);
    const { data: queued } = await db.from("invoice_reminder_texts").select("status, kind, reminder_key, body").eq("invoice_id", ids.patInvoice);
    const confirm = (queued ?? []).find((r: { reminder_key: string }) => /:confirm$/.test(r.reminder_key));
    check(confirm?.status === "queued" && smsTo(got, PAT.phone).length === 0, `Sunday → the plan confirmation is queued, not sent (${confirm?.status})`);
    check(/\/i\//.test(String(confirm?.body)) && /\$400/.test(String(confirm?.body)), `queued confirmation has the plan + pay link: "${String(confirm?.body).slice(0, 200)}"`);
    setMark();
  });

  await step("B2. owner 'who owes me' → the owner agent's who_owes_me answer", async () => {
    await text(dana.phone, PLATFORM, "who owes me");
    const got = sinceMark();
    const turn = got.filter((c) => c.kind === "anthropic" && c.purpose === "owner_agent");
    check(turn.some((t) => (t.tools as string[] | undefined)?.includes("who_owes_me")), "the owner agent is offered who_owes_me");
    const answer = smsTo(got, dana.phone);
    console.log(`   answer: ${answer[0]?.body}`);
    check(answer.length === 1 && answer[0].from === PLATFORM && /\$2,440/.test(String(answer[0].body)) && /Bob Jones/.test(String(answer[0].body)) && /Pat Kerr/.test(String(answer[0].body)), "answer: $2,440 outstanding, Bob Jones and Pat Kerr");
    setMark();
  });

  await step("D1. Dispatcher 15:00: rain Monday → ONE weather_reschedule approval → owner Y → both spring cleanups moved off Monday, customers texted with their link", async () => {
    await fakeControl({ rain: [{ fromMs: at(MONDAY, "00:00"), toMs: at(TUESDAY, "00:00") }] });
    await clockTo(at(SUNDAY, "15:05"));
    await tick();
    let got = sinceMark();
    const weather = got.filter((c) => c.kind === "weather");
    check(weather.length >= 1 && weather[0].host === "dd.weather.gc.ca" && weather[0].site === "s0000105", `Environment Canada forecast fetched (${weather.length}) for site ${weather[0]?.site} (Midland)`);
    const { data: co } = await db.from("companies").select("latitude, longitude, location_source").eq("id", dana.companyId!).single();
    check(co?.latitude && co?.location_source === "google_place", `company geocoded from its Google listing (${co?.latitude}, ${co?.longitude}, ${co?.location_source})`);
    const { data: approvals } = await db.from("owner_approvals").select("*").eq("company_id", dana.companyId!).eq("kind", "weather_reschedule");
    check((approvals ?? []).length === 1, `ONE weather_reschedule approval (${(approvals ?? []).length})`);
    const appr = approvals?.[0];
    const moves = (appr?.payload?.moves ?? []) as Array<{ bookingId: string; toStartsAt: string }>;
    check(moves.length === 2 && moves.every((m) => [ids.samJob, ids.joJob].includes(m.bookingId)), `both rain-day spring cleanups proposed, not the crew job (${moves.length})`);
    check(moves.every((m) => localDate(Date.parse(m.toStartsAt)) !== MONDAY), `new times are off Monday: ${moves.map((m) => torontoTime(Date.parse(m.toStartsAt))).join(", ")}`);
    const ask = smsTo(got, dana.phone).find((m) => /Weather/i.test(String(m.body)));
    check(ask && ask.from === PLATFORM && /rain/i.test(String(ask.body)) && new RegExp(`Reply Y ${appr?.short_code}`).test(String(ask.body)), `owner text: "${String(ask?.body).slice(0, 320)}"`);
    check(smsTo(got, SAM.phone).length === 0 && smsTo(got, JO.phone).length === 0, "nothing moved or texted before the owner's Y");
    setMark();
    await tick();
    const { data: again } = await db.from("owner_approvals").select("id").eq("company_id", dana.companyId!).eq("kind", "weather_reschedule");
    check((again ?? []).length === 1, "a second pass the same day asks nothing new");
    setMark();
    await text(dana.phone, PLATFORM, `Y ${appr?.short_code}`);
    got = sinceMark();
    const { data: moved } = await db.from("bookings").select("id, scheduled_for, status").in("id", [ids.samJob, ids.joJob, ids.alJob]);
    const byId = new Map((moved ?? []).map((b: { id: string; scheduled_for: string }) => [b.id, b.scheduled_for]));
    for (const m of moves) check(Date.parse(String(byId.get(m.bookingId))) === Date.parse(m.toStartsAt), `booking moved to ${torontoTime(Date.parse(m.toStartsAt))}`);
    check(Date.parse(String(byId.get(ids.alJob))) === at(MONDAY, "08:00"), "the crew job (not weather-sensitive) stays Monday 08:00");
    for (const who of [SAM, JO]) {
      const t = smsTo(got, who.phone);
      check(t.length === 1 && t[0].from === dana.catcher && /\/v\//.test(String(t[0].body)) && /Northshore/.test(String(t[0].body)), `${who.first} texted the new time + manage link: "${t[0]?.body}"`);
    }
    const result = smsTo(got, dana.phone);
    check(result.length === 1 && /Moved 2 jobs/i.test(String(result[0].body)), `owner result: "${result[0]?.body}"`);
    const { data: msgs } = await db.from("dispatch_messages").select("kind, status").eq("company_id", dana.companyId!).eq("kind", "job_moved");
    check((msgs ?? []).length === 2 && msgs!.every((m: { status: string }) => m.status === "sent"), `dispatch_messages job_moved ×2 sent (${JSON.stringify(msgs)})`);
    setMark();
    await tick();
    const offers = sinceMark();
    check(smsTo(offers, SAM.phone).length + smsTo(offers, JO.phone).length === 0, "no gap offers for the slots the Dispatcher emptied itself");
    setMark();
  });

  await step("D2. 18:00: the crew member with a cell gets tomorrow's schedule text (once)", async () => {
    await clockTo(at(SUNDAY, "18:05"));
    await tick();
    let got = sinceMark();
    const toMike = smsTo(got, MIKE.phone);
    check(toMike.length === 1 && toMike[0].from === dana.catcher, `one crew text from the company number (${toMike.length})`);
    const body = String(toMike[0]?.body ?? "");
    console.log(`   crew text: ${body.replace(/\n/g, " | ")}`);
    check(/your jobs tomorrow/i.test(body) && /Al\b/.test(body) && /88 King St/.test(body) && /maps\.google\.com/.test(body) && /8:00/.test(body), "time, customer first name, short address, map link");
    check(!/Sam|Jo\b/.test(body), "only the jobs assigned to this crew member");
    setMark();
    await tick();
    got = sinceMark();
    check(smsTo(got, MIKE.phone).length === 0, "a second pass sends nothing");
    setMark();
  });

  await step("B3. Monday 08:30 (outside 9–20) → no reminder; 09:30 → Bob's reminder with the pay link, Pat's queued plan text goes out", async () => {
    await clockTo(at(MONDAY, "08:30"));
    await tick();
    let got = sinceMark();
    check(smsTo(got, BOB.phone).length === 0 && smsTo(got, PAT.phone).length === 0, "no Bookkeeper text before 09:00");
    setMark();
    await clockTo(at(MONDAY, "09:30"));
    await tick();
    got = sinceMark();
    const toBob = smsTo(got, BOB.phone);
    check(toBob.length === 1 && toBob[0].from === dana.catcher, `one reminder to Bob from the company number (${toBob.length})`);
    const body = String(toBob[0]?.body ?? "");
    console.log(`   reminder: ${body}`);
    check(/INV-2026-0012/.test(body) && /\$1,240\.00/.test(body) && /\/i\/inv_/.test(body) && /Northshore Snow & Lawn/.test(body), "invoice number, amount, pay link, business name");
    check(/Reply STOP/i.test(body) && !/empire\s*vu|crank\s*leads|ever\s*doer/i.test(body.replace(/https?:\/\/\S+/g, "")), "STOP footer, no platform name");
    const { data: rt } = await db.from("invoice_reminder_texts").select("reminder_key, status").eq("invoice_id", ids.bobInvoice);
    check((rt ?? []).length === 1 && rt![0].reminder_key === "step:1" && rt![0].status === "sent", `invoice_reminder_texts step:1 sent (${JSON.stringify(rt)})`);
    const { data: inv } = await db.from("invoices").select("last_reminder_at").eq("id", ids.bobInvoice).single();
    check(inv?.last_reminder_at, "invoices.last_reminder_at stamped (the email sweep skips today)");
    const { data: log } = await db.from("message_log").select("sent_by").eq("contact_id", ids.bob).eq("direction", "outbound");
    check((log ?? []).some((r: { sent_by: string }) => r.sent_by === "bookkeeper"), "message_log.sent_by = bookkeeper");
    const toPat = smsTo(got, PAT.phone);
    check(toPat.length === 1 && /\$400/.test(String(toPat[0].body)) && /\/i\//.test(String(toPat[0].body)), `Pat's plan confirmation went out at 9: "${toPat[0]?.body}"`);
    const { data: patSteps } = await db.from("invoice_reminder_texts").select("reminder_key").eq("invoice_id", ids.patInvoice).like("reminder_key", "step:%");
    check((patSteps ?? []).length === 0, "no overdue reminder for Pat's invoice while the plan holds");
    setMark();
    await tick();
    check(smsTo(sinceMark(), BOB.phone).length === 0, "a second pass sends Bob nothing (exactly once)");
    setMark();
  });

  await step("D3. the crew's job is done → no update text to the crew member", async () => {
    await clockTo(at(MONDAY, "09:45"));
    must(await db.from("bookings").update({ status: "completed", started_at: new Date(at(MONDAY, "08:05")).toISOString(), completed_at: new Date().toISOString() }).eq("id", ids.alJob).select("id"), "complete");
    await tick();
    check(smsTo(sinceMark(), MIKE.phone).length === 0, "no crew update text for a completed job");
    const { data: msgs } = await db.from("dispatch_messages").select("kind").eq("company_id", dana.companyId!).in("kind", ["crew_schedule", "crew_update"]);
    check((msgs ?? []).length === 1 && msgs![0].kind === "crew_schedule", `dispatch_messages: only the one crew_schedule (${JSON.stringify(msgs)})`);
    setMark();
  });

  await step("M1. Monday 10:00: monthly win-back draft → marketing_campaign approval (exact text, audience, window) → owner Y", async () => {
    await clockTo(at(MONDAY, "10:05"));
    await tick();
    const got = sinceMark();
    const { data: camps } = await db.from("marketing_campaigns").select("*").eq("company_id", dana.companyId!);
    check((camps ?? []).length === 1, `one campaign drafted (${(camps ?? []).length})`);
    const camp = camps?.[0];
    ids.campaign = camp?.id;
    check(camp?.status === "awaiting_owner" && camp?.kind === "win_back", `status ${camp?.status}, kind ${camp?.kind}`);
    check(camp?.audience_count === WINBACK_NUMBERS.length, `audience = ${camp?.audience_count} (one per number among 9–24-month past customers; expected ${WINBACK_NUMBERS.length})`);
    const { data: recips } = await db.from("marketing_campaign_recipients").select("contact_id, status, reason").eq("campaign_id", camp?.id);
    const queued = (recips ?? []).filter((r: { status: string }) => r.status === "queued").map((r: { contact_id: string }) => r.contact_id);
    check(!queued.includes(ids["past:Hal"]) && !queued.includes(ids["past:Ivy"]), "too recent (3 months) and too old (30 months) are not in the audience");
    check([ids["past:Gus"], ids["past:Gina"]].filter((id) => queued.includes(id)).length === 1, "the Hall number is in once (two contacts, one phone)");
    check(got.some((c) => c.kind === "anthropic" && c.purpose === "marketer_win_back"), "the message was drafted by the model (fake)");
    const msg = String(camp?.message ?? "");
    console.log(`   campaign text: ${msg}`);
    check(/Northshore Snow & Lawn/.test(msg) && /https:\/\/northshoresnow\.ca/.test(msg) && /Reply STOP to opt out/.test(msg), "names the business, contact info (website), STOP line");
    const appr = await latestApproval(dana.companyId!, "marketing_campaign");
    check(appr?.status === "pending" && camp?.approval_id === appr?.id, `marketing_campaign approval #${appr?.short_code} pending`);
    const ask = smsTo(got, dana.phone).find((m) => /Win-back/i.test(String(m.body)));
    check(ask && ask.from === PLATFORM && new RegExp(`${WINBACK_NUMBERS.length} past customers`).test(String(ask.body)) && /Mon-Sat/.test(String(ask.body)) && /Reply STOP/.test(String(ask.body)), `owner sees text + audience + window: "${String(ask?.body).slice(0, 360)}"`);
    check(WINBACK_NUMBERS.every((p) => smsTo(got, p).length === 0), "nothing sent before the owner's Y");
    setMark();
    // A past customer texts STOP before anything goes out (Gina's number = Gus's too).
    await text("+17055550317", dana.catcher!, "STOP");
    const { data: hall } = await db.from("contacts").select("first_name, sms_opt_out_at").eq("company_id", dana.companyId!).eq("phone_last10", "7055550317");
    check((hall ?? []).some((c: { sms_opt_out_at: string | null }) => c.sms_opt_out_at), `STOP opts the number out (${JSON.stringify(hall)})`);
    setMark();
    await text(dana.phone, PLATFORM, `Y ${appr?.short_code}`);
    const result = smsTo(sinceMark(), dana.phone);
    check(result.length === 1 && /Approved/i.test(String(result[0].body)), `owner result: "${result[0]?.body}"`);
    const { data: c2 } = await db.from("marketing_campaigns").select("status").eq("id", camp?.id).single();
    check(c2?.status === "sending", `campaign → sending (${c2?.status})`);
    setMark();
  });

  await step("M2. throttled sends: ≤5 per 5-minute slot, STOP footer + contact info, never to the opted-out number (either contact); a STOP after a text stops the rest", async () => {
    await clockTo(at(MONDAY, "10:10"));
    await tick();
    let got = sinceMark();
    const first = allSms(got).filter((m) => WINBACK_NUMBERS.includes(String(m.to)));
    const { data: slot1 } = await db.from("marketing_campaign_recipients").select("status, reason").eq("campaign_id", ids.campaign).neq("status", "queued");
    console.log(`   slot 1 recipients: ${JSON.stringify(slot1)}`);
    check((slot1 ?? []).length === 5 && first.length === (slot1 ?? []).filter((r: { status: string }) => r.status === "sent").length, `first slot: 5 recipients handled (⌈30/hour ÷ 6⌉), ${first.length} texted`);
    for (const m of first) {
      const body = String(m.body);
      check(m.from === dana.catcher && /^Hi [A-Z][a-z]+, it's Northshore Snow & Lawn/.test(body) && /Info: https:\/\/northshoresnow\.ca/.test(body) && (body.match(/Reply STOP/g) ?? []).length === 1, `to ${m.to}: "${body.slice(0, 90)}…" (one STOP line, contact info)`);
    }
    check(smsTo(got, "+17055550317").length === 0, "nothing to the opted-out Hall number");
    setMark();
    await tick();
    check(allSms(sinceMark()).filter((m) => WINBACK_NUMBERS.includes(String(m.to))).length === 0, "same 5-minute slot: no second batch");
    // One who got it replies STOP.
    const stopper = String(first.find((m) => m.to !== "+17055550312")?.to);
    setMark();
    await text(stopper, dana.catcher!, "STOP");
    check(smsTo(sinceMark(), stopper).length === 0, "no AI reply to STOP");
    setMark();
    await clockTo(at(MONDAY, "10:16"));
    await tick();
    got = sinceMark();
    const second = allSms(got).filter((m) => WINBACK_NUMBERS.includes(String(m.to)));
    check(first.length + second.length === WINBACK_NUMBERS.length - 1, `next slot: the rest (${second.length}; ${first.length + second.length} in all)`);
    check(smsTo(got, "+17055550317").length === 0 && smsTo(got, stopper).length === 0, "still nothing to opted-out numbers");
    const { data: recips } = await db.from("marketing_campaign_recipients").select("contact_id, status, reason, message_log_id").eq("campaign_id", ids.campaign);
    const sent = (recips ?? []).filter((r: { status: string }) => r.status === "sent");
    const hallRows = (recips ?? []).filter((r: { contact_id: string }) => [ids["past:Gus"], ids["past:Gina"]].includes(r.contact_id));
    console.log(`   recipients: ${JSON.stringify((recips ?? []).map((r: { status: string; reason: string | null }) => `${r.status}${r.reason ? `:${r.reason}` : ""}`))}`);
    check(sent.length === WINBACK_NUMBERS.length - 1 && sent.every((r: { message_log_id: string | null }) => r.message_log_id), `${sent.length} recipients sent, each with its message_log row`);
    check(hallRows.every((r: { status: string }) => r.status !== "sent"), `the Hall number's contacts were never sent (${JSON.stringify(hallRows.map((r: { status: string; reason: string | null }) => `${r.status}:${r.reason}`))})`);
    const { data: log } = await db.from("message_log").select("sent_by").eq("company_id", dana.companyId!).eq("sent_by", "marketer");
    check((log ?? []).length === WINBACK_NUMBERS.length - 1, `message_log sent_by marketer ×${(log ?? []).length}`);
    setMark();
    await clockTo(at(MONDAY, "10:30"));
    await tick();
    const { data: done } = await db.from("marketing_campaigns").select("status, sent_count").eq("id", ids.campaign).single();
    check(done?.status === "done" && done?.sent_count === WINBACK_NUMBERS.length - 1, `campaign done, sent_count ${done?.sent_count} (${done?.status})`);
    check(allSms(sinceMark()).filter((m) => WINBACK_NUMBERS.includes(String(m.to))).length === 0, "nothing more after the campaign is done");
    ids.stopper = stopper;
    // A recipient replies: it's an enquiry for the texting assistant (Ben's own implied consent had
    // lapsed 8 months ago; his text renews it, so the assistant can answer).
    setMark();
    await text("+17055550312", dana.catcher!, "Sounds good, book me in for next week");
    const reply = smsTo(sinceMark(), "+17055550312");
    check(reply.length === 1 && reply[0].from === dana.catcher, `the assistant answers the campaign reply: "${reply[0]?.body}"`);
    const { data: ben } = await db.from("contacts").select("sms_consent_at, consent_source").eq("id", ids["past:Ben"]).single();
    check(Date.now() - Date.parse(ben?.sms_consent_at) < 3_600_000 && ben?.consent_source === "implied_inquiry", `his text renewed implied consent (${ben?.sms_consent_at}, ${ben?.consent_source})`);
    setMark();
    await text(dana.phone, PLATFORM, "how did the campaign do?");
    const answer = smsTo(sinceMark(), dana.phone);
    console.log(`   owner: ${answer[0]?.body}`);
    const replies = Number(new RegExp(`${WINBACK_NUMBERS.length - 1} sent, (\\d+) replies`).exec(String(answer[0]?.body))?.[1] ?? 0);
    check(answer.length === 1 && replies >= 1 && /4\.8 stars \(37 reviews\)/.test(String(answer[0].body)), `marketing_results: ${WINBACK_NUMBERS.length - 1} sent, ${replies} repl(ies) counted, Google rating refreshed by the review sweep`);
    setMark();
  });

  await step("E3. quote follow-up: Tue (+2d) one follow-up text (the active quote-follow-up automation's — the Estimator leaves +2d to it); Fri (+5d) the Estimator's own nudge", async () => {
    const { data: wf } = await db.from("workflows").select("slug, status").eq("company_id", dana.companyId!).eq("slug", "quote-follow-up");
    const recipeActive = (wf ?? []).some((w: { status: string }) => w.status === "active");
    console.log(`   quote-follow-up automation active: ${recipeActive}`);
    await clockTo(Math.max(quoteSentAtMs + 2 * 86_400_000 + 30 * 60_000, at(TUESDAY, "09:30")));
    await tick();
    await sleep(500);
    await tick();
    let got = sinceMark();
    const tue = smsTo(got, RILEY.phone);
    console.log(`   +2d: ${tue.map((m) => m.body).join(" || ")}`);
    check(tue.length === 1 && tue[0].from === dana.catcher && /\/q\//.test(String(tue[0].body)), `exactly ONE follow-up text at +2d with the quote link (${tue.length})`);
    const { data: fu } = await db.from("quote_follow_ups").select("*").eq("quote_id", ids.rileyQuote).maybeSingle();
    console.log(`   quote_follow_ups: ${JSON.stringify(fu)}`);
    if (!recipeActive) check(fu?.nudges_sent === 1, "the Estimator sent nudge 1");
    setMark();
    await clockTo(at(FRIDAY, "09:30"));
    await tick();
    got = sinceMark();
    const fri = smsTo(got, RILEY.phone);
    console.log(`   +5d: ${fri.map((m) => m.body).join(" || ")}`);
    check(fri.length === 1 && fri[0].from === dana.catcher && /\/q\//.test(String(fri[0].body)) && /Northshore/.test(String(fri[0].body)), `one Estimator nudge at +5d: "${fri[0]?.body}"`);
    const { data: fu2 } = await db.from("quote_follow_ups").select("*").eq("quote_id", ids.rileyQuote).maybeSingle();
    check(fu2 && fu2.nudges_sent >= 1 && !fu2.stopped_at, `quote_follow_ups.nudges_sent = ${fu2?.nudges_sent}`);
    const { data: log } = await db.from("message_log").select("sent_by, body").eq("contact_id", ids.riley).eq("direction", "outbound").order("created_at", { ascending: false }).limit(1);
    check(log?.[0]?.sent_by === "sms_agent", `logged as the assistant (sent_by ${log?.[0]?.sent_by})`);
    setMark();
    await tick();
    check(smsTo(sinceMark(), RILEY.phone).length === 0, "a second pass the same day sends nothing");
    check(captured().filter((c) => c.kind === "sms" && c.to === ids.stopper && Date.parse(c.t) > at(MONDAY, "10:11")).length === 0, "nothing ever went to the number that texted STOP after its campaign text");
    setMark();
  });

  await step("H. house (non-CrankLeads) tenant: roles off — no reminders, no campaign, no crew text, nothing moved, no approvals; its SMS agent gets the Phase 1 tool list only", async () => {
    if (!houseIds) throw new Error("no house tenant");
    const h = houseIds;
    const roles = await activeRolesFor(admin, { organizationId: h.orgId, companyId: h.companyId });
    check(roles.length === 0, `activeRolesFor(house) = [${roles.map((r) => r.role).join(", ")}]`);
    const danaRoles = await activeRolesFor(admin, { organizationId: dana.orgId!, companyId: dana.companyId! });
    check(danaRoles.length === 4, `activeRolesFor(CrankLeads) = [${danaRoles.map((r) => r.role).join(", ")}]`);
    const houseNumbers = [HOUSE.owner, HOUSE.customer, HOUSE.debtor, HOUSE.past, HOUSE.crew, HOUSE.jobCustomer];
    const toHouse = captured().filter((c) => c.kind === "sms" && houseNumbers.includes(String(c.to)));
    check(toHouse.length === 0, `no text to any house number all week (${toHouse.length}: ${toHouse.map((c) => `${c.to}: ${String(c.body).slice(0, 60)}`).join(" | ")})`);
    for (const table of ["owner_approvals", "estimate_requests", "invoice_reminder_texts", "marketing_campaigns", "dispatch_messages", "dispatch_runs", "payment_plans", "google_post_drafts", "money_alerts"]) {
      const { data, error } = await db.from(table).select("id").eq("company_id", h.companyId);
      check(!error && (data ?? []).length === 0, `${table}: none for the house company${error ? ` (${error.message})` : ""}`);
    }
    const { data: job } = await db.from("bookings").select("scheduled_for").eq("id", ids.houseJob).single();
    check(Date.parse(job?.scheduled_for) === at(MONDAY, "10:00"), "house job not moved");
    // The house owner texts "who owes me": the owner agent (if it runs) is not offered any role tool.
    setMark();
    await text(HOUSE.owner, PLATFORM, "who owes me");
    let got = sinceMark();
    const roleOwner = new Set(roleOwnerTools().map((t) => t.tool.name));
    const ownerTurns = got.filter((c) => c.kind === "anthropic" && c.purpose === "owner_agent");
    check(ownerTurns.every((t) => !(t.tools as string[]).some((n) => roleOwner.has(n))), `house owner agent: no role tools (${ownerTurns.length} turn(s); tools ${JSON.stringify(ownerTurns[0]?.tools ?? [])})`);
    console.log(`   house owner got: ${smsTo(got, HOUSE.owner).map((m) => m.body).join(" | ")}`);
    // Default (front desk off for a house org): no AI reply at all.
    setMark();
    const mediaUrl = `https://api.twilio.com/2010-04-01/Accounts/${env("TWILIO_ACCOUNT_SID")}/Messages/MM${"e".repeat(32)}/Media/ME${"f".repeat(32)}`;
    await text(HOUSE.customer, HOUSE.catcher, "How much to fix my fascia?", [{ url: mediaUrl, type: "image/png" }]);
    got = sinceMark();
    check(smsTo(got, HOUSE.customer).length === 0 && got.filter((c) => c.kind === "anthropic").length === 0, "house default: no AI reply, no model call");
    // Switch the house's texting assistant on (roles stay off): the model gets exactly the Phase 1 tools.
    const { data: hc } = await db.from("companies").select("ai_settings").eq("id", h.companyId).single();
    await db.from("companies").update({ ai_settings: { ...((hc?.ai_settings as Record<string, unknown>) ?? {}), sms_agent: { enabled: true } } }).eq("id", h.companyId);
    setMark();
    await text(HOUSE.customer, HOUSE.catcher, "Hello? How much to fix my fascia?");
    got = sinceMark();
    const turns = got.filter((c) => c.kind === "anthropic" && c.purpose === "sms_agent");
    const phase1 = allAgentTools({ roleTools: [] }).map((t) => t.name).sort();
    const roleNames = new Set(roleAgentTools().map((t) => t.name));
    check(turns.length >= 1, `house SMS agent ran (${turns.length} model round(s))`);
    check(turns.every((t) => JSON.stringify([...(t.tools as string[])].sort()) === JSON.stringify(phase1)), `tool list = the Phase 1 list [${phase1.join(", ")}]`);
    check(turns.every((t) => !(t.tools as string[]).some((n) => roleNames.has(n))), "no request_estimate / my_invoices / promise_to_pay / request_payment_plan");
    const { data: est } = await db.from("estimate_requests").select("id").eq("company_id", h.companyId);
    check((est ?? []).length === 0 && got.filter((c) => c.kind === "anthropic" && c.purpose === "estimator_vision").length === 0, "no estimate, no vision call");
    await db.from("companies").update({ ai_settings: hc?.ai_settings ?? {} }).eq("id", h.companyId);
    setMark();
  });

  // ── timeline ───────────────────────────────────────────────────────────────
  const names = new Map<string, string>([
    [dana.phone, "owner"],
    [PLATFORM, "platform"],
    [dana.catcher ?? "", "company#"],
    [RILEY.phone, "Riley"],
    [BOB.phone, "Bob"],
    [PAT.phone, "Pat"],
    [SAM.phone, "Sam"],
    [JO.phone, "Jo"],
    [MIKE.phone, "Mike(crew)"],
    [HOUSE.catcher, "house#"],
    [HOUSE.owner, "house owner"],
    [HOUSE.customer, "house cust"],
    ...PAST.map((p) => [p.phone, `${p.first}`] as [string, string]),
  ]);
  const label = (v: unknown) => names.get(String(v)) ?? String(v);
  console.log("\n── Message timeline (Toronto time · from → to · first line)");
  const all = captured();
  const startIdx = all.findIndex((c) => c.kind === "sms" && c.to === RILEY.phone);
  for (const c of all.slice(Math.max(0, startIdx - 1))) {
    if (c.kind !== "sms") continue;
    console.log(`   ${torontoTime(Date.parse(c.t))}  ${label(c.from).padEnd(10)} → ${label(c.to).padEnd(11)}  ${String(c.body).split("\n")[0].slice(0, 130)}`);
  }
  const unhandled = all.filter((c) => c.kind === "unhandled");
  if (unhandled.length) console.log(`\n── Unhandled third-party calls: ${JSON.stringify(unhandled).slice(0, 1000)}`);
  console.log("\n── Summary");
  for (const r of results) console.log(`   ${r.ok ? "PASS" : "FAIL"}  ${r.step}`);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} steps passed, ${checks - failedChecks}/${checks} checks ok`);
  writeFileSync(join(OUT, "staff-results.json"), JSON.stringify({ results, checks, failedChecks }, null, 2));
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
