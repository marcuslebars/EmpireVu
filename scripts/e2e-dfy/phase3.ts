/**
 * Phase 3 — the Office manager, Customer import, Keep your number and Hiring & payroll
 * (docs/ai-staff.md), end to end on the done-for-you e2e stack (scripts/e2e-dfy/README.md →
 * "Phase 3"). Real local Postgres (every migration) + PostgREST + Next + the app's own worker code
 * (inbound queue drain, runScheduler → runStaffSweeps, the invoice-reminder cron) in this process;
 * Twilio / Anthropic / Resend / Places / weather are the fakes in fakes.mjs, storage is the
 * gateway's stub. Run with scripts/e2e-dfy/phase3.sh.
 *
 * The clock is moved to the next Saturday 13:05 Toronto, then forward:
 *   Sat 13:05  seed · import by link (CSV) → sweep → done text + chase question · holds vs the
 *              email reminder sweep (an A1 invoice still reminded)
 *   Sun 07:05  no briefing on a Sunday · 08:05 the 8am alert goes alone, without held balances
 *   Sun 10:00  keep your number: start, platform number refused, form (ciphertext only), operator
 *              reveal + mark submitted, number arrives → business_line + Done text, calls
 *   Sun 18:05  a crew clock left running (in the pay period)
 *   Mon 07:01  ONE briefing (jobs, overdue without held balances, the folded 30+ line) · 08:05 no
 *              standalone alert, A1's alert as before · payroll_period → Y (re-ask: open entry) →
 *              Y anyway → locked + CSV email · locked edit refused, clock-out allowed · "today"
 *   Mon 09:30  no Bookkeeper text on held balances · Y releases the hold · a second import undone
 *   Mon 10:00  hiring: job_post → Y → /s/<slug>/jobs → apply (confirmation at once) · a real lead
 *   Mon 21:30  late apply (confirmation waits) · Tue 07:01 briefing: 1 new lead, applicants not
 *              counted · 08:05 the late confirmation · 08:31 digest → interview_invite → Y
 *   then the house (A1-style) tenant: none of the four features touched it.
 */
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import Stripe from "stripe";

import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createCrankleadsCheckout } from "@/server/services/crankleads/checkout";
import { claimBillingEventJobs } from "@/server/services/billing/jobs";
import { processBillingEventJob } from "@/server/services/billing/events";
import { generateSite } from "@/server/services/dfy/site-generator";
import { switchOnEverything } from "@/server/services/dfy/switch-on";
import { processInboundWebhookJobs } from "@/server/services/inbound-webhook-jobs";
import { sweepInvoiceReminders } from "@/server/services/invoices/reminders";
import { resetRecruiterCompanyCache } from "@/server/services/staff/recruiter";
import { activeRolesFor, resetStaffSweepClock } from "@/server/services/staff/registry";
import { resumeDueWorkflowRuns, runScheduler } from "@/server/services/workflow-engine/scheduler";
import { claimWorkflowEventJobs, processWorkflowEventJob } from "@/server/services/workflow-event-jobs";

type Admin = ReturnType<typeof createSupabaseAdminClient>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any; // the Phase 3 tables aren't in database.types.ts yet

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
};
const HOUSE_APP = env("APP_BASE_URL");
const SUPABASE = env("NEXT_PUBLIC_SUPABASE_URL");
const CAPTURE = env("E2E_CAPTURE_LOG");
const OUT = env("E2E_PHASE3_OUT", join(env("E2E_ROOT"), "phase3-out"));
const CLOCK_FILE = env("E2E_CLOCK_FILE");
const PLATFORM = env("TWILIO_FROM_NUMBER");
const PASSWORD = "e2e-password-123";
const FAKES = `http://127.0.0.1:${env("E2E_FAKES_PORT")}`;
const OPERATOR = env("OPERATOR_EMAILS").split(",")[0].trim();
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
const short = (s: unknown, n = 300) => String(s ?? "").replace(/\n/g, " | ").slice(0, n);

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
const emails = (list: Captured[]) => list.filter((c) => c.kind === "email");

// ── the worker loop (inbound queue + workflow events) and the scheduler tick ──
async function drain(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const jobs = await claimWorkflowEventJobs(admin, { limit: 20, staleAfterSeconds: 900, workerId: "e2e-worker" });
    for (const job of jobs) await processWorkflowEventJob(admin, job).catch((e) => console.log("   workflow job error", e instanceof Error ? e.message : e));
    const inbound = await processInboundWebhookJobs(admin, { batch: 20, staleAfterSeconds: 900, workerId: "e2e-worker" });
    const resumed = await resumeDueWorkflowRuns(admin, { batch: 20, staleAfterSeconds: 900 });
    if (jobs.length === 0 && inbound === 0 && resumed === 0) break;
  }
}
/** One workflow-events worker tick: runScheduler (→ every staff sweep, throttles reset) + the queues. */
async function tick(): Promise<void> {
  resetStaffSweepClock();
  resetRecruiterCompanyCache();
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
async function postTwilio(urlOrPath: string, params: Record<string, string>): Promise<{ status: number; text: string }> {
  const url = urlOrPath.startsWith("http") ? urlOrPath : `${HOUSE_APP}${urlOrPath}`;
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(url, params) }, body: new URLSearchParams(params).toString() });
  return { status: res.status, text: await res.text() };
}
async function text(from: string, to: string, body: string): Promise<void> {
  const params: Record<string, string> = { AccountSid: env("TWILIO_ACCOUNT_SID"), MessageSid: newSid("SM"), From: from, To: to, Body: body, NumMedia: "0" };
  const res = await postTwilio("/api/twilio/sms/inbound", params);
  if (res.status !== 200) console.log(`   inbound SMS webhook → ${res.status} ${res.text}`);
  await drain();
}
function callParams(callSid: string, from: string, to: string): Record<string, string> {
  return { AccountSid: env("TWILIO_ACCOUNT_SID"), CallSid: callSid, From: from, To: to, Called: to, Caller: from, CallStatus: "ringing", Direction: "inbound" };
}
const unescapeXml = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const normalizeTwiml = (xml: string, callSid: string) => xml.split(callSid).join("<CallSid>");

// ── the app's API as a signed-in user (Bearer token from the auth stub) ──────
async function signInToken(email: string): Promise<string> {
  const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, { method: "POST", headers: { "content-type": "application/json", apikey: env("NEXT_PUBLIC_SUPABASE_ANON_KEY") }, body: JSON.stringify({ email, password: PASSWORD }) });
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error(`sign in ${email}: ${res.status} ${JSON.stringify(body)}`);
  return body.access_token;
}
type ApiResult = { status: number; json: Record<string, unknown> | null; text: string };
async function api(token: string | null, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<ApiResult> {
  const res = await fetch(path.startsWith("http") ? path : `${HOUSE_APP}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extraHeaders },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(t) as Record<string, unknown>;
  } catch {
    /* not json */
  }
  return { status: res.status, json, text: t };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dataOf = (r: ApiResult): any => (r.json as { data?: unknown } | null)?.data ?? null;

/** PUT a file to a one-time signed upload URL (the browser's step, through the gateway's storage stub). */
async function uploadSigned(bucket: string, path: string, token: string, bytes: Buffer, contentType: string): Promise<number> {
  const res = await fetch(`${SUPABASE}/storage/v1/object/upload/sign/${bucket}/${path}?token=${token}`, { method: "PUT", headers: { "content-type": contentType, "x-upsert": "true" }, body: bytes });
  return res.status;
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
    checkout: { sessions: { create: async () => ({ id: `cs_test_p3_${Date.now().toString(36)}${++n}`, url: "https://checkout.stripe.test/c/pay/x" }) } },
    coupons: { retrieve: async () => ({ valid: false }) },
  } as unknown as Stripe;
}
async function buy(buyer: Buyer): Promise<void> {
  const checkout = await createCrankleadsCheckout(admin, { tier: buyer.tier, name: buyer.name, email: buyer.email, phone: buyer.phone, businessName: buyer.businessName, businessType: buyer.businessType }, fakeStripe());
  buyer.purchaseId = checkout.purchaseId;
  const suffix = checkout.purchaseId.slice(0, 8);
  const event = {
    id: `evt_p3_${suffix}`,
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
        customer: `cus_p3_${suffix}`,
        subscription: `sub_p3_${suffix}`,
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
const dana: Buyer = { name: "Dana Whitfield", email: "dana@northshoresnow.ca", phone: "+17055550143", businessName: "Northshore Snow & Lawn", businessType: "Property maintenance & snow", tier: "close" };
const BUSINESS_LINE = "+17055550142"; // the number on the Google listing, ported in step P
const BOB = { first: "Bob", last: "Jones", phone: "+17055550202" }; // 35 days late Sunday → the Sunday alert
const CARA = { first: "Cara", last: "Diaz", phone: "+17055550207" }; // crosses 30 days Monday → folded into the briefing
const RITA = { first: "Rita", last: "Moss", phone: "+17055550204" }; // Monday job (Mike)
const OMAR = { first: "Omar", last: "Haddad", phone: "+17055550205" }; // Monday job (unassigned)
const KIM = { phone: "+17055550250" }; // a real lead on Monday
const CALLER = "+17055550260"; // calls the ported line
const MIKE = { name: "Mike Tran", email: "mike@northshoresnow.ca", phone: "+17055550290" };
const ANA = { name: "Ana Silva", email: "ana@northshoresnow.ca", phone: "+17055550291" };
const BOOKS = "books@northshoresnow.test";
const JORDAN = { name: "Jordan Pike", phone: "+17055550401" };
const SASHA = { name: "Sasha Lund", phone: "+17055550402" };
const HOUSE = { owner: "+17055550111", catcher: "+17055550161", debtor: "+17055550191", customer: "+17055550190", caller: "+17055550199" };

const ids: Record<string, string> = {};
let houseIds: { orgId: string; companyId: string } | null = null;
let danaToken = "";
let SAT = "";
let SUN = "";
let MON = "";
let TUE = "";
let MON0 = "";
const baseline: { houseVoice?: string; houseVoiceSid?: string } = {};
const importedHeld: string[] = [];
let slug = "";

async function contact(scope: { orgId: string; companyId: string }, p: { first: string; last: string; phone: string }, extra: Record<string, unknown> = {}): Promise<string> {
  // Seeded customers are a month old: the briefing's "new leads" then counts only real new ones.
  const createdAt = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const row = must(await db.from("contacts").insert({ organization_id: scope.orgId, company_id: scope.companyId, first_name: p.first, last_name: p.last, phone: p.phone, created_at: createdAt, updated_at: createdAt, ...extra }).select("id").single(), `contact ${p.first}`) as { id: string };
  return row.id;
}
async function invoice(scope: { orgId: string; companyId: string }, contactId: string, input: { number: string; cents: number; dueDate: string; title: string; billName?: string; billEmail?: string | null }): Promise<string> {
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
        issue_date: addDays(input.dueDate, -14),
        due_date: input.dueDate,
        sent_at: new Date(at(addDays(input.dueDate, -14), "10:00")).toISOString(),
        bill_to: { name: input.billName ?? "Customer", email: input.billEmail ?? null },
      })
      .select("id")
      .single(),
    `invoice ${input.number}`,
  ) as { id: string };
  return row.id;
}
async function booking(scope: { orgId: string; companyId: string }, input: { contactId: string | null; title: string; at: number; minutes: number; location?: string }): Promise<string> {
  const row = must(
    await db
      .from("bookings")
      .insert({ organization_id: scope.orgId, company_id: scope.companyId, contact_id: input.contactId, title: input.title, scheduled_for: new Date(input.at).toISOString(), duration_minutes: input.minutes, status: "confirmed", location: input.location ?? null })
      .select("id")
      .single(),
    `booking ${input.title}`,
  ) as { id: string };
  return row.id;
}
async function member(orgId: string, person: { name: string; email: string; phone?: string }): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email: person.email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: person.name } });
  if (error || !data.user) throw new Error(`user ${person.email}: ${error?.message}`);
  const profileId = data.user.id;
  const { data: prof } = await db.from("profiles").select("id").eq("id", profileId).maybeSingle();
  if (!prof) must(await db.from("profiles").insert({ id: profileId, email: person.email, full_name: person.name }).select("id").single(), "profile");
  else await db.from("profiles").update({ full_name: person.name }).eq("id", profileId);
  must(await db.from("organization_memberships").insert({ organization_id: orgId, profile_id: profileId, role: "member", ...(person.phone ? { phone_e164: person.phone } : {}) }).select("id").single(), "membership");
  return profileId;
}
async function latestApproval(companyId: string, kind: string): Promise<{ id: string; short_code: number; status: string; summary: string; payload: Record<string, unknown>; result: Record<string, unknown> | null } | null> {
  const { data } = await db.from("owner_approvals").select("*").eq("company_id", companyId).eq("kind", kind).order("created_at", { ascending: false }).limit(1);
  return (data ?? [])[0] ?? null;
}
const scope = () => ({ orgId: dana.orgId!, companyId: dana.companyId! });
const coBase = () => `/api/organizations/${dana.orgId}/companies/${dana.companyId}`;
const briefingsTo = (list: Captured[], phone: string) => smsTo(list, phone).filter((m) => /Morning /.test(String(m.body)) && /Reply "today" for details|all quiet/.test(String(m.body)));
const standaloneAlerts = (list: Captured[], phone: string) => smsTo(list, phone).filter((m) => /Money check for /.test(String(m.body)));

async function seedHouse(): Promise<void> {
  const org = must(await db.from("organizations").insert({ name: "A1 Group (house)", slug: "a1-group-house-p3", subscription_status: "active" }).select("id").single(), "house org") as { id: string };
  const company = must(
    await db
      .from("companies")
      .insert({
        organization_id: org.id,
        name: "A1 Marine Care",
        slug: "a1-marine-care-p3",
        timezone: TZ,
        owner_phone_e164: HOUSE.owner,
        owner_phone_verified_at: new Date().toISOString(),
        owner_email: "owner@a1.test",
        // A1 opted into the Bookkeeper (its 8am money alert) — texts off. Everything Phase 3 stays at its default (off).
        ai_settings: { collections: { enabled: true, textReminders: false } },
      })
      .select("id")
      .single(),
    "house company",
  ) as { id: string };
  must(await db.from("voice_numbers").insert({ organization_id: org.id, company_id: company.id, provider: "twilio", mode: "missed_call_catcher", phone_e164: HOUSE.catcher, active: true }).select("id").single(), "house number");
  houseIds = { orgId: org.id, companyId: company.id };
  // Hank's invoice crosses 30 days late on Monday (→ A1's own 8am alert), and is due an email reminder now.
  const hank = await contact(houseIds, { first: "Hank", last: "Owes", phone: HOUSE.debtor }, { email: "hank@a1.test" });
  ids.hankInvoice = await invoice(houseIds, hank, { number: "A1-0001", cents: 80000, dueDate: addDays(MON, -30), title: "Winterize boat", billName: "Hank Owes", billEmail: "hank@a1.test" });
  const jill = await contact(houseIds, { first: "Jill", last: "Dock", phone: HOUSE.customer });
  await booking(houseIds, { contactId: jill, title: "Dock repair", at: at(MON, "10:00"), minutes: 120, location: "1 Harbour Rd, Midland" });
}

async function main(): Promise<void> {
  // ── the next Saturday 13:05 ──
  {
    const p = localParts(Date.now());
    const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
    SAT = addDays(localDate(Date.now()), (6 - wd + 7) % 7);
    SUN = addDays(SAT, 1);
    MON = addDays(SAT, 2);
    TUE = addDays(SAT, 3);
    MON0 = addDays(SAT, -5); // the pay period: MON0 … SUN (weekly)
    await clockTo(at(SAT, "13:05"));
    console.log(`clock now ${new Date().toISOString()} (${torontoTime(Date.now())} Toronto); Saturday = ${SAT}`);
  }

  await step("0. seed: a live CrankLeads Close company (purchase → switch-on → live, site published) with customers, overdue invoices, jobs, crew + clocked hours; a house tenant (A1) with the Bookkeeper's alert on", async () => {
    await seedHouse();
    await buy(dana);
    const { data: numbers } = await admin.from("voice_numbers").select("phone_e164, mode").eq("company_id", dana.companyId!);
    dana.catcher = (numbers ?? []).find((n) => n.mode === "missed_call_catcher")?.phone_e164;
    check(dana.catcher?.startsWith("+1705"), `company catcher number ${dana.catcher}`);
    must(
      await db
        .from("companies")
        .update({
          hours: { summary: "Monday: 7:00 AM – 6:00 PM; Tuesday: 7:00 AM – 6:00 PM; Wednesday: 7:00 AM – 6:00 PM; Thursday: 7:00 AM – 6:00 PM; Friday: 7:00 AM – 6:00 PM; Saturday: 8:00 AM – 12:00 PM; Sunday: Closed" },
          service_area: "Midland and surrounding area",
          timezone: TZ,
          owner_email: dana.email,
          owner_phone_e164: dana.phone,
          owner_phone_verified_at: new Date().toISOString(),
          website: "https://northshoresnow.ca",
          google_place_id: "ChIJn0rthSh0reSn0wMidland01",
          brand_reply_phone: BUSINESS_LINE,
          business_phone_carrier: "Bell",
        })
        .eq("id", dana.companyId!)
        .select("id"),
      "company facts",
    );
    must(
      await db
        .from("service_catalog_items")
        .upsert([{ organization_id: dana.orgId!, company_id: dana.companyId!, service_key: "seasonal_double_driveway", label: "Seasonal snow contract — double driveway", pricing_type: "flat", rate_cents: 65000, minimum_cents: 0, active: true, sort_order: 1 }], { onConflict: "company_id,service_key" })
        .select("id"),
      "catalog",
    );
    const switched = await switchOnEverything({ organizationId: dana.orgId!, actorProfileId: null, supabase: admin as never }, dana.companyId!, "close");
    console.log(`   switch-on: ${JSON.stringify(switched).slice(0, 160)}`);
    const now = new Date().toISOString();
    must(await db.from("crankleads_purchases").update({ live_at: now, setup_followups_exempt_at: now }).eq("id", dana.purchaseId!).select("id"), "live");
    const site = await generateSite(admin, dana.companyId!, { publish: true });
    slug = site.site.slug;
    check(site.site.status === "published", `site published at /s/${slug}`);

    ids.bob = await contact(scope(), BOB, { email: null });
    ids.bobInvoice = await invoice(scope(), ids.bob, { number: "INV-2026-0012", cents: 124000, dueDate: addDays(SUN, -35), title: "Fall cleanup" });
    ids.cara = await contact(scope(), CARA);
    ids.caraInvoice = await invoice(scope(), ids.cara, { number: "INV-2026-0014", cents: 52000, dueDate: addDays(MON, -30), title: "Interlock repair" });
    ids.rita = await contact(scope(), RITA);
    ids.omar = await contact(scope(), OMAR);
    const mikeId = await member(dana.orgId!, MIKE);
    const anaId = await member(dana.orgId!, ANA);
    ids.mike = mikeId;
    ids.ana = anaId;
    ids.ritaJob = await booking(scope(), { contactId: ids.rita, title: "Salt driveway and walkway", at: at(MON, "09:00"), minutes: 60, location: "12 Bay St, Midland" });
    ids.omarJob = await booking(scope(), { contactId: ids.omar, title: "Snow removal", at: at(MON, "13:00"), minutes: 90, location: "40 Elm St, Midland" });
    ids.tueJob = await booking(scope(), { contactId: ids.omar, title: "Snow removal follow-up", at: at(TUE, "10:00"), minutes: 60, location: "40 Elm St, Midland" });
    must(await db.from("booking_assignments").insert({ organization_id: dana.orgId!, booking_id: ids.ritaJob, profile_id: mikeId }).select("id").single(), "assignment");

    // Payroll: weekly periods starting MON0 (so MON0 … SUN ends Sunday, asked Monday 08:00) — through the real settings route.
    danaToken = await signInToken(dana.email);
    const patch = await api(danaToken, "PATCH", `${coBase()}/ai-settings/recruiter`, { payroll: { enabled: true, frequency: "weekly", anchorDate: MON0, csvEmail: BOOKS } });
    check(patch.status === 200, `PATCH ai-settings/recruiter weekly from ${MON0}, CSV to ${BOOKS} → ${patch.status} ${patch.status !== 200 ? patch.text.slice(0, 200) : ""}`);
    // Mike: 5 × 9.5 h (Mon–Fri) = 47.5 h → 3.5 h OT flagged. Ana: 6 h Tuesday (+ a clock left running Sunday, below).
    const entries: Array<Record<string, unknown>> = [];
    for (let d = 0; d < 5; d++) {
      const day = addDays(MON0, d);
      entries.push({ organization_id: dana.orgId!, company_id: dana.companyId!, profile_id: mikeId, started_at: new Date(at(day, "07:00")).toISOString(), ended_at: new Date(at(day, "17:00")).toISOString(), break_minutes: 30, source: "clock" });
    }
    entries.push({ organization_id: dana.orgId!, company_id: dana.companyId!, profile_id: anaId, started_at: new Date(at(addDays(MON0, 1), "08:00")).toISOString(), ended_at: new Date(at(addDays(MON0, 1), "14:00")).toISOString(), break_minutes: 0, source: "clock" });
    const rows = must(await db.from("time_entries").insert(entries).select("id, profile_id, started_at"), "time entries") as Array<{ id: string; profile_id: string }>;
    ids.mikeEntry = rows.find((r) => r.profile_id === mikeId)!.id;
    must(await db.from("member_pay_rates").insert([{ organization_id: dana.orgId!, profile_id: mikeId, hourly_cost_cents: 2500 }, { organization_id: dana.orgId!, profile_id: anaId, hourly_cost_cents: 2200 }]).select("profile_id"), "pay rates");

    // A1 baseline: its inbound voice TwiML before anything Phase 3 happens.
    const sid = newSid("CA");
    const v = await postTwilio("/api/twilio/voice/inbound", callParams(sid, HOUSE.caller, HOUSE.catcher));
    baseline.houseVoice = normalizeTwiml(v.text, sid);
    check(v.status === 200 && /<Response>/.test(v.text), `A1 baseline voice TwiML (${v.status}): ${short(v.text, 160)}`);
    await drain();
    // One worker tick on Saturday afternoon (the Bookkeeper's own Saturday texts go now, before the import).
    await tick();
    console.log(`   Saturday tick texts: ${allSms(captured()).map((m) => `${m.to}: ${short(m.body, 50)}`).join(" | ")}`);
    setMark();
  });

  await step("I1. customer import by link: send-link → /api/public/import/<token> (CSV, signed upload) → preview → import → sweep → counts; nobody texted or emailed; the owner gets the done text + chase_imported_balances", async () => {
    const send = await api(danaToken, "POST", `${coBase()}/imports/send-link`, {});
    check(send.status === 200, `POST imports/send-link → ${send.status} ${send.status !== 200 ? send.text.slice(0, 200) : ""}`);
    let got = sinceMark();
    const linkText = smsTo(got, dana.phone).find((m) => /\/import\//.test(String(m.body)));
    check(linkText && linkText.from === PLATFORM && /Bring your customer list over/.test(String(linkText.body)) && /app\.crankleads\.localhost/.test(String(linkText.body)), `owner texted the link from the platform number: "${short(linkText?.body, 260)}"`);
    const token = String(linkText?.body ?? "").match(/\/import\/([A-Za-z0-9_-]{32,64})/)?.[1] ?? "";
    ids.importToken = token;
    const view = await api(null, "GET", `/api/public/import/${token}`);
    check(view.status === 200 && dataOf(view)?.businessName === dana.businessName, `GET /api/public/import/<token> → ${view.status} (${dataOf(view)?.businessName})`);
    const bad = await api(null, "GET", `/api/public/import/${"x".repeat(32)}`);
    check(bad.status === 404, `an unknown token → 404 (${bad.status})`);

    const csv = [
      "Client ID,First Name,Last Name,Mobile Phone,Email,Service Street,Service City,Last Visit Date,Service Type,Job Total,Balance Owing,Invoice Number,Invoice Date,Due Date",
      // Lena: an 11-month-old balance (it would be a 60+ day alert line if it weren't held).
      "C-1001,Lena,Ortiz,(705) 555-0301,lena@example.test,14 Pine St,Midland,2025-11-02,Fall cleanup,$250.00,$450.00,J-88,2025-11-02,2025-11-16",
      "C-1002,Marco,Diaz,705-555-0302,,22 Elm St,Midland,2025-06-14,Lawn cutting,120,,,,",
      "C-1003,Bob,Jones,7055550202,bob@example.test,,,2025-10-01,Snow contract,650,,,,",
      // Nia: a due date but no invoice date (docs: "due date from the file").
      'C-1004,Nia,Brooks,+1 705 555 0304,,9 Bay St,Penetanguishene,,,,"$1,240.50",J-91,,2026-08-01',
      "C-1005,,,,,77 Oak St,Midland,2025-09-09,Gutter clean,90,,,,",
    ].join("\r\n");
    const bytes = Buffer.from(csv, "utf8");
    const created = await api(null, "POST", `/api/public/import/${token}`, { fileName: "clients.csv", fileSize: bytes.length, contentType: "text/csv" });
    const batch = dataOf(created)?.batch;
    const upload = dataOf(created)?.upload;
    check(created.status === 201 && batch?.status === "uploading" && upload?.bucket === "customer-imports", `POST /api/public/import/<token> → ${created.status}, batch ${batch?.id} (${batch?.status}), upload to ${upload?.bucket}`);
    ids.batch1 = batch?.id;
    const put = await uploadSigned(upload.bucket, upload.path, upload.token, bytes, "text/csv");
    check(put === 200 && existsSync(join(env("E2E_ROOT"), "storage", "customer-imports", upload.path)), `file uploaded straight to the private bucket (${put})`);
    const up = await api(null, "POST", `/api/public/import/${token}/${batch.id}`, { action: "uploaded" });
    const v = dataOf(up);
    console.log(`   mapping: ${JSON.stringify(v?.mapping)} (${v?.mappingSource}); preview: ${JSON.stringify(v?.preview)?.slice(0, 600)}`);
    check(up.status === 200 && v?.status === "previewed", `uploaded → read + previewed in the request (${up.status} ${v?.status} ${v?.error ?? ""})`);
    check(JSON.stringify(v?.mapping) === JSON.stringify(["ignore", "first_name", "last_name", "phone", "email", "address", "address", "last_service_date", "job_description", "job_amount", "balance", "invoice_ref", "balance_date", "balance_due_date"]), "columns guessed from the Jobber-style headers");
    setMark();
    const imp = await api(null, "POST", `/api/public/import/${token}/${batch.id}`, { action: "import" });
    check(imp.status === 200 && dataOf(imp)?.status === "importing", `Import → ${dataOf(imp)?.status}`);
    for (let i = 0; i < 4; i++) {
      await tick();
      const { data: b } = await db.from("import_batches").select("status, owner_notified_at").eq("id", batch.id).single();
      if (b?.status === "done" && b.owner_notified_at) break;
    }
    const { data: b1 } = await db.from("import_batches").select("*").eq("id", batch.id).single();
    const c = b1?.counts ?? {};
    console.log(`   counts: ${JSON.stringify(c)}`);
    check(b1?.status === "done", `batch done (${b1?.status} ${b1?.error ?? ""})`);
    check(c.contactsCreated === 3 && c.contactsMatched === 1 && c.jobsCreated === 3 && c.balancesCreated === 2 && c.balanceCents === 169050 && c.invalidRows === 1, "3 new + 1 matched customers, 3 past jobs, 2 balances ($1,690.50), 1 row skipped");
    const { data: imported } = await db.from("contacts").select("id, first_name, consent_source, sms_consent_at, stage").eq("company_id", dana.companyId!).eq("consent_source", "import");
    check((imported ?? []).length === 3 && imported!.every((r: { sms_consent_at: string | null; stage: string }) => !r.sms_consent_at && r.stage === "closed"), `imported contacts: consent_source import, no sms_consent_at, stage closed (${JSON.stringify((imported ?? []).map((r: { first_name: string }) => r.first_name))})`);
    const { data: bob } = await db.from("contacts").select("email, consent_source").eq("id", ids.bob).single();
    check(bob?.email === "bob@example.test" && bob?.consent_source !== "import", `Bob matched: blank email filled (${bob?.email}), consent untouched (${bob?.consent_source})`);
    const { data: jobs } = await db.from("bookings").select("status, source_call_id").eq("company_id", dana.companyId!).like("source_call_id", "import:%");
    check((jobs ?? []).length === 3 && jobs!.every((j: { status: string }) => j.status === "completed"), `3 past jobs, completed (${(jobs ?? []).length})`);
    const { data: held } = await db.from("invoices").select("id, import_hold, reminders_paused, balance_due_cents, issue_date, due_date, status, bill_to").eq("company_id", dana.companyId!).eq("import_batch_id", batch.id);
    const lena = (held ?? []).find((h: { balance_due_cents: number }) => h.balance_due_cents === 45000);
    const nia = (held ?? []).find((h: { balance_due_cents: number }) => h.balance_due_cents === 124050);
    check(lena?.issue_date === "2025-11-02" && lena?.due_date === "2025-11-16", `Lena's balance keeps the file's dates (issue ${lena?.issue_date}, due ${lena?.due_date})`);
    check(nia?.due_date === "2026-08-01", `Nia's balance keeps the file's due date 2026-08-01 when the file has no invoice date (got issue ${nia?.issue_date}, due ${nia?.due_date})`);
    for (const h of held ?? []) importedHeld.push(h.id);
    check((held ?? []).length === 2 && held!.every((h: { import_hold: boolean; reminders_paused: boolean }) => h.import_hold && h.reminders_paused), `2 imported balances on hold (import_hold + reminders_paused): ${JSON.stringify((held ?? []).map((h: { balance_due_cents: number; due_date: string }) => `${h.balance_due_cents}@${h.due_date}`))}`);

    got = sinceMark();
    const toCustomers = allSms(got).filter((m) => m.to !== dana.phone);
    check(toCustomers.length === 0, `no customer SMS (${toCustomers.map((m) => `${m.to}: ${short(m.body, 60)}`).join(" | ")})`);
    check(emails(got).length === 0, `no email at all (${emails(got).map((e) => e.to).join(", ")})`);
    const { data: logs } = await db.from("message_log").select("id").eq("company_id", dana.companyId!).in("contact_id", (imported ?? []).map((r: { id: string }) => r.id));
    check((logs ?? []).length === 0, "no message_log row for any imported customer");
    const done = smsTo(got, dana.phone);
    const chase = await latestApproval(dana.companyId!, "chase_imported_balances");
    ids.chaseCode = String(chase?.short_code ?? "");
    console.log(`   done text: ${short(done[0]?.body, 700)}`);
    check(done.length === 1 && done[0].from === PLATFORM, `ONE owner text from the platform number (${done.length})`);
    const body = String(done[0]?.body ?? "");
    check(/Imported 4 customers \(3 new, 1 you already had - blanks filled, nothing overwritten\), 3 past jobs, 2 open balances \(\$1,690(\.50)?\) from clients\.csv\. 1 row skipped - see the import page\./.test(body) && /Nobody was texted or emailed\./.test(body), "done text: counts, file name, skipped row, nobody texted");
    check(chase?.status === "pending" && new RegExp(`#${chase?.short_code} 2 imported balances, \\$1,690(\\.50)? owing`).test(body) && /\(oldest from Nov 2, 2025\)/.test(body) && /Nobody has been reminded yet/.test(body) && new RegExp(`Reply Y ${chase?.short_code} to approve, N ${chase?.short_code} to skip`).test(body), `chase_imported_balances #${chase?.short_code} asked in the same text`);
    setMark();
  });

  await step("I2. during the hold: the invoice email-reminder sweep leaves the held balances out (no overdue event, no email) while an A1 invoice still gets its reminder", async () => {
    const r = await sweepInvoiceReminders(new Date());
    console.log(`   sweep: scanned ${r.scanned}, overdue ${r.flaggedOverdue.length}, reminded ${r.reminded.length}, failed ${r.failed.length}`);
    check(importedHeld.every((id) => !r.flaggedOverdue.includes(id) && !r.reminded.includes(id) && !r.failed.includes(id)), "held balances: not flagged overdue, not reminded");
    const { data: ev } = await db.from("invoice_events").select("id").in("invoice_id", importedHeld);
    check((ev ?? []).length === 0, `no invoice_events for the held balances (${(ev ?? []).length})`);
    check(r.reminded.includes(ids.hankInvoice), "the A1 invoice (28 days late) got its reminder email");
    const got = sinceMark();
    const hank = emails(got).filter((e) => e.to === "hank@a1.test");
    check(hank.length === 1, `reminder email to the A1 customer (${hank.length}: ${short(hank[0]?.subject, 100)})`);
    check(emails(got).every((e) => !/lena@example\.test/.test(String(e.to))), "nothing to the imported customer Lena");
    setMark();
  });

  await step("B0. Sunday: no briefing (not a briefing day) at 07:00; at 08:00 the Bookkeeper's alert goes alone — Bob's 30+ line, never the held imported balances", async () => {
    await clockTo(at(SUN, "07:05"));
    await tick();
    let got = sinceMark();
    check(briefingsTo(got, dana.phone).length === 0, "no briefing on Sunday");
    const { data: rows } = await db.from("owner_briefings").select("id").eq("company_id", dana.companyId!);
    check((rows ?? []).length === 0, "no owner_briefings row Sunday");
    setMark();
    await clockTo(at(SUN, "08:05"));
    await tick();
    got = sinceMark();
    const alert = standaloneAlerts(got, dana.phone);
    console.log(`   alert: ${short(alert[0]?.body)}`);
    check(alert.length === 1 && alert[0].from === PLATFORM && /Bob Jones/.test(String(alert[0].body)), "one standalone 8am alert on Sunday, with Bob's overdue invoice");
    check(!/Lena|Nia|Ortiz|Brooks|J-88|J-91/.test(String(alert[0]?.body)), "held imported balances are not in it");
    const { data: items } = await db.from("money_alert_items").select("item_key").eq("company_id", dana.companyId!);
    check((items ?? []).every((i: { item_key: string }) => importedHeld.every((id) => !i.item_key.includes(id))), `money_alert_items never name a held balance (${JSON.stringify((items ?? []).map((i: { item_key: string }) => i.item_key.split(":")[0]))})`);
    check(standaloneAlerts(got, HOUSE.owner).length === 0, "A1: nothing notable on Sunday → no alert");
    setMark();
  });

  await step("P1. keep your number: platform number refused; start from Settings → owner text with the form link; the public form with account number + PIN → DB holds ciphertext only; LOA without the secrets", async () => {
    await clockTo(at(SUN, "10:00"));
    const refuse = await api(danaToken, "POST", `${coBase()}/ai-settings/porting`, { action: "start", number: PLATFORM });
    check(refuse.status >= 400 && refuse.status < 500 && /can't be moved/i.test(refuse.text), `a port for TWILIO_FROM_NUMBER is refused (${refuse.status} ${refuse.text.slice(0, 160)})`);
    const refuseCatcher = await api(danaToken, "POST", `${coBase()}/ai-settings/porting`, { action: "start", number: dana.catcher });
    check(refuseCatcher.status >= 400 && refuseCatcher.status < 500 && /already connected/i.test(refuseCatcher.text), `…and so is the company's own catcher number (${refuseCatcher.status})`);
    const { data: none } = await db.from("number_port_requests").select("id").eq("company_id", dana.companyId!);
    check((none ?? []).length === 0, "no port row from the refusals");
    setMark();
    const start = await api(danaToken, "POST", `${coBase()}/ai-settings/porting`, { action: "start" });
    check(start.status === 200 && dataOf(start)?.started?.texted === true, `POST ai-settings/porting {start} → ${start.status} texted=${dataOf(start)?.started?.texted}`);
    let got = sinceMark();
    const startText = smsTo(got, dana.phone)[0];
    console.log(`   owner: ${short(startText?.body)}`);
    check(startText?.from === PLATFORM && /^(CrankLeads: )?Keep your number: to move \(705\) 555-0142 over we need a few details \(about 5 minutes - have a recent phone bill handy\): http:\/\/app\.crankleads\.localhost:\d+\/port\/\S+ Your calls keep working the whole time\.$/.test(String(startText?.body)), "exact start text with the /port/ link");
    const token = String(startText?.body ?? "").match(/\/port\/([A-Za-z0-9_-]+)/)?.[1] ?? "";
    setMark();
    // By text too: one open request per company → the same link.
    await text(dana.phone, PLATFORM, "can I keep my number?");
    got = sinceMark();
    const reply = smsTo(got, dana.phone);
    check(reply.length === 1 && String(reply[0].body).includes(`/port/${token}`), `owner texts "can I keep my number?" → the same link (${short(reply[0]?.body, 200)})`);
    const { data: ports } = await db.from("number_port_requests").select("*").eq("company_id", dana.companyId!);
    check((ports ?? []).length === 1, `one port request (${(ports ?? []).length})`);
    ids.port = ports?.[0]?.id;

    const view = await api(null, "GET", `/api/public/port/${token}`);
    check(view.status === 200, `GET /api/public/port/<token> → ${view.status}: ${view.text.slice(0, 240)}`);
    const form = {
      numbers: ["(705) 555-0142"],
      carrier: "Bell",
      businessName: "Northshore Snow & Lawn",
      authorizedName: "Dana Whitfield",
      serviceAddress: { line1: "412 King St", city: "Midland", province: "ON", postalCode: "L4R 3M9", country: "CA" },
      accountNumber: "5551234569012",
      pin: "4321",
      billIsRecent: true,
      signature: { typedName: "Dana Whitfield", agree: true },
    };
    const platformForm = await api(null, "POST", `/api/public/port/${token}`, { ...form, numbers: ["705-555-0100"] });
    check(platformForm.status >= 400 && platformForm.status < 500 && /can't be moved/i.test(platformForm.text), `the form refuses the platform number (${platformForm.status})`);
    const up = await api(null, "POST", `/api/public/port/${token}/upload`, { contentType: "application/pdf" });
    const u = dataOf(up);
    check(up.status === 200 && u?.bucket === "porting-docs", `bill upload URL (${up.status})`);
    const bill = Buffer.from("%PDF-1.4\n% Bell bill, account 5551234569012\n%%EOF\n");
    check((await uploadSigned("porting-docs", u.path, u.token, bill, "application/pdf")) === 200, "bill uploaded to the private bucket");
    setMark();
    const sub = await api(null, "POST", `/api/public/port/${token}`, { ...form, billPath: u.path, billContentType: "application/pdf" }, { "user-agent": "e2e-phase3" });
    check(sub.status === 200, `form submitted → ${sub.status} ${sub.status !== 200 ? sub.text.slice(0, 200) : ""}`);
    check(!sub.text.includes("5551234569012") && !/"4321"/.test(sub.text), "the response never echoes the account number or PIN");
    const { data: port } = await db.from("number_port_requests").select("*").eq("id", ids.port).single();
    const raw = JSON.stringify(port);
    console.log(`   port: status ${port?.status}, pin_status ${port?.pin_status}, last4 ${port?.account_number_last4}, acct ${String(port?.account_number_enc).slice(0, 24)}…`);
    check(port?.status === "ready" && JSON.stringify(port?.numbers) === JSON.stringify([BUSINESS_LINE]), `status ready, numbers ${JSON.stringify(port?.numbers)}`);
    check(/^v1\./.test(String(port?.account_number_enc)) && /^v1\./.test(String(port?.pin_enc)) && port?.pin_status === "stored" && port?.account_number_last4 === "9012", "account number + PIN stored as v1.<iv>.<tag>.<data>, last 4 in clear");
    check(!raw.includes("5551234569012") && !raw.includes('"4321"'), "the row holds no plaintext account number or PIN");
    const loa = join(env("E2E_ROOT"), "storage", "porting-docs", String(port?.loa_path));
    const loaBytes = existsSync(loa) ? readFileSync(loa) : Buffer.alloc(0);
    check(loaBytes.subarray(0, 4).toString() === "%PDF" && !loaBytes.toString("latin1").includes("5551234569012"), `signed LOA PDF stored (${loaBytes.length} bytes), no account number in it`);
    got = sinceMark();
    const ready = smsTo(got, dana.phone);
    check(ready.length === 1 && /Got it - everything's in for moving \(705\) 555-0142\. We'll send it to your carrier within 1 business day and text you when it's in\./.test(String(ready[0].body)), `owner: "${short(ready[0]?.body, 200)}"`);
    check(allSms(got).every((m) => !String(m.body).includes("5551234569012") && !/\b4321\b/.test(String(m.body))), "no text carries the secrets");
    setMark();
  });

  await step("P2. operator: reveal (audited, no values in the audit) + Mark submitted (Twilio snapshot via the fake) → owner text; the number arrives in the Twilio account → completion sweep attaches it as business_line + Done text", async () => {
    const { data: u } = await admin.auth.admin.createUser({ email: OPERATOR, password: PASSWORD, email_confirm: true, user_metadata: { full_name: "Operator" } });
    if (u?.user) await db.from("profiles").upsert({ id: u.user.id, email: OPERATOR, full_name: "Operator" });
    const opToken = await signInToken(OPERATOR);
    const action = (name: string, input: Record<string, unknown>) => api(opToken, "POST", `/api/concierge/accounts/${dana.orgId}/actions`, { action: name, companyId: dana.companyId, input });
    const reveal = await action("port_reveal_secrets", { portId: ids.port });
    check(reveal.status === 200 && dataOf(reveal)?.result?.accountNumber === "5551234569012" && dataOf(reveal)?.result?.pin === "4321", `reveal decrypts (${reveal.status} ${reveal.status !== 200 ? reveal.text.slice(0, 200) : ""})`);
    const { data: audit } = await db.from("operator_actions").select("action, detail").eq("organization_id", dana.orgId!).eq("action", "port_reveal_secrets");
    check((audit ?? []).length === 1 && !JSON.stringify(audit).includes("5551234569012") && !JSON.stringify(audit).includes("4321"), `audit row without the values: ${JSON.stringify(audit).slice(0, 240)}`);
    setMark();
    const submitted = await action("port_mark_submitted", { portId: ids.port, twilioRequestId: "PR0e2e3phase3" });
    check(submitted.status === 200, `port_mark_submitted → ${submitted.status} ${submitted.status !== 200 ? submitted.text.slice(0, 200) : ""}`);
    const { data: port } = await db.from("number_port_requests").select("*").eq("id", ids.port).single();
    check(port?.status === "submitted" && port?.twilio_snapshot_at && JSON.stringify(port?.preexisting_numbers) === "[]", `submitted, Twilio snapshot taken, nothing pre-existing (${port?.status}, ${JSON.stringify(port?.preexisting_numbers)})`);
    let got = sinceMark();
    const subText = smsTo(got, dana.phone);
    check(subText.length === 1 && /Your number move for \(705\) 555-0142 is in with the carrier \(usually 5-7 business days\)\. Don't cancel your old phone service - the move ends it for you\. Your carrier may text you asking to approve the transfer: answer YES within 90 minutes or it gets rejected\./.test(String(subText[0].body)), `owner: "${short(subText[0]?.body, 260)}"`);
    setMark();
    await tick();
    const { data: still } = await db.from("number_port_requests").select("status").eq("id", ids.port).single();
    check(still?.status === "submitted", "completion sweep: nothing there yet → still submitted");
    // The carrier releases the number: it shows up in our Twilio account (webhooks unset).
    await fetch(`${FAKES}/__twilio/incoming`, { method: "POST", body: JSON.stringify({ phone_number: BUSINESS_LINE, friendly_name: BUSINESS_LINE }) });
    setMark();
    await tick();
    const { data: done } = await db.from("number_port_requests").select("status, attached_numbers, completed_at").eq("id", ids.port).single();
    check(done?.status === "completed" && JSON.stringify(done?.attached_numbers) === JSON.stringify([BUSINESS_LINE]), `port completed, attached ${JSON.stringify(done?.attached_numbers)}`);
    const { data: vn } = await db.from("voice_numbers").select("mode, active, provider, provider_number_sid").eq("company_id", dana.companyId!).eq("phone_e164", BUSINESS_LINE);
    check((vn ?? []).length === 1 && vn![0].mode === "business_line" && vn![0].active, `voice_numbers: ${JSON.stringify(vn)}`);
    const tw = ((await (await fetch(`${FAKES}/__twilio/incoming`)).json()) as Array<{ phone_number: string; voice_url: string; sms_url: string; friendly_name: string }>).find((n) => n.phone_number === BUSINESS_LINE);
    check(tw?.voice_url === `${HOUSE_APP}/api/twilio/voice/business-line` && tw?.sms_url === `${HOUSE_APP}/api/twilio/sms/inbound` && tw?.friendly_name === `EmpireVu line ${dana.companyId}`, `Twilio webhooks + FriendlyName set (${tw?.voice_url}, ${tw?.friendly_name})`);
    got = sinceMark();
    const doneText = smsTo(got, dana.phone);
    console.log(`   owner: ${short(doneText[0]?.body)}`);
    check(doneText.length === 1 && doneText[0].from === PLATFORM && /Done: \(705\) 555-0142 now rings through us\. Calls ring your cell first for 20 seconds \(press 1 to take one\), then/.test(String(doneText[0].body)), "the owner's Done text");
    setMark();
    await tick();
    check(smsTo(sinceMark(), dana.phone).length === 0, "a second completion pass does nothing");
    setMark();
  });

  await step("P3. a signed call to /api/twilio/voice/business-line rings the owner's cell first (screened, 20 s, nothing queued); no answer → <Redirect> to the catcher path (durable job, greeting, text-back); A1's inbound voice + SMS as before", async () => {
    const sid = newSid("CA");
    const first = await postTwilio("/api/twilio/voice/business-line", callParams(sid, CALLER, BUSINESS_LINE));
    const xml = first.text;
    console.log(`   TwiML: ${short(xml, 500)}`);
    check(first.status === 200 && /<Dial[^>]*timeout="20"/.test(xml) && new RegExp(`callerId="\\${CALLER}"`).test(xml) && new RegExp(`<Number[^>]*>\\${dana.phone}</Number>`).test(xml), "<Dial timeout=20 callerId=caller><Number>owner cell</Number>");
    check(/<Number[^>]*url="[^"]*stage=screen/.test(xml), "the owner's leg is screened (Number url=…stage=screen)");
    const bad = await fetch(`${HOUSE_APP}/api/twilio/voice/business-line`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "bad" }, body: new URLSearchParams(callParams(newSid("CA"), CALLER, BUSINESS_LINE)).toString() });
    check(bad.status === 403, `unsigned → 403 (${bad.status})`);
    const { data: blc } = await db.from("business_line_calls").select("*").eq("call_sid", sid);
    check((blc ?? []).length === 1, `business_line_calls row (${JSON.stringify(blc?.[0] ?? {}).slice(0, 200)})`);
    const { data: jobs0 } = await db.from("inbound_webhook_jobs").select("id").eq("external_id", sid);
    check((jobs0 ?? []).length === 0, "nothing queued as a missed call while the owner's cell rings");
    const action = unescapeXml(xml.match(/<Dial[^>]*action="([^"]+)"/)?.[1] ?? "");
    setMark();
    const after = await postTwilio(action.startsWith("http") ? action : `${HOUSE_APP}${action}`, { ...callParams(sid, CALLER, BUSINESS_LINE), CallStatus: "in-progress", DialCallStatus: "no-answer", DialCallDuration: "0" });
    console.log(`   after: ${short(after.text, 300)}`);
    const redirect = unescapeXml(after.text.match(/<Redirect[^>]*>([^<]+)<\/Redirect>/)?.[1] ?? "");
    check(after.status === 200 && /\/api\/twilio\/voice\/inbound$/.test(redirect.split("?")[0]), `no answer → <Redirect> ${redirect}`);
    const catcher = await postTwilio(redirect.startsWith("http") ? redirect : `${HOUSE_APP}${redirect}`, { ...callParams(sid, CALLER, BUSINESS_LINE), CallStatus: "in-progress" });
    console.log(`   catcher path: ${short(catcher.text, 400)}`);
    check(catcher.status === 200 && /Northshore Snow/.test(catcher.text) && /<(Record|Dial|Say)/.test(catcher.text), "the catcher path answers for the company (greeting / AI)");
    const { data: jobs } = await db.from("inbound_webhook_jobs").select("id, provider").eq("external_id", sid);
    check((jobs ?? []).length === 1 && jobs![0].provider === "twilio_voice", `durable voice job stored (${JSON.stringify(jobs)})`);
    const { data: blc2 } = await db.from("business_line_calls").select("outcome").eq("call_sid", sid).single();
    check(blc2?.outcome === "missed", `business_line_calls outcome ${blc2?.outcome}`);
    await drain();
    const got = sinceMark();
    const textBack = smsTo(got, CALLER);
    check(textBack.length >= 1 && textBack[0].from === dana.catcher, `caller gets the text-back from the company's number (${short(textBack[0]?.body, 160)})`);
    setMark();

    // A1: inbound voice is byte-for-byte the same TwiML as before Phase 3 ran; an SMS still gets no AI reply.
    const hsid = newSid("CA");
    const hv = await postTwilio("/api/twilio/voice/inbound", callParams(hsid, HOUSE.caller, HOUSE.catcher));
    check(hv.status === 200 && normalizeTwiml(hv.text, hsid) === baseline.houseVoice, "A1 inbound voice TwiML unchanged from the baseline");
    await drain();
    setMark();
    await text(HOUSE.customer, HOUSE.catcher, "Hi, are you open Monday?");
    const hs = sinceMark();
    check(smsTo(hs, HOUSE.customer).length === 0 && hs.filter((c) => c.kind === "anthropic").length === 0, "A1 inbound SMS: stored, no AI reply, no model call (front desk off, as before)");
    const { data: inLog } = await db.from("message_log").select("id").eq("company_id", houseIds!.companyId).eq("direction", "inbound");
    check((inLog ?? []).length >= 1, `A1 inbound text logged (${(inLog ?? []).length})`);
    setMark();
  });

  await step("T0. Sunday 18:05: Ana's clock is left running (inside the pay period that ends tonight)", async () => {
    await clockTo(at(SUN, "18:05"));
    const row = must(await db.from("time_entries").insert({ organization_id: dana.orgId!, company_id: dana.companyId!, profile_id: ids.ana, started_at: new Date(at(SUN, "18:00")).toISOString(), ended_at: null, source: "clock" }).select("id").single(), "running clock") as { id: string };
    ids.anaRunning = row.id;
    await tick();
    setMark();
  });

  await step("O1. Monday 07:00: exactly ONE briefing from the platform number (jobs today, overdue without held balances, Cara's 30+ folded in); house org none; a second pass sends nothing", async () => {
    await clockTo(at(MON, "06:55"));
    await tick();
    check(briefingsTo(sinceMark(), dana.phone).length === 0, "nothing before 07:00");
    await clockTo(at(MON, "07:01"));
    await tick();
    const got = sinceMark();
    const b = briefingsTo(got, dana.phone);
    const body = String(b[0]?.body ?? "");
    console.log(`   briefing:\n      ${body.replace(/\n/g, "\n      ")}`);
    check(b.length === 1 && b[0].from === PLATFORM, `one briefing from the platform number (${b.length})`);
    check(/^(CrankLeads: )?Morning Dana - Northshore Snow & Lawn, Mon /.test(body), "greeting with the owner's first name and the day");
    check(/Today: 2 jobs, first at 9am\. Mike 1, 1 unassigned\./.test(body), "today's jobs by crew");
    check(/Money: \$1,760 overdue \(2 invoices\)\./.test(body), "overdue = Bob + Cara only ($1,760, 2 invoices) — the $1,690.50 held import left out");
    check(/Now 30\+ days overdue: Cara Diaz \$520/.test(body), "the 8am alert's new item (Cara 30+) rides along");
    check(new RegExp(`Waiting on you: #${ids.chaseCode} `).test(body), "the chase question is waiting on the owner");
    check(/Since Saturday: 1 new lead\b/.test(body), "Since Saturday: 1 new lead (the caller) — the 3 imported customers are not leads");
    check(/Reply "today" for details\./.test(body), "reply hint");
    const { data: rows } = await db.from("owner_briefings").select("*").eq("company_id", dana.companyId!);
    check((rows ?? []).length === 1 && rows![0].status === "sent" && rows![0].money_fold === "included" && rows![0].local_date === MON, `owner_briefings: ${JSON.stringify((rows ?? []).map((r: { status: string; money_fold: string; local_date: string }) => [r.local_date, r.status, r.money_fold]))}`);
    const { data: houseRows } = await db.from("owner_briefings").select("id").eq("company_id", houseIds!.companyId);
    check((houseRows ?? []).length === 0 && briefingsTo(got, HOUSE.owner).length === 0, "A1 (house): no briefing");
    setMark();
    await clockTo(at(MON, "07:05"));
    await tick();
    check(briefingsTo(sinceMark(), dana.phone).length === 0, "a second pass sends nothing");
    setMark();
  });

  await step("O2+R1. Monday 08:00: no standalone money alert for the CrankLeads company; A1's 8am alert goes as before; the payroll_period approval text arrives (OT + open entry flagged)", async () => {
    await clockTo(at(MON, "08:05"));
    await tick();
    const got = sinceMark();
    check(standaloneAlerts(got, dana.phone).length === 0, `no "Money check for" text to the CrankLeads owner (${standaloneAlerts(got, dana.phone).length})`);
    check(smsTo(got, dana.phone).every((m) => !/30\+ days overdue/.test(String(m.body))), "Cara's 30+ line is not sent a second time");
    const houseAlert = standaloneAlerts(got, HOUSE.owner);
    console.log(`   A1 alert: ${short(houseAlert[0]?.body)}`);
    check(houseAlert.length === 1 && houseAlert[0].from === PLATFORM && /^(CrankLeads: |A1 Marine Care: )?Money check for A1 Marine Care:/.test(String(houseAlert[0].body)) && /Now 30\+ days overdue: Hank Owes \$800/.test(String(houseAlert[0].body)), "A1's standalone 8am alert (Hank 30+)");
    const appr = await latestApproval(dana.companyId!, "payroll_period");
    ids.payrollCode = String(appr?.short_code ?? "");
    const ask = smsTo(got, dana.phone).find((m) => /Payroll /.test(String(m.body)));
    console.log(`   payroll ask: ${short(ask?.body, 600)}`);
    check(appr?.status === "pending" && ask?.from === PLATFORM, `payroll_period #${appr?.short_code} asked from the platform number`);
    const body = String(ask?.body ?? "");
    check(new RegExp(`#${appr?.short_code} Payroll `).test(body) && /Ana 6h/.test(body) && /Mike 47\.5h \(OT 3\.5h\)/.test(body) && /Total 53\.5h, OT 3\.5h flagged \(over 44h\/wk\)/.test(body), "hours per person, total, OT flagged");
    check(/1 open entry \(no clock-out\): Ana Sun /.test(body) && new RegExp(`Fix the open entry in the app and reply Y ${appr?.short_code}, or reply Y ${appr?.short_code} anyway to lock as is\\. N ${appr?.short_code} to skip\\.`).test(body), "the open entry and the 'anyway' reply line");
    check(new RegExp(BOOKS.replace(/\./g, "\\.")).test(body), "names the CSV email");
    const { data: pp } = await db.from("pay_periods").select("*").eq("company_id", dana.companyId!);
    ids.period = pp?.[0]?.id;
    check((pp ?? []).length === 1 && pp![0].status === "awaiting_owner" && pp![0].start_date === MON0 && pp![0].end_date === SUN, `pay_periods: ${JSON.stringify((pp ?? []).map((p: { start_date: string; end_date: string; status: string }) => [p.start_date, p.end_date, p.status]))}`);
    setMark();
  });

  await step("R2. 'Y n' with an open entry → nothing locked, re-asked with a fresh code; 'Y m anyway' → locked + CSV emailed (Resend fake); a locked entry can't be edited via the API, but the running clock can be stopped", async () => {
    await text(dana.phone, PLATFORM, `Y ${ids.payrollCode}`);
    let got = sinceMark();
    const reask = smsTo(got, dana.phone);
    console.log(`   owner: ${short(reask[0]?.body)}`);
    const fresh = await latestApproval(dana.companyId!, "payroll_period");
    check(reask.length === 1 && new RegExp(`Not locked yet: 1 open entry with no clock-out \\(Ana Sun [^)]+\\)\\. Fix it in the app, then reply Y ${fresh?.short_code} - or Y ${fresh?.short_code} anyway to lock as is \\(open entries count as 0\\)\\.`).test(String(reask[0].body)), "re-asked with a fresh code");
    const { data: p1 } = await db.from("pay_periods").select("status, approval_id").eq("id", ids.period).single();
    check(p1?.status === "awaiting_owner" && p1?.approval_id === fresh?.id && String(fresh?.short_code) !== ids.payrollCode, "nothing locked; the period points at the new approval");
    check(emails(got).length === 0, "no CSV email yet");
    setMark();
    await text(dana.phone, PLATFORM, `Y ${fresh?.short_code} anyway`);
    got = sinceMark();
    const locked = smsTo(got, dana.phone);
    console.log(`   owner: ${short(locked[0]?.body)}`);
    check(locked.length === 1 && new RegExp(`Locked payroll .+ \\(2 people, 53\\.5h, OT 3\\.5h\\) and emailed the CSV to ${BOOKS.replace(/\./g, "\\.")}\\.`).test(String(locked[0].body)), "owner: locked + emailed");
    const mail = emails(got).filter((e) => e.to === BOOKS);
    const att = (mail[0]?.attachments as Array<{ filename: string; content: string }> | undefined)?.[0];
    console.log(`   CSV ${att?.filename}:\n      ${String(att?.content).replace(/\n/g, "\n      ")}`);
    check(mail.length === 1 && att?.filename === `northshore-snow-lawn-payroll-${MON0}-to-${SUN}.csv`, `one email to ${BOOKS} with ${att?.filename}`);
    const csv = String(att?.content ?? "");
    check(/^employee_name,employee_email,period_start,period_end,regular_hours,ot_hours,total_hours,hourly_rate,gross_estimate,job_count,notes/.test(csv), "CSV header");
    check(/Mike Tran,mike@northshoresnow\.ca,[^,]+,[^,]+,44\.00,3\.50,47\.50,25\.00,1231\.25,/.test(csv) && /Ana Silva/.test(csv) && /Ana Silva,[^\n]*,6\.00,0\.00,6\.00,22\.00,132\.00,0,1 open entry not counted/.test(csv), "Mike 44 + 3.5 OT at $25 (gross $1,231.25); Ana 6 h with her open entry noted");
    const { data: p2 } = await db.from("pay_periods").select("status, csv_emailed_at").eq("id", ids.period).single();
    check(p2?.status === "locked" && p2?.csv_emailed_at, `pay period locked, csv_emailed_at ${p2?.csv_emailed_at}`);
    setMark();
    // A locked entry via the API (the owner's timesheet edit) → refused.
    const edit = await api(danaToken, "PATCH", `/api/organizations/${dana.orgId}/time/entries/${ids.mikeEntry}`, { breakMinutes: 0 });
    check(edit.status >= 400 && edit.status < 500 && /locked for payroll/i.test(edit.text), `PATCH a locked entry → ${edit.status} ${edit.text.slice(0, 200)}`);
    const add = await api(danaToken, "POST", `/api/organizations/${dana.orgId}/time/entries`, { profileId: ids.mike, startedAt: new Date(at(addDays(MON0, 5), "08:00")).toISOString(), endedAt: new Date(at(addDays(MON0, 5), "12:00")).toISOString() });
    check(add.status >= 400 && add.status < 500 && /locked for payroll/i.test(add.text), `a backdated entry into the locked period → ${add.status}`);
    const del = await api(danaToken, "DELETE", `/api/organizations/${dana.orgId}/time/entries/${ids.mikeEntry}`);
    check(del.status >= 400 && del.status < 500, `DELETE a locked entry → ${del.status}`);
    const { data: still } = await db.from("time_entries").select("break_minutes").eq("id", ids.mikeEntry).single();
    check(still?.break_minutes === 30, "the entry is unchanged");
    const anaToken = await signInToken(ANA.email);
    const out = await api(anaToken, "DELETE", `/api/organizations/${dana.orgId}/time/clock`);
    const { data: ran } = await db.from("time_entries").select("ended_at").eq("id", ids.anaRunning).single();
    check(out.status === 200 && ran?.ended_at, `Ana stops her running clock in the locked period → ${out.status} (ended ${ran?.ended_at})`);
    setMark();
  });

  await step("O3. owner texts 'today' → the owner agent calls briefing_now (detail) and relays it; no second owner_briefings row", async () => {
    await text(dana.phone, PLATFORM, "today");
    const got = sinceMark();
    const turns = got.filter((c) => c.kind === "anthropic" && c.purpose === "owner_agent");
    check(turns.some((t) => (t.tools as string[] | undefined)?.includes("briefing_now")), "the owner agent is offered briefing_now");
    const reply = smsTo(got, dana.phone);
    console.log(`   reply: ${short(reply[0]?.body, 500)}`);
    check(reply.length === 1 && reply[0].from === PLATFORM && /Morning Dana - Northshore Snow & Lawn/.test(String(reply[0].body)) && /Rita|Salt driveway|9(:00)? ?am/i.test(String(reply[0].body)), "the briefing + details relayed");
    const { data: rows } = await db.from("owner_briefings").select("id").eq("company_id", dana.companyId!);
    check((rows ?? []).length === 1, "briefing_now never writes owner_briefings");
    setMark();
  });

  await step("I3. Monday 09:30: the Bookkeeper's reminder texts skip the held balances; owner 'Y <code>' releases the hold (then they're in the email sweep)", async () => {
    await clockTo(at(MON, "09:30"));
    await tick();
    let got = sinceMark();
    const { data: rt } = await db.from("invoice_reminder_texts").select("invoice_id, status").eq("company_id", dana.companyId!);
    console.log(`   reminder texts: ${JSON.stringify(rt)}`);
    check((rt ?? []).every((r: { invoice_id: string }) => !importedHeld.includes(r.invoice_id)), "no invoice_reminder_texts for held balances");
    check(smsTo(got, "+17055550301").length === 0 && smsTo(got, "+17055550304").length === 0, "no text to Lena or Nia");
    setMark();
    await text(dana.phone, PLATFORM, `Y ${ids.chaseCode}`);
    got = sinceMark();
    const res = smsTo(got, dana.phone);
    console.log(`   owner: ${short(res[0]?.body)}`);
    check(res.length === 1 && /Done - reminders can start on 2 imported balances \(\$1,690(\.50)?\), on your usual schedule\./.test(String(res[0].body)), "owner: hold released");
    const { data: inv } = await db.from("invoices").select("import_hold, reminders_paused").in("id", importedHeld);
    check((inv ?? []).every((i: { import_hold: boolean; reminders_paused: boolean }) => !i.import_hold && !i.reminders_paused), `import_hold + reminders_paused cleared (${JSON.stringify(inv)})`);
    check(smsTo(got, "+17055550301").length === 0 && smsTo(got, "+17055550304").length === 0, "releasing sends nothing by itself");
    const r = await sweepInvoiceReminders(new Date());
    check(importedHeld.every((id) => r.flaggedOverdue.includes(id)), "the released balances are now in the email sweep (overdue fired)");
    const { data: b } = await db.from("import_batches").select("chase_status").eq("id", ids.batch1).single();
    console.log(`   chase_status: ${b?.chase_status}`);
    setMark();
  });

  await step("I4. undo: a second import (signed-in route) → done + its own chase question → Undo → the customers, job and balance it created are removed and the question withdrawn", async () => {
    const csv = ["Name,Phone,Email,Last Service Date,Balance", "Theo Grant,705-555-0311,,2025-07-01,", "Uma Reyes,705-555-0312,uma@example.test,,$300", "Vic Lam,,vic@example.test,,"].join("\n");
    const bytes = Buffer.from(csv, "utf8");
    const created = await api(danaToken, "POST", `${coBase()}/imports`, { fileName: "more.csv", fileSize: bytes.length, contentType: "text/csv" });
    const batch = dataOf(created)?.batch;
    const upload = dataOf(created)?.upload;
    check(created.status === 201, `POST …/imports (signed in) → ${created.status} ${created.status !== 201 ? created.text.slice(0, 200) : ""}`);
    await uploadSigned(upload.bucket, upload.path, upload.token, bytes, "text/csv");
    const up = await api(danaToken, "POST", `${coBase()}/imports/${batch.id}`, { action: "uploaded" });
    check(dataOf(up)?.status === "previewed", `previewed (${dataOf(up)?.status} ${dataOf(up)?.error ?? ""})`);
    await api(danaToken, "POST", `${coBase()}/imports/${batch.id}`, { action: "import" });
    for (let i = 0; i < 4; i++) {
      await tick();
      const { data: b } = await db.from("import_batches").select("status, owner_notified_at").eq("id", batch.id).single();
      if (b?.status === "done" && b.owner_notified_at) break;
    }
    let got = sinceMark();
    const doneText = smsTo(got, dana.phone);
    console.log(`   done: ${short(doneText[0]?.body, 400)}`);
    const chase2 = await latestApproval(dana.companyId!, "chase_imported_balances");
    check(/Imported 3 customers, 1 past job, 1 open balance \(\$300(\.00)?\) from more\.csv/.test(String(doneText[0]?.body)) && chase2?.status === "pending" && chase2?.id !== undefined, `done text + a new chase question #${chase2?.short_code}`);
    const { data: made } = await db.from("contacts").select("id").eq("company_id", dana.companyId!).contains("metadata", { import: { batchId: batch.id } });
    check((made ?? []).length === 3, `3 contacts from this batch (${(made ?? []).length})`);
    setMark();
    const undo = await api(danaToken, "POST", `${coBase()}/imports/${batch.id}`, { action: "undo" });
    check(dataOf(undo)?.status === "undoing", `Undo → ${dataOf(undo)?.status}`);
    for (let i = 0; i < 6; i++) {
      await tick();
      const { data: b } = await db.from("import_batches").select("status").eq("id", batch.id).single();
      if (b?.status === "undone") break;
    }
    const { data: b2 } = await db.from("import_batches").select("status, undo_report").eq("id", batch.id).single();
    console.log(`   undo report: ${JSON.stringify(b2?.undo_report).slice(0, 400)}`);
    check(b2?.status === "undone", `batch undone (${b2?.status})`);
    const { data: left } = await db.from("contacts").select("id").eq("company_id", dana.companyId!).contains("metadata", { import: { batchId: batch.id } });
    const { data: inv } = await db.from("invoices").select("id").eq("import_batch_id", batch.id);
    const { data: jobs } = await db.from("bookings").select("id").eq("company_id", dana.companyId!).like("source", `import:${batch.id}%`);
    check((left ?? []).length === 0 && (inv ?? []).length === 0 && (jobs ?? []).length === 0, `contacts / balance / job removed (${(left ?? []).length}/${(inv ?? []).length}/${(jobs ?? []).length})`);
    const { data: c2 } = await db.from("owner_approvals").select("status").eq("id", chase2?.id).single();
    check(c2?.status === "superseded", `the pending chase question is withdrawn (${c2?.status})`);
    const { data: first } = await db.from("contacts").select("id").eq("company_id", dana.companyId!).contains("metadata", { import: { batchId: ids.batch1 } });
    check((first ?? []).length === 3, "the first import's customers are untouched");
    if (b2?.status !== "undone") {
      const { data: stuck } = await db.from("import_batches").select("status, failures, error, undo_phase, undo_cursor").eq("id", batch.id).single();
      console.log(`   BUG: undo stuck: ${JSON.stringify(stuck)}`);
      // Park it (test data only) so its retries / give-up text don't leak into the later steps.
      await db.from("import_batches").update({ status: "failed", error: `e2e parked: ${stuck?.error ?? ""}`.slice(0, 300), owner_notified_at: new Date().toISOString() }).eq("id", batch.id);
    }
    got = sinceMark();
    check(allSms(got).filter((m) => m.to !== dana.phone).length === 0 && emails(got).length === 0, "undo messaged nobody");
    setMark();
  });

  await step("H1. hiring: 'I need a labourer, $22/hr, start Monday' → start_hiring → job_post approval asked inline → Y publishes /s/<slug>/jobs + the paste copy", async () => {
    await clockTo(at(MON, "10:00"));
    await text(dana.phone, PLATFORM, "I need a labourer, $22/hr, start Monday");
    let got = sinceMark();
    const draft = got.find((c) => c.kind === "anthropic" && c.purpose === "recruiter_draft");
    check(draft && /\$22\/hr/.test(String(draft.owner)), "the job post was drafted by the model from the owner's words (fenced)");
    const appr = await latestApproval(dana.companyId!, "job_post");
    const ask = smsTo(got, dana.phone);
    console.log(`   owner: ${short(ask[0]?.body, 600)}`);
    check(appr?.status === "pending" && ask.length === 1 && new RegExp(`#${appr?.short_code} Job post "Labourer" - \\$22/hr`).test(String(ask[0].body)) && new RegExp(`Reply Y ${appr?.short_code} to post it, N ${appr?.short_code} to skip\\.`).test(String(ask[0].body)), `job_post #${appr?.short_code} asked inline`);
    const { data: jp } = await db.from("job_postings").select("*").eq("company_id", dana.companyId!);
    ids.job = jp?.[0]?.id;
    check((jp ?? []).length === 1 && jp![0].status === "awaiting_owner" && jp![0].pay_text === "$22/hr", `job_postings: awaiting_owner, pay ${jp?.[0]?.pay_text}`);
    const before = await fetch(`${HOUSE_APP}/s/${slug}/jobs/${ids.job}`);
    check(before.status === 404, `not public before the Y (${before.status})`);
    setMark();
    await text(dana.phone, PLATFORM, `Y ${appr?.short_code}`);
    got = sinceMark();
    const owner = smsTo(got, dana.phone);
    console.log(`   owner: ${owner.map((m) => short(m.body, 300)).join("  ||  ")}`);
    const posted = owner.find((m) => /Posted the Labourer job:/.test(String(m.body)));
    const copy = owner.find((m) => /Copy for Indeed\/Facebook:\s/.test(String(m.body)) && !/Posted/.test(String(m.body)));
    check(owner.length === 2 && new RegExp(`Posted the Labourer job: http://app\\.crankleads\\.localhost:\\d+/s/${slug}/jobs/${ids.job}`).test(String(posted?.body)), "the 'Posted the Labourer job: <link>' text");
    check(/Copy for Indeed\/Facebook:\s+Northshore Snow & Lawn is hiring: Labourer \(\$22\/hr/.test(String(copy?.body)) && /Apply here: \S+\/jobs\//.test(String(copy?.body)) && /This is a current opening\./.test(String(copy?.body)), "the Indeed/Facebook copy text (how to apply, current opening)");
    console.log(`   order: ${owner.map((m) => (m === posted ? "posted" : m === copy ? "copy" : "?")).join(" → ")}`);
    const { data: jp2 } = await db.from("job_postings").select("status").eq("id", ids.job).single();
    check(jp2?.status === "open", `job open (${jp2?.status})`);
    const list = await fetch(`${HOUSE_APP}/s/${slug}/jobs`);
    const listHtml = await list.text();
    check(list.status === 200 && /Labourer/.test(listHtml), `GET /s/${slug}/jobs → ${list.status}, lists the job`);
    const page = await fetch(`${HOUSE_APP}/s/${slug}/jobs/${ids.job}`);
    const html = await page.text();
    check(page.status === 200 && /This is a current opening\./.test(html) && /We use AI to help sort applications\. A person reads every one and makes every decision\./.test(html) && /name="licence"/.test(html), `job page ${page.status}: vacancy + AI disclosure + apply form`);
    setMark();
  });

  async function apply(person: { name: string; phone: string }, experience: string): Promise<{ status: number; html: string }> {
    const page = await (await fetch(`${HOUSE_APP}/s/${slug}/jobs/${ids.job}`)).text();
    const t = page.match(/name="t" value="(\d+)"/)?.[1] ?? "";
    await sleep(3500);
    const form = new URLSearchParams({ name: person.name, phone: person.phone, email: "", experience, availability: "Any weekday, can start Monday", licence: "yes", vehicle: "yes", q0: "Yes", website: "", t });
    const res = await fetch(`${HOUSE_APP}/s/${slug}/jobs/${ids.job}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
    return { status: res.status, html: await res.text() };
  }

  await step("H2. a public apply (10:05) → applicant row + paused applicant contact (not a lead) + the confirmation text from the business number at once; screening by the sweep (no name/phone to the model)", async () => {
    const r = await apply(JORDAN, "3 yrs snow removal and lawn care with a landscaping crew in Barrie. Working at Heights ticket.");
    check(r.status === 200 && /thanks|Thank/i.test(r.html), `apply POST → ${r.status}`);
    let got = sinceMark();
    const conf = smsTo(got, JORDAN.phone);
    check(conf.length === 1 && conf[0].from === dana.catcher && String(conf[0].body).startsWith("Hi Jordan, thanks for applying for the Labourer job at Northshore Snow & Lawn. We got your application and we'll be in touch."), `confirmation from the business number: "${short(conf[0]?.body)}"`);
    const { data: a } = await db.from("job_applicants").select("*").eq("job_id", ids.job).eq("phone", JORDAN.phone).single();
    check(a?.confirmation_status === "sent", `job_applicants row, confirmation ${a?.confirmation_status}`);
    const { data: c } = await db.from("contacts").select("id, consent_source, metadata").eq("company_id", dana.companyId!).eq("phone_last10", JORDAN.phone.slice(-10)).single();
    check(c?.consent_source === "job_application" && c?.metadata?.kind === "applicant", `applicant contact: consent_source ${c?.consent_source}, metadata.kind ${c?.metadata?.kind}`);
    setMark();
    await clockTo(at(MON, "10:10"));
    await tick();
    got = sinceMark();
    const screen = got.filter((x) => x.kind === "anthropic" && x.purpose === "recruiter_screen");
    const { data: a2 } = await db.from("job_applicants").select("score, score_reason").eq("id", a?.id).single();
    check(screen.length === 1 && screen[0].sawContact === false && !/Jordan|Pike/.test(String(screen[0].answers)), `screened once by the model without name/phone/email (${screen.length})`);
    check(a2?.score === 5, `score ${a2?.score}: ${a2?.score_reason}`);
    // The 08:30–11:00 digest window is open: the same tick digests Jordan and asks about inviting him.
    const digest = smsTo(got, dana.phone).find((m) => /Hiring \(Northshore Snow & Lawn\)/.test(String(m.body)));
    console.log(`   digest: ${short(digest?.body, 400)}`);
    check(digest && digest.from === PLATFORM && /1 new applicant for Labourer\. Top: Jordan P\. 5\/5 - 3 yrs snow and lawn work, has licence/.test(String(digest.body)) && /Text "applicants" for the full list\./.test(String(digest.body)), "the digest (window 08:30–11:00) — Jordan 5/5");
    const invite = await latestApproval(dana.companyId!, "interview_invite");
    ids.jordanInvite = String(invite?.short_code ?? "");
    const inviteAsk = smsTo(got, dana.phone).find((m) => new RegExp(`#${invite?.short_code} `).test(String(m.body)));
    console.log(`   invite ask: ${short(inviteAsk?.body, 400)}`);
    check(invite?.status === "pending" && inviteAsk?.from === PLATFORM && /Invite Jordan Pike \(705-555-0401\) to talk about the Labourer job\? Score 5\/5/.test(String(inviteAsk?.body)) && /Y texts them: "Hi Jordan, Northshore Snow & Lawn would like to talk about the Labourer job\. When's a good time for a quick call this week\?"/.test(String(inviteAsk?.body)), "interview_invite asked with the exact invite text");
    // A real lead texts in on Monday (counted in Tuesday's briefing).
    await text(KIM.phone, dana.catcher!, "Hi, do you plow driveways in Midland?");
    check(smsTo(sinceMark(), KIM.phone).length === 1, "the lead gets the assistant's reply");
    setMark();
  });

  await step("H3. a late apply (21:30) waits; Tuesday 07:00 briefing counts 1 new lead (not the 2 applicants); 08:00 the late confirmation goes out; 08:30 digest → interview_invite → Y → the exact invite text", async () => {
    await clockTo(at(MON, "21:30"));
    const r = await apply(SASHA, "Some general labour, warehouse work.");
    check(r.status === 200, `late apply → ${r.status}`);
    check(smsTo(sinceMark(), SASHA.phone).length === 0, "no confirmation at 21:30 (outside 08:00–21:00)");
    const { data: s0 } = await db.from("job_applicants").select("confirmation_status").eq("phone", SASHA.phone).single();
    check(s0?.confirmation_status === "pending", `confirmation pending (${s0?.confirmation_status})`);
    await tick();
    setMark();
    await clockTo(at(TUE, "07:01"));
    await tick();
    let got = sinceMark();
    const b = briefingsTo(got, dana.phone);
    const body = String(b[0]?.body ?? "");
    console.log(`   Tuesday briefing:\n      ${body.replace(/\n/g, "\n      ")}`);
    check(b.length === 1, "one Tuesday briefing");
    check(/Yesterday: 1 new lead\b/.test(body), "Yesterday: 1 new lead (Kim), the applicant not counted");
    check(smsTo(got, SASHA.phone).length === 0, "still no confirmation before 08:00");
    setMark();
    await clockTo(at(TUE, "08:05"));
    await tick();
    got = sinceMark();
    const conf = smsTo(got, SASHA.phone);
    check(conf.length === 1 && conf[0].from === dana.catcher && /^Hi Sasha, thanks for applying for the Labourer job at Northshore Snow & Lawn\./.test(String(conf[0].body)), `the late applicant's confirmation at 08:05 (${short(conf[0]?.body, 120)})`);
    check(!smsTo(got, dana.phone).some((m) => /^(CrankLeads: )?Hiring \(/.test(String(m.body))), "no digest before 08:30");
    setMark();
    await clockTo(at(TUE, "08:31"));
    await tick();
    got = sinceMark();
    const digest = smsTo(got, dana.phone).find((m) => /Hiring \(Northshore Snow & Lawn\)/.test(String(m.body)));
    console.log(`   digest: ${short(digest?.body, 400)}`);
    check(digest && digest.from === PLATFORM && /1 new applicant for Labourer\. Top: Sasha L\. [1-5]\/5/.test(String(digest.body)), "Tuesday's digest: only the new applicant (Sasha)");
    const sashaInvite = await latestApproval(dana.companyId!, "interview_invite");
    check(sashaInvite && /Sasha Lund/.test(sashaInvite.summary) && sashaInvite.short_code !== Number(ids.jordanInvite), `a second interview_invite for Sasha (#${sashaInvite?.short_code})`);
    setMark();
    await tick();
    check(!smsTo(sinceMark(), dana.phone).some((m) => /Hiring \(/.test(String(m.body))), "the digest goes once a day");
    setMark();
    await text(dana.phone, PLATFORM, `Y ${ids.jordanInvite}`);
    got = sinceMark();
    const toJordan = smsTo(got, JORDAN.phone);
    check(toJordan.length === 1 && toJordan[0].from === dana.catcher && toJordan[0].body === "Hi Jordan, Northshore Snow & Lawn would like to talk about the Labourer job. When's a good time for a quick call this week?", `Jordan gets exactly the invite: "${toJordan[0]?.body}"`);
    const { data: a } = await db.from("job_applicants").select("invited_at").eq("phone", JORDAN.phone).single();
    check(a?.invited_at, "invited_at claimed");
    setMark();
    await text(JORDAN.phone, dana.catcher!, "Hi! I can talk any time after 3 today.");
    got = sinceMark();
    check(got.filter((c) => c.kind === "anthropic" && c.purpose === "sms_agent").length === 0 && smsTo(got, JORDAN.phone).length === 0, "Jordan's reply is not answered by the AI");
    check(smsTo(got, dana.phone).some((m) => /after 3 today/.test(String(m.body))), "…it reaches the owner");
    setMark();
  });

  await step("Z. house (A1) tenant: none of the four features touched it — no briefing, import, port, payroll or job rows; only the Bookkeeper it opted into; its owner agent has no Phase 3 tools", async () => {
    const h = houseIds!;
    const roles = (await activeRolesFor(admin, { organizationId: h.orgId, companyId: h.companyId })).map((r) => r.role);
    check(!roles.some((r) => /office|import|port|recruit/i.test(r)), `activeRolesFor(A1) = [${roles.join(", ")}]`);
    for (const table of ["owner_briefings", "import_batches", "import_links", "number_port_requests", "business_line_calls", "pay_periods", "job_postings", "job_applicants"]) {
      const { data, error } = await db.from(table).select("id").eq("company_id", h.companyId);
      check(!error && (data ?? []).length === 0, `${table}: none for A1${error ? ` (${error.message})` : ""}`);
    }
    const { data: appr } = await db.from("owner_approvals").select("kind").eq("company_id", h.companyId);
    check((appr ?? []).length === 0, `no owner_approvals for A1 (${JSON.stringify(appr)})`);
    const toHouse = captured().filter((c) => c.kind === "sms" && [HOUSE.owner, HOUSE.debtor, HOUSE.customer, HOUSE.caller].includes(String(c.to)));
    check(toHouse.length === 1 && /Money check for A1 Marine Care/.test(String(toHouse[0].body)), `the only text to an A1 number all run was its 8am alert (${toHouse.map((c) => `${c.to}: ${short(c.body, 60)}`).join(" | ")})`);
    setMark();
    await text(HOUSE.owner, PLATFORM, "today");
    const got = sinceMark();
    const turns = got.filter((c) => c.kind === "anthropic" && c.purpose === "owner_agent");
    const phase3Tools = ["briefing_now", "send_import_link", "import_status", "start_number_port", "number_port_status", "start_hiring", "applicants", "invite_applicant", "close_job"];
    check(turns.every((t) => !(t.tools as string[]).some((n) => phase3Tools.includes(n))), `A1 owner agent: no Phase 3 tools (${turns.length} turn(s); ${JSON.stringify(turns[0]?.tools ?? [])})`);
    check(briefingsTo(got, HOUSE.owner).length === 0, "A1 'today' gets no briefing");
    const jobsPage = await fetch(`${HOUSE_APP}/s/a1-marine-care-p3/jobs`);
    check(jobsPage.status === 404, `no jobs page for A1 (${jobsPage.status})`);
    setMark();
  });

  // ── timeline ───────────────────────────────────────────────────────────────
  const names = new Map<string, string>([
    [dana.phone, "owner"],
    [PLATFORM, "platform"],
    [dana.catcher ?? "", "company#"],
    [BUSINESS_LINE, "line"],
    [CALLER, "caller"],
    [KIM.phone, "Kim(lead)"],
    [JORDAN.phone, "Jordan"],
    [SASHA.phone, "Sasha"],
    [BOB.phone, "Bob"],
    [CARA.phone, "Cara"],
    [HOUSE.catcher, "A1#"],
    [HOUSE.owner, "A1 owner"],
    [HOUSE.customer, "A1 cust"],
  ]);
  const label = (v: unknown) => names.get(String(v)) ?? String(v);
  console.log("\n── Message timeline (Toronto time · from → to · first line)");
  const all = captured();
  for (const c of all) {
    if (c.kind === "sms") console.log(`   ${torontoTime(Date.parse(c.t))}  ${label(c.from).padEnd(10)} → ${label(c.to).padEnd(11)}  ${String(c.body).split("\n")[0].slice(0, 130)}`);
    if (c.kind === "email") console.log(`   ${torontoTime(Date.parse(c.t))}  email      → ${String(c.to).padEnd(11)}  ${String(c.subject).slice(0, 110)}`);
  }
  const unhandled = all.filter((c) => c.kind === "unhandled");
  if (unhandled.length) console.log(`\n── Unhandled third-party calls: ${JSON.stringify(unhandled).slice(0, 1000)}`);
  console.log("\n── Summary");
  for (const r of results) console.log(`   ${r.ok ? "PASS" : "FAIL"}  ${r.step}`);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} steps passed, ${checks - failedChecks}/${checks} checks ok`);
  writeFileSync(join(OUT, "phase3-results.json"), JSON.stringify({ results, checks, failedChecks }, null, 2));
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
