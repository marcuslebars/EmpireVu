/**
 * Phase 4 — Receipts & HST (the Tax Clerk), Service plans, Compliance and Purchasing
 * (docs/ai-staff.md), plus the Office manager's heads-ups, end to end on the done-for-you e2e stack
 * (scripts/e2e-dfy/README.md → "Phase 4"). Real local Postgres (every migration) + PostgREST + Next
 * + the app's own worker code (inbound queue drain, runScheduler → runStaffSweeps) in this process;
 * Twilio (incl. MMS media), Anthropic (receipt / certificate readers), Resend and Stripe (Connect
 * Checkout) are the fakes in fakes.mjs, storage is the gateway's stub. Run with phase4.sh.
 *
 * The clock starts on a Monday M0 chosen so that M0+9 … M0+11 sit inside the HST reminder window
 * (10 days before the quarter's payment date), then moves forward:
 *   M0   Mon 09:30  seed · receipts by text (job, duplicate, certificate → Compliance, a bare photo)
 *                   · a plan created in Settings, two public sign-ups paid through Stripe Connect
 *                   · a customer asks for proof of insurance → Y → link · A1 photos
 *   M0+7 Mon 10:00  the plan_renewals batch → Y → renewal link texted
 *   M0+8 Tue 10:00  the certificate's 30-day text · share link expired (410) · a second share revoked
 *   M0+9 Wed 09:05  HST reminder → Y → packet email · the sub's 7-day request_sub_docs → Y → link ·
 *                   two quoted jobs → materials_order × 2 · a customer ask declined (N) between them
 *                   · "Y n delivery" / "Y n"
 *   M0+11 Fri 07:01 the briefing (cert, pickup, HST heads-ups; ≤ 612 septets) · the sub uploads ·
 *                   15:05 the pickup reminder · a "PO-1" receipt → actual in materials_status
 *   M0+12 Sat 10:00 the plan visit heads-up (~10 days before)
 *   M0+31 / M0+38   the certificate's 7-day and expiry-day texts · M0+33 an unpaid renewal lapses
 *   then the house (A1) tenant: none of it touched it; its recurring series + auto-invoicing as before.
 */
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import Stripe from "stripe";

import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createCrankleadsCheckout } from "@/server/services/crankleads/checkout";
import { claimBillingEventJobs } from "@/server/services/billing/jobs";
import { processBillingEventJob } from "@/server/services/billing/events";
import { updateBookingStatus } from "@/server/services/bookings";
import { generateSite } from "@/server/services/dfy/site-generator";
import { switchOnEverything } from "@/server/services/dfy/switch-on";
import { processInboundWebhookJobs } from "@/server/services/inbound-webhook-jobs";
import { createRecurringJob } from "@/server/services/recurring/service";
import { resetRecruiterCompanyCache } from "@/server/services/staff/recruiter";
import { resetTaxClerkCompanyCache } from "@/server/services/staff/tax-clerk";
import { activeRolesFor, resetStaffSweepClock } from "@/server/services/staff/registry";
import { resumeDueWorkflowRuns, runScheduler } from "@/server/services/workflow-engine/scheduler";
import { claimWorkflowEventJobs, processWorkflowEventJob } from "@/server/services/workflow-event-jobs";

type Admin = ReturnType<typeof createSupabaseAdminClient>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any; // the Phase 4 tables aren't in database.types.ts yet

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
};
const HOUSE_APP = env("APP_BASE_URL");
const SUPABASE = env("NEXT_PUBLIC_SUPABASE_URL");
const CAPTURE = env("E2E_CAPTURE_LOG");
const OUT = env("E2E_PHASE4_OUT", join(env("E2E_ROOT"), "phase4-out"));
const CLOCK_FILE = env("E2E_CLOCK_FILE");
const PLATFORM = env("TWILIO_FROM_NUMBER");
const PASSWORD = "e2e-password-123";
const FAKES = `http://127.0.0.1:${env("E2E_FAKES_PORT")}`;
const TZ = "America/Toronto";
const STORAGE = join(env("E2E_ROOT"), "storage");

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
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
/** "Oct 10" */
const mon = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-CA", { timeZone: "UTC", month: "short", day: "numeric" });
/** "Nov 19, 2026" */
const monYear = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // m: 1..12
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
const readers = (list: Captured[], purpose: string) => list.filter((c) => c.kind === "anthropic" && c.purpose === purpose);

/** GSM 03.38 septets (extension characters count double; anything else → not GSM → Infinity). */
function septets(text: string): number {
  const basic = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
  const ext = "^{}\\[~]|€\f";
  let n = 0;
  for (const ch of text) {
    if (basic.includes(ch)) n += 1;
    else if (ext.includes(ch)) n += 2;
    else return Number.POSITIVE_INFINITY;
  }
  return n;
}

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
  resetTaxClerkCompanyCache();
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
interface Doc {
  spec: Record<string, unknown>;
  contentType: "image/jpeg" | "application/pdf";
}
/** What the fake Twilio serves (and the fake readers read): `E2EDOC{spec}E2EDOC` in a JPEG / PDF. */
function docBytes(spec: Record<string, unknown>, contentType: string): Buffer {
  const marker = `E2EDOC${JSON.stringify(spec)}E2EDOC`;
  if (contentType === "application/pdf") return Buffer.from(`%PDF-1.4\n% ${marker}\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n`, "latin1");
  const t = Buffer.from(marker, "latin1");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(t.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xfe]), len, t, Buffer.from([0xff, 0xd9])]);
}
/** A text (optionally MMS) arriving at a Twilio number, then the worker drains the queue. */
async function text(from: string, to: string, body: string, docs: Doc[] = []): Promise<void> {
  const messageSid = newSid(docs.length ? "MM" : "SM");
  const params: Record<string, string> = { AccountSid: env("TWILIO_ACCOUNT_SID"), MessageSid: messageSid, From: from, To: to, Body: body, NumMedia: String(docs.length) };
  for (let i = 0; i < docs.length; i++) {
    const id = newSid("ME");
    await fetch(`${FAKES}/__media`, { method: "POST", body: JSON.stringify({ id, contentType: docs[i].contentType, spec: docs[i].spec }) });
    params[`MediaUrl${i}`] = `https://api.twilio.com/2010-04-01/Accounts/${env("TWILIO_ACCOUNT_SID")}/Messages/${messageSid}/Media/${id}`;
    params[`MediaContentType${i}`] = docs[i].contentType;
  }
  const res = await postTwilio("/api/twilio/sms/inbound", params);
  if (res.status !== 200) console.log(`   inbound SMS webhook → ${res.status} ${res.text}`);
  await drain();
}

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
    checkout: { sessions: { create: async () => ({ id: `cs_test_p4_${Date.now().toString(36)}${++n}`, url: "https://checkout.stripe.test/c/pay/x" }) } },
    coupons: { retrieve: async () => ({ valid: false }) },
  } as unknown as Stripe;
}
async function buy(buyer: Buyer): Promise<void> {
  const checkout = await createCrankleadsCheckout(admin, { tier: buyer.tier, name: buyer.name, email: buyer.email, phone: buyer.phone, businessName: buyer.businessName, businessType: buyer.businessType }, fakeStripe());
  buyer.purchaseId = checkout.purchaseId;
  const suffix = checkout.purchaseId.slice(0, 8);
  const event = {
    id: `evt_p4_${suffix}`,
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
        customer: `cus_p4_${suffix}`,
        subscription: `sub_p4_${suffix}`,
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

/** The Connect webhook Stripe sends when a Checkout on the company's account is paid. */
async function payCheckout(sessionUrl: string, account: string): Promise<number> {
  const sessions = (await (await fetch(`${FAKES}/__stripe/sessions`)).json()) as Array<Record<string, unknown>>;
  const session = sessions.find((s) => s.url === sessionUrl);
  if (!session) throw new Error(`no fake Stripe session for ${sessionUrl}`);
  const event = {
    id: `evt_p4_conn_${String(session.id).slice(-10)}`,
    object: "event",
    type: "checkout.session.completed",
    api_version: "2026-07-29.dahlia",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    account,
    data: { object: { ...session, account: undefined, status: "complete", payment_status: "paid", payment_intent: `pi_e2e_${String(session.id).slice(-12)}` } },
  };
  const payload = JSON.stringify(event);
  const header = new Stripe(env("STRIPE_SECRET_KEY")).webhooks.generateTestHeaderString({ payload, secret: env("STRIPE_CONNECT_WEBHOOK_SECRET") });
  const res = await fetch(`${HOUSE_APP}/api/webhooks/stripe/connect`, { method: "POST", headers: { "stripe-signature": header, "content-type": "application/json" }, body: payload });
  return res.status;
}

// ════════════════════════════════════════════════════════════════════════════
const dana: Buyer = { name: "Dana Whitfield", email: "dana@northshoresnow.ca", phone: "+17055550143", businessName: "Northshore Snow & Lawn", businessType: "Property maintenance & snow", tier: "close" };
const STRIPE_ACCOUNT = "acct_e2eNorthshore01";
const ACCOUNTANT = "books@northshore-acct.test";
const SUPPLIER_EMAIL = "orders@hdpro.test";
const JONES = { first: "Chris", last: "Jones", phone: "+17055550210" };
const ERIN = { first: "Erin", last: "Walsh", phone: "+17055550221", email: "erin@example.test", address: "14 Pine St, Midland, ON" };
const PAT = { first: "Pat", last: "Moore", phone: "+17055550222", email: "pat@example.test", address: "88 Elm St, Midland, ON" };
const LEE = { first: "Lee", last: "Park", phone: "+17055550230" };
const KIM = { first: "Kim", last: "Ross", phone: "+17055550231" };
const SMITH = { first: "Sam", last: "Smith", phone: "+17055550240" };
const NG = { first: "Alex", last: "Ng", phone: "+17055550241" };
const MIKE = { name: "Mike Ruiz", business: "Mike's Electric", phone: "+17055550295", email: "mike@mikeselectric.test" };
const HOUSE = { owner: "+17055550111", catcher: "+17055550161", customer: "+17055550190" };
const PLAN = { name: "Winter Property Checks", priceCents: 42000, months: [11, 12, 1], weekday: 2, week: 1, timeOfDay: "09:00", durationMinutes: 90, included: ["Check roof and eavestroughs", "Clear storm drains"] };

const ids: Record<string, string> = {};
let houseIds: { orgId: string; companyId: string } | null = null;
let danaToken = "";
let ownerProfile = "";
let slug = "";
let M0 = "";
const D = (n: number) => addDays(M0, n);
let hst = { start: "", end: "", due: "", label: "" };
const houseBaseline: { series?: Record<string, unknown>; visits?: Array<{ id: string; scheduled_for: string; status: string }>; invoices?: number } = {};

const scope = () => ({ orgId: dana.orgId!, companyId: dana.companyId! });
const coBase = () => `/api/organizations/${dana.orgId}/companies/${dana.companyId}`;
async function latestApproval(companyId: string, kind: string): Promise<{ id: string; short_code: number; status: string; summary: string; payload: Record<string, unknown>; result: Record<string, unknown> | null } | null> {
  const { data } = await db.from("owner_approvals").select("*").eq("company_id", companyId).eq("kind", kind).order("created_at", { ascending: false }).limit(1);
  return (data ?? [])[0] ?? null;
}
async function contact(sc: { orgId: string; companyId: string }, p: { first: string; last: string; phone: string; email?: string }, extra: Record<string, unknown> = {}): Promise<string> {
  const createdAt = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const row = must(await db.from("contacts").insert({ organization_id: sc.orgId, company_id: sc.companyId, first_name: p.first, last_name: p.last, phone: p.phone, email: p.email ?? null, created_at: createdAt, updated_at: createdAt, ...extra }).select("id").single(), `contact ${p.first}`) as { id: string };
  return row.id;
}
async function booking(sc: { orgId: string; companyId: string }, input: { contactId: string | null; title: string; at: number; minutes: number; location?: string; status?: string; quoteId?: string }): Promise<string> {
  const row = must(
    await db
      .from("bookings")
      .insert({ organization_id: sc.orgId, company_id: sc.companyId, contact_id: input.contactId, title: input.title, scheduled_for: new Date(input.at).toISOString(), duration_minutes: input.minutes, status: input.status ?? "confirmed", location: input.location ?? null, quote_id: input.quoteId ?? null })
      .select("id")
      .single(),
    `booking ${input.title}`,
  ) as { id: string };
  return row.id;
}
async function q3Invoice(input: { number: string; subtotal: number; tax: number; issue: string; status: string; imported?: boolean; contactId: string }): Promise<string> {
  const total = input.subtotal + input.tax;
  const paid = input.status === "paid" ? total : 0;
  const row = must(
    await db
      .from("invoices")
      .insert({
        organization_id: dana.orgId!,
        company_id: dana.companyId!,
        contact_id: input.contactId,
        invoice_number: input.number,
        public_token: `inv_${input.number.toLowerCase().replace(/[^a-z0-9]/g, "")}_${Math.random().toString(36).slice(2, 10)}`,
        status: input.status,
        title: `Work ${input.number}`,
        line_items: [{ label: `Work ${input.number}`, quantity: 1, unit_cents: input.subtotal, amount_cents: input.subtotal }],
        subtotal_cents: input.subtotal,
        tax_cents: input.tax,
        total_cents: total,
        amount_paid_cents: paid,
        balance_due_cents: total - paid,
        issue_date: input.status === "draft" ? null : input.issue,
        due_date: input.status === "draft" ? null : addDays(input.issue, 14),
        sent_at: input.status === "draft" ? null : new Date(at(input.issue, "10:00")).toISOString(),
        paid_at: input.status === "paid" ? new Date(at(addDays(input.issue, 5), "10:00")).toISOString() : null,
        imported_at: input.imported ? new Date(at(input.issue, "11:00")).toISOString() : null,
        reminders_paused: true,
        bill_to: { name: "Customer", email: null },
      })
      .select("id")
      .single(),
    `invoice ${input.number}`,
  ) as { id: string };
  return row.id;
}

/** The quarter whose payment date is the first one ≥ `from` + 9 days (quarterly, Dec 31 year end). */
function hstFor(m0: string): { start: string; end: string; due: string; label: string } {
  const [y, m] = m0.split("-").map(Number);
  for (let k = -1; k < 6; k++) {
    // Quarter ending in month qe (3, 6, 9, 12), due at the end of the next month.
    const qeIndex = Math.floor((m - 1) / 3) * 3 + 3 * k; // months since Jan of y (0-based end-1)
    const endY = y + Math.floor((qeIndex - 1) / 12);
    const endM = ((((qeIndex - 1) % 12) + 12) % 12) + 1;
    if (endM % 3 !== 0) continue;
    const end = lastDayOfMonth(endY, endM);
    const dueY = endM === 12 ? endY + 1 : endY;
    const dueM = endM === 12 ? 1 : endM + 1;
    const due = lastDayOfMonth(dueY, dueM);
    const startM = endM - 2;
    const start = `${endY}-${String(startM).padStart(2, "0")}-01`;
    if (due >= m0) return { start, end, due, label: `Q${endM / 3}` };
  }
  throw new Error("no HST period");
}

async function seedHouse(): Promise<void> {
  const org = must(await db.from("organizations").insert({ name: "A1 Group (house)", slug: "a1-group-house-p4", subscription_status: "active" }).select("id").single(), "house org") as { id: string };
  const company = must(
    await db
      .from("companies")
      .insert({
        organization_id: org.id,
        name: "A1 Marine Care",
        slug: "a1-marine-care-p4",
        timezone: TZ,
        owner_phone_e164: HOUSE.owner,
        owner_phone_verified_at: new Date().toISOString(),
        owner_email: "owner@a1.test",
        tax_registration_number: "987654321RT0001",
        // Job done → a draft invoice (the auto-invoicing the plan's prepaid check must not change).
        invoice_settings: { autoInvoiceOnComplete: "draft" },
      })
      .select("id")
      .single(),
    "house company",
  ) as { id: string };
  must(await db.from("voice_numbers").insert({ organization_id: org.id, company_id: company.id, provider: "twilio", mode: "missed_call_catcher", phone_e164: HOUSE.catcher, active: true }).select("id").single(), "house number");
  houseIds = { orgId: org.id, companyId: company.id };
  const jill = await contact(houseIds, { first: "Jill", last: "Dock", phone: HOUSE.customer });
  ids.houseContact = jill;
  // A1's existing recurring series: weekly on Tuesdays at 09:00, $120 a visit, started two weeks ago.
  const ctx = { organizationId: org.id, actorProfileId: null, supabase: admin } as never;
  const created = await createRecurringJob(ctx, { companyId: company.id, contactId: jill, title: "Weekly dock check", location: "1 Harbour Rd, Midland", durationMinutes: 60, frequency: "weekly", interval: 1, weekdays: [2], startDate: addDays(M0, -13), timeOfDay: "09:00", lineItems: [{ label: "Dock check", quantity: 1, unitPriceCents: 12000 }] }, new Date());
  ids.houseSeries = created.series.id;
  const { data: series } = await db.from("recurring_jobs").select("*").eq("id", ids.houseSeries).single();
  houseBaseline.series = series;
  const { data: visits } = await db.from("bookings").select("id, scheduled_for, status").eq("recurring_job_id", ids.houseSeries).order("scheduled_for");
  houseBaseline.visits = visits ?? [];
  const { data: inv } = await db.from("invoices").select("id").eq("company_id", company.id);
  houseBaseline.invoices = (inv ?? []).length;
}

async function main(): Promise<void> {
  // ── M0: a Monday such that M0+9 … M0+11 sit in the HST reminder window ──
  {
    const today = localDate(Date.now());
    let candidate = addDays(today, (8 - weekday(today)) % 7);
    for (let i = 0; i < 20; i++, candidate = addDays(candidate, 7)) {
      const h = hstFor(candidate);
      if (addDays(candidate, 9) >= addDays(h.due, -10) && addDays(candidate, 11) <= h.due) {
        M0 = candidate;
        hst = h;
        break;
      }
    }
    if (!M0) throw new Error("no Monday lines up with an HST window");
    await clockTo(at(M0, "09:20"));
    console.log(`clock now ${new Date().toISOString()} (${torontoTime(Date.now())} Toronto); M0 = ${M0}; HST ${hst.label} ${hst.start}..${hst.end} due ${hst.due}`);
  }

  await step("0. seed: a live done-for-you Close company (purchase → switch-on → live, site published, Stripe Connect ready, HST registrant with an accountant), Q3 invoices + expenses, a sub with a WSIB clearance, a supplier + a recipe; a house tenant (A1) with a recurring series and job-done invoicing", async () => {
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
          tax_registration_number: "123456789RT0001",
          stripe_connected_account_id: STRIPE_ACCOUNT,
          stripe_charges_enabled: true,
          stripe_payouts_enabled: true,
          stripe_details_submitted: true,
          stripe_mode: "test",
        })
        .eq("id", dana.companyId!)
        .select("id"),
      "company facts",
    );
    must(
      await db
        .from("service_catalog_items")
        .upsert(
          [
            { organization_id: dana.orgId!, company_id: dana.companyId!, service_key: "seasonal_double_driveway", label: "Seasonal snow contract — double driveway", pricing_type: "flat", rate_cents: 65000, minimum_cents: 0, active: true, sort_order: 1 },
            { organization_id: dana.orgId!, company_id: dana.companyId!, service_key: "roof_replacement", label: "Roof replacement (per square)", pricing_type: "per_measure", rate_cents: 45000, minimum_cents: 0, active: true, sort_order: 2 },
          ],
          { onConflict: "company_id,service_key" },
        )
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
    const { data: owner } = await db.from("organization_memberships").select("profile_id").eq("organization_id", dana.orgId!).eq("role", "owner").limit(1);
    ownerProfile = owner?.[0]?.profile_id;
    danaToken = await signInToken(dana.email);

    // Receipts & HST: a registrant (HST # set) with an accountant — through the real settings route.
    const tax = await api(danaToken, "PATCH", `${coBase()}/ai-settings/tax-clerk`, { hst: { registrant: true, accountantEmail: ACCOUNTANT } });
    check(tax.status === 200, `PATCH ai-settings/tax-clerk (registrant, accountant ${ACCOUNTANT}) → ${tax.status} ${tax.status !== 200 ? tax.text.slice(0, 200) : ""}`);

    // The quarter being filed: two invoices that count, a draft and an IMPORTED one that don't;
    // expenses incl. a meal (50%).
    ids.jones = await contact(scope(), JONES);
    const q = (n: number) => addDays(hst.start, n);
    await q3Invoice({ number: "INV-Q-1", subtotal: 400000, tax: 52000, issue: q(40), status: "sent", contactId: ids.jones });
    await q3Invoice({ number: "INV-Q-2", subtotal: 150000, tax: 19500, issue: q(65), status: "paid", contactId: ids.jones });
    await q3Invoice({ number: "INV-Q-3", subtotal: 90000, tax: 11700, issue: q(70), status: "draft", contactId: ids.jones });
    await q3Invoice({ number: "OLD-77", subtotal: 300000, tax: 39000, issue: q(20), status: "sent", imported: true, contactId: ids.jones });
    must(
      await db
        .from("expenses")
        .insert([
          { organization_id: dana.orgId!, company_id: dana.companyId!, spent_on: q(41), vendor: "Home Depot", description: "Lumber", category: "materials", amount_cents: 113000, tax_cents: 13000, paid_with: "business", created_by: ownerProfile },
          { organization_id: dana.orgId!, company_id: dana.companyId!, spent_on: q(42), vendor: "Tim Hortons", description: "Crew lunch", category: "meals", amount_cents: 5650, tax_cents: 650, paid_with: "business", created_by: ownerProfile },
          { organization_id: dana.orgId!, company_id: dana.companyId!, spent_on: q(43), vendor: "Esso", description: "Fuel", category: "fuel", amount_cents: 11300, tax_cents: 1300, paid_with: "business", created_by: ownerProfile },
        ])
        .select("id"),
      "Q expenses",
    );

    // Jones's recent job (for "Jones job"), and the plan / share / purchasing customers.
    ids.jonesJob = await booking(scope(), { contactId: ids.jones, title: "Fence repair", at: at(D(-2), "10:00"), minutes: 120, location: "5 Lake St, Midland", status: "completed" });
    ids.lee = await contact(scope(), LEE);
    ids.kim = await contact(scope(), KIM);
    ids.smith = await contact(scope(), SMITH);
    ids.ng = await contact(scope(), NG);

    // Compliance: a sub (Settings → save_sub) and their WSIB clearance uploaded in Settings, expiring M0+16.
    const sub = await api(danaToken, "POST", `${coBase()}/ai-settings/compliance`, { action: "save_sub", name: MIKE.name, businessName: MIKE.business, trade: "Electrical", phone: MIKE.phone, email: MIKE.email });
    check(sub.status === 200, `save_sub → ${sub.status} ${sub.status !== 200 ? sub.text.slice(0, 200) : ""}`);
    const { data: subRow } = await db.from("subcontractors").select("id").eq("company_id", dana.companyId!).single();
    ids.sub = subRow?.id;
    const up = await api(danaToken, "POST", `${coBase()}/ai-settings/compliance`, { action: "upload_url", contentType: "application/pdf" });
    const u = dataOf(up);
    const clearance = { type: "cert", label: "mike-wsib-old", kind: "wsib_clearance", title: "WSIB clearance", issuer: "WSIB", number: "CLR-0012346789", holder: MIKE.business, issued: D(-74), expires: D(16) };
    check(up.status === 200 && (await uploadSigned(u.bucket, u.path, u.token, docBytes(clearance, "application/pdf"), "application/pdf")) === 200, `Settings upload URL + PUT (${up.status})`);
    const filed = await api(danaToken, "POST", `${coBase()}/ai-settings/compliance`, { action: "file_upload", path: u.path, contentType: "application/pdf", holder: { type: "subcontractor", subcontractorId: ids.sub } });
    check(filed.status === 200, `file_upload → ${filed.status} ${short(dataOf(filed)?.message ?? filed.text, 200)}`);
    const { data: subDoc } = await db.from("compliance_documents").select("*").eq("company_id", dana.companyId!).eq("subcontractor_id", ids.sub).single();
    ids.subDoc = subDoc?.id;
    check(subDoc?.kind === "wsib_clearance" && subDoc?.expires_on === D(16) && subDoc?.uploaded_via === "settings", `the sub's WSIB clearance on file, expires ${subDoc?.expires_on} (${subDoc?.status})`);

    // Purchasing: the supplier and a recipe for the roof (per square) — through the settings route.
    const sup = await api(danaToken, "POST", `${coBase()}/ai-settings/purchasing`, { action: "save_supplier", supplier: { name: "Home Depot Pro", branch: "Barrie", email: SUPPLIER_EMAIL, phone: "705-555-1234", accountNumber: "12345", preferred: true } });
    check(sup.status === 200, `save_supplier → ${sup.status} ${sup.status !== 200 ? sup.text.slice(0, 200) : ""}`);
    const { data: roof } = await db.from("service_catalog_items").select("id").eq("company_id", dana.companyId!).eq("service_key", "roof_replacement").single();
    ids.roofItem = roof?.id;
    const rec = await api(danaToken, "POST", `${coBase()}/ai-settings/purchasing`, {
      action: "save_recipe",
      catalogItemId: ids.roofItem,
      lines: [
        { label: "shingles", qtyPerUnit: 3, unit: "bundles", estUnitCostCents: 3800 },
        { label: "underlay", qtyPerUnit: 0.4, unit: "rolls", estUnitCostCents: 9500 },
        { label: "nails", qtyPerUnit: 0.1, unit: "box", estUnitCostCents: 4900 },
      ],
    });
    check(rec.status === 200, `save_recipe → ${rec.status} ${rec.status !== 200 ? rec.text.slice(0, 200) : ""}`);
    // One worker tick on M0 morning (claims the empty Monday renewal run before any agreement exists).
    await tick();
    setMark();
  });

  await step("R1. receipts by text: a receipt photo + \"Jones job\" → an expense on Jones's booking, the picture in expense-receipts, ONE reply from the platform number", async () => {
    await clockTo(at(M0, "10:00"));
    const receipt: Doc = { contentType: "image/jpeg", spec: { type: "receipt", label: "hd-jones", vendor: "Home Depot", date: D(-2), totalCents: 8420, taxCents: 969, category: "materials", description: "Lumber and screws" } };
    await text(dana.phone, PLATFORM, "Jones job", [receipt]);
    const got = sinceMark();
    const reply = smsTo(got, dana.phone);
    console.log(`   owner: ${short(reply[0]?.body)}`);
    check(readers(got, "receipt_reader").length === 1 && readers(got, "receipt_reader")[0].withKind === true, "read once by the receipt reader (asked what kind of picture it is)");
    check(got.some((c) => c.kind === "twilio_media" && c.basicAuth === true), "the MMS media fetched from Twilio with Basic auth");
    check(reply.length === 1 && reply[0].from === PLATFORM && new RegExp(`^(CrankLeads: )?Got it: Home Depot \\$84\\.20 \\(HST \\$9\\.69\\), Materials, [^,]*Jones[^,]*\\(${esc(mon(D(-2)))}\\)\\. Reply "fix" to change it\\.$`).test(String(reply[0].body)), "the reply: vendor, total, HST, category, the Jones job (date)");
    const { data: ex } = await db.from("expenses").select("*").eq("company_id", dana.companyId!).eq("vendor", "Home Depot").eq("spent_on", D(-2));
    const e = ex?.[0];
    ids.jonesExpense = e?.id;
    check((ex ?? []).length === 1 && e.booking_id === ids.jonesJob && e.amount_cents === 8420 && e.tax_cents === 969 && e.category === "materials" && e.paid_with === "business" && e.created_by === ownerProfile, `expense on the Jones booking (${JSON.stringify({ booking: e?.booking_id === ids.jonesJob, amount: e?.amount_cents, tax: e?.tax_cents, by: e?.created_by === ownerProfile })})`);
    check(e?.receipt_type === "image/jpeg" && e?.receipt_path && existsSync(join(STORAGE, "expense-receipts", String(e.receipt_path))), `receipt stored in expense-receipts (${e?.receipt_path})`);
    const { data: rt } = await db.from("receipt_texts").select("status, expense_id, booking_id").eq("company_id", dana.companyId!);
    check((rt ?? []).length === 1 && rt![0].status === "filed" && rt![0].expense_id === e?.id, `receipt_texts: ${JSON.stringify(rt)}`);
    setMark();
  });

  await step("R2. the same receipt again → \"Already have that one\", not added", async () => {
    const receipt: Doc = { contentType: "image/jpeg", spec: { type: "receipt", label: "hd-jones-again", vendor: "Home Depot", date: D(-2), totalCents: 8420, taxCents: 969, category: "materials", description: "Lumber and screws" } };
    await text(dana.phone, PLATFORM, "", [receipt]);
    const reply = smsTo(sinceMark(), dana.phone);
    console.log(`   owner: ${short(reply[0]?.body)}`);
    check(reply.length === 1 && new RegExp(`Already have that one: Home Depot \\$84\\.20 on ${esc(mon(D(-2)))} - not added again\\.`).test(String(reply[0].body)), "duplicate reply");
    const { data: ex } = await db.from("expenses").select("id").eq("company_id", dana.companyId!).eq("vendor", "Home Depot").eq("spent_on", D(-2));
    check((ex ?? []).length === 1, `still one expense (${(ex ?? []).length})`);
    const { data: rt } = await db.from("receipt_texts").select("status, duplicate_of").eq("company_id", dana.companyId!).eq("status", "duplicate");
    check((rt ?? []).length === 1 && rt![0].duplicate_of === ids.jonesExpense, "receipt_texts row duplicate → the first expense");
    setMark();
  });

  await step("R3/C1. a photo with \"insurance certificate\" → the tax clerk reads it, its reader says not a receipt, it passes; Compliance files it with its expiry and replies", async () => {
    const coi: Doc = { contentType: "image/jpeg", spec: { type: "cert", label: "coi", kind: "liability_insurance", title: "Commercial general liability", issuer: "Intact", number: "POL-7782214821", holder: "Northshore Snow & Lawn", issued: D(-327), expires: D(38) } };
    const before = (await db.from("receipt_texts").select("id").eq("company_id", dana.companyId!)).data?.length ?? 0;
    await text(dana.phone, PLATFORM, "insurance certificate", [coi]);
    const got = sinceMark();
    const reply = smsTo(got, dana.phone);
    console.log(`   owner: ${short(reply[0]?.body)}`);
    check(readers(got, "receipt_reader").length === 1 && readers(got, "receipt_reader")[0].documentKind === "not_receipt", "the receipt reader said not_receipt (it reads even with certificate words)");
    check(readers(got, "compliance_reader").length === 1, "read once by the compliance reader");
    check(reply.length === 1 && reply[0].from === PLATFORM && new RegExp(`^(CrankLeads: )?Saved: liability insurance \\(Intact, policy \\.\\.\\.4821\\), expires ${esc(monYear(D(38)))}\\. I'll remind you 30 days before\\.$`).test(String(reply[0].body)), "the saved line (masked policy number, expiry, 30-day promise)");
    check(!String(reply[0]?.body).includes("7782214821"), "never the whole policy number");
    const after = (await db.from("receipt_texts").select("id").eq("company_id", dana.companyId!)).data?.length ?? 0;
    const { data: nr } = await db.from("receipt_texts").select("status").eq("company_id", dana.companyId!).eq("status", "not_receipt");
    check(after === before + 1 && (nr ?? []).length === 1, "one receipt_texts row, not_receipt");
    const { data: ex } = await db.from("expenses").select("id").eq("company_id", dana.companyId!).gte("spent_on", D(-5));
    check((ex ?? []).length === 1, "no expense filed for the certificate");
    const { data: doc } = await db.from("compliance_documents").select("*").eq("company_id", dana.companyId!).eq("kind", "liability_insurance");
    const d = doc?.[0];
    ids.coi = d?.id;
    check((doc ?? []).length === 1 && d.holder_type === "company" && d.expires_on === D(38) && d.issuer === "Intact" && d.uploaded_via === "sms" && d.status === "current", `compliance_documents: ${JSON.stringify({ holder: d?.holder_type, expires: d?.expires_on, status: d?.status })}`);
    check(d?.file_path && existsSync(join(STORAGE, "compliance-docs", String(d.file_path))), `file in compliance-docs (${d?.file_path})`);
    setMark();
  });

  await step("R4. a bare photo that isn't a receipt (or a certificate) → the old \"Got the picture\" reply", async () => {
    const photo: Doc = { contentType: "image/jpeg", spec: { type: "photo", label: "job-photo" } };
    const docsBefore = (await db.from("compliance_documents").select("id").eq("company_id", dana.companyId!)).data?.length ?? 0;
    await text(dana.phone, PLATFORM, "", [photo]);
    const got = sinceMark();
    const reply = smsTo(got, dana.phone);
    console.log(`   owner: ${short(reply[0]?.body)}`);
    check(reply.length === 1 && /^(CrankLeads: )?Got the picture — I can't do anything with photos here yet\. Text me what you need\.$/.test(String(reply[0].body)), "\"Got the picture\" reply");
    check(readers(got, "receipt_reader").length === 1 && readers(got, "receipt_reader")[0].documentKind === "not_receipt", "the receipt reader said not_receipt");
    const { data: rt } = await db.from("receipt_texts").select("status").eq("company_id", dana.companyId!).eq("status", "not_receipt");
    check((rt ?? []).length === 2, "receipt_texts: not_receipt (the certificate's and this one)");
    const docsAfter = (await db.from("compliance_documents").select("id").eq("company_id", dana.companyId!)).data?.length ?? 0;
    check(docsAfter === docsBefore, "no compliance document");
    setMark();
  });

  await step("P1. service plans: the owner creates a plan in Settings; the public /s/<slug>/plans page lists it", async () => {
    await clockTo(at(M0, "10:30"));
    const created = await api(danaToken, "POST", `${coBase()}/ai-settings/service-plans`, { action: "create_plan", plan: { name: PLAN.name, description: "Two winter check-ups and a January visit.", priceCents: PLAN.priceCents, billing: "annual", months: PLAN.months, weekday: PLAN.weekday, week: PLAN.week, timeOfDay: PLAN.timeOfDay, durationMinutes: PLAN.durationMinutes, included: PLAN.included } });
    check(created.status === 200, `create_plan → ${created.status} ${created.status !== 200 ? created.text.slice(0, 300) : short(created.json?.message)}`);
    const { data: plan } = await db.from("service_plans").select("*").eq("company_id", dana.companyId!).single();
    ids.plan = plan?.id;
    check(plan?.active && plan?.price_cents === PLAN.priceCents && JSON.stringify(plan?.visit_months) === JSON.stringify([...PLAN.months].sort((a, b) => a - b)) || JSON.stringify(plan?.visit_months) === JSON.stringify(PLAN.months), `service_plans row (${plan?.name}, months ${JSON.stringify(plan?.visit_months)})`);
    const list = await fetch(`${HOUSE_APP}/s/${slug}/plans`);
    const html = await list.text();
    check(list.status === 200 && html.includes(PLAN.name) && /\$420\/yr \+ HST/.test(html), `GET /s/${slug}/plans → ${list.status}, lists the plan with "$420/yr + HST"`);
    const page = await fetch(`${HOUSE_APP}/s/${slug}/plans/${ids.plan}`);
    const ph = await page.text();
    check(page.status === 200 && /Continue to payment \(\$420 \+ HST\)/.test(ph) && /Consent is not a condition of purchase/.test(ph), `plan page ${page.status}: pay online button + consent text`);
  });

  async function signUp(person: { first: string; last: string; phone: string; email: string; address: string }): Promise<{ status: number; location: string | null; html: string }> {
    const page = await (await fetch(`${HOUSE_APP}/s/${slug}/plans/${ids.plan}`)).text();
    const t = page.match(/name="t" value="(\d+)"/)?.[1] ?? String(Date.now() - 10_000);
    await sleep(3200);
    const form = new URLSearchParams({ name: `${person.first} ${person.last}`, phone: person.phone, email: person.email, address: person.address, smsConsent: "1", website: "", t });
    const res = await fetch(`${HOUSE_APP}/s/${slug}/plans/${ids.plan}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
    return { status: res.status, location: res.headers.get("location"), html: res.status === 303 ? "" : await res.text() };
  }

  await step("P2. public sign-up → 303 to Stripe Checkout on the company's connected account (first year's invoice, reminders paused) → the signed Connect webhook activates the agreement, creates ONE series with visits on the plan months; customer + owner texted", async () => {
    setMark();
    const r = await signUp(ERIN);
    check(r.status === 303 && /^https:\/\/checkout\.stripe\.test\/c\/pay\/cs_test_/.test(String(r.location)), `sign-up POST → ${r.status} ${r.location ?? short(r.html, 200)}`);
    let got = sinceMark();
    const sess = got.find((c) => c.kind === "stripe" && c.op === "checkout.create");
    check(sess?.account === STRIPE_ACCOUNT && sess?.amount === 47460, `Checkout on ${sess?.account} for ${sess?.amount} (= $420 + 13% HST)`);
    const { data: ag0 } = await db.from("service_agreements").select("*").eq("company_id", dana.companyId!).eq("customer_phone", ERIN.phone);
    const a0 = ag0?.[0];
    check(a0?.status === "pending_payment" && a0?.pending_invoice_id, `agreement pending_payment with invoice (${a0?.status})`);
    const { data: inv0 } = await db.from("invoices").select("status, reminders_paused, total_cents").eq("id", a0?.pending_invoice_id).single();
    check(inv0?.reminders_paused === true && inv0?.total_cents === 47460, `first-year invoice $474.60, reminders paused (${inv0?.status})`);
    setMark();
    const hook = await payCheckout(String(r.location), STRIPE_ACCOUNT);
    check(hook === 200, `Connect webhook checkout.session.completed → ${hook}`);
    await drain();
    got = sinceMark();
    const { data: ag } = await db.from("service_agreements").select("*").eq("id", a0?.id).single();
    ids.erinAgreement = ag?.id;
    check(ag?.status === "active" && ag?.recurring_job_id && ag?.term_start === M0, `agreement active from ${ag?.term_start} to ${ag?.term_end}, series ${ag?.recurring_job_id ? "yes" : "no"}`);
    const { data: series } = await db.from("recurring_jobs").select("*").eq("id", ag?.recurring_job_id).single();
    const dates = (series?.visit_dates ?? []) as string[];
    console.log(`   series visit_dates: ${JSON.stringify(dates)}`);
    const firstTue = (y: number, m: number) => {
      for (let d = 1; d <= 7; d++) {
        const ds = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        if (weekday(ds) === 2) return ds;
      }
      return "";
    };
    const expected: string[] = [];
    {
      let [y, m] = M0.split("-").map(Number);
      for (let i = 0; i < 12; i++) {
        m += 1;
        if (m > 12) {
          m = 1;
          y += 1;
        }
        if (PLAN.months.includes(m)) {
          const ds = firstTue(y, m);
          if (ds >= addDays(M0, 3) && ds <= String(ag?.term_end)) expected.push(ds);
        }
      }
      expected.sort();
    }
    ids.firstVisit = expected[0];
    check(JSON.stringify([...dates].sort()) === JSON.stringify(expected) && dates.every((d) => weekday(d) === 2 && PLAN.months.includes(Number(d.slice(5, 7)))), `visit_dates on the first Tuesday of each plan month: ${JSON.stringify(expected)}`);
    const { data: visits } = await db.from("bookings").select("id, scheduled_for, status").eq("recurring_job_id", ag?.recurring_job_id).order("scheduled_for");
    check((visits ?? []).length >= 1 && localDate(Date.parse(visits![0].scheduled_for)) === expected[0] && torontoTime(Date.parse(visits![0].scheduled_for)).endsWith("09:00"), `first visit booked ${visits?.[0] ? torontoTime(Date.parse(visits[0].scheduled_for)) : "-"} (${(visits ?? []).length} booked)`);
    const toErin = smsTo(got, ERIN.phone);
    console.log(`   Erin: ${short(toErin[0]?.body)}`);
    check(toErin.length === 1 && toErin[0].from === dana.catcher && /^Hi Erin, you're signed up for Winter Property Checks with Northshore Snow & Lawn\. Your .+ is booked for Tue .+ - we'll text you before each one\. Questions\? Just reply\./.test(String(toErin[0].body)), "customer confirmation from the business number");
    // (The company's existing "invoice paid" automation also texts the owner from the business number.)
    const toOwner = smsTo(got, dana.phone).filter((m) => /New plan:/.test(String(m.body)));
    console.log(`   owner: ${short(toOwner[0]?.body)}`);
    check(toOwner.length === 1 && toOwner[0].from === PLATFORM && /New plan: Erin Walsh signed up for Winter Property Checks and paid \$474\.60 online\. First visit Tue .+ is on the calendar\./.test(String(toOwner[0].body)), "owner told (paid online, first visit)");
    const { data: inv } = await db.from("invoices").select("status, balance_due_cents").eq("id", a0?.pending_invoice_id).single();
    check(inv?.status === "paid" && inv?.balance_due_cents === 0, `invoice paid (${inv?.status})`);
    setMark();
  });

  await step("P3. a second customer (Pat) signs up and pays the same way; their first term is then set to end in 18 days (seeded: a plan that started ~11 months ago)", async () => {
    const r = await signUp(PAT);
    check(r.status === 303, `sign-up → ${r.status}`);
    check((await payCheckout(String(r.location), STRIPE_ACCOUNT)) === 200, "Connect webhook paid");
    await drain();
    const { data: ag } = await db.from("service_agreements").select("*").eq("company_id", dana.companyId!).eq("customer_phone", PAT.phone).single();
    ids.patAgreement = ag?.id;
    ids.patSeries = ag?.recurring_job_id;
    check(ag?.status === "active" && ag?.recurring_job_id, `Pat active (${ag?.status})`);
    const termEnd = D(18);
    const termStart = addDays(`${Number(termEnd.slice(0, 4)) - 1}${termEnd.slice(4)}`, 1);
    must(await db.from("service_agreements").update({ term_start: termStart, term_end: termEnd, activated_at: new Date(at(termStart, "10:00")).toISOString(), created_at: new Date(at(termStart, "09:00")).toISOString() }).eq("id", ag?.id).select("id"), "backdate Pat");
    console.log(`   Pat's term: ${termStart} … ${termEnd}`);
    setMark();
  });

  await step("C2. a customer texts the business asking for proof of insurance → share_compliance_doc approval (exact owner text) → Y → the customer gets the link from the business number → it redirects to the file (60 s signed URL)", async () => {
    await clockTo(at(M0, "11:30"));
    await text(LEE.phone, dana.catcher!, "Hi, can you send me proof of insurance before you start?");
    let got = sinceMark();
    const turns = got.filter((c) => c.kind === "anthropic" && c.purpose === "sms_agent");
    check(turns.some((t) => (t.tools as string[]).includes("share_compliance_doc")), "the SMS agent is offered share_compliance_doc");
    const appr = await latestApproval(dana.companyId!, "share_compliance_doc");
    ids.share1 = appr?.id ?? "";
    const ask = smsTo(got, dana.phone);
    console.log(`   owner: ${short(ask[0]?.body, 600)}`);
    check(appr?.status === "pending" && ask.length === 1 && new RegExp(`^(CrankLeads: )?#${appr?.short_code} Lee Park \\(705-555-0230\\) asked for your liability insurance certificate \\(Intact, expires ${esc(monYear(D(38)))}\\)\\. Y texts Lee a link to it \\(expires in 7 days\\): "Hi Lee, it's Northshore Snow & Lawn\\. Here's our liability insurance certificate \\(valid to ${esc(monYear(D(38)))}\\): \\[link\\] The link works for 7 days\\." Their text: ".*" Reply Y ${appr?.short_code} to send it, N ${appr?.short_code} to skip\\.$`).test(String(ask[0].body)), `share_compliance_doc #${appr?.short_code} asked with the exact text`);
    const toLee = smsTo(got, LEE.phone);
    check(toLee.length === 1 && /checking with Dana/.test(String(toLee[0].body)) && !/http/.test(String(toLee[0].body)), `Lee: "${short(toLee[0]?.body, 160)}" (no link yet)`);
    setMark();
    await text(dana.phone, PLATFORM, `Y ${appr?.short_code}`);
    got = sinceMark();
    const link = smsTo(got, LEE.phone);
    console.log(`   Lee: ${short(link[0]?.body)}`);
    check(link.length === 1 && link[0].from === dana.catcher && new RegExp(`^Hi Lee, it's Northshore Snow & Lawn\\. Here's our liability insurance certificate \\(valid to ${esc(monYear(D(38)))}\\): http://app\\.everdoer\\.localhost:\\d+/api/public/compliance/doc/[A-Za-z0-9_-]+ The link works for 7 days\\.`).test(String(link[0].body)), "the customer's link text from the business number");
    const own = smsTo(got, dana.phone);
    check(own.length === 1 && /Texted Lee Park the link to your liability insurance certificate \(works 7 days\)\. You can turn it off in Settings > AI front desk > Compliance\./.test(String(own[0].body)), `owner: "${short(own[0]?.body, 200)}"`);
    const url = String(link[0]?.body ?? "").match(/(http\S+\/compliance\/doc\/[A-Za-z0-9_-]+)/)?.[1] ?? "";
    ids.share1Url = url.replace(/^http:\/\/app\.everdoer\.localhost/, "http://127.0.0.1");
    const open = await fetch(ids.share1Url, { redirect: "manual" });
    const loc = open.headers.get("location") ?? "";
    check(open.status === 302 && /\/storage\/v1\/object\/sign\/compliance-docs\//.test(loc) && /no-store/.test(open.headers.get("cache-control") ?? ""), `link → ${open.status} to a signed URL (${short(loc, 120)})`);
    const file = await fetch(loc.startsWith("http") ? loc : `${SUPABASE}${loc}`);
    const bytes = Buffer.from(await file.arrayBuffer());
    check(file.status === 200 && bytes.toString("latin1").includes("POL-7782214821"), `the signed URL serves the certificate (${file.status}, ${bytes.length} bytes)`);
    const { data: share } = await db.from("compliance_shares").select("status, open_count").eq("approval_id", appr?.id).single();
    check(share?.status === "sent" && share?.open_count === 1, `compliance_shares sent, opened once (${JSON.stringify(share)})`);
    setMark();
  });

  await step("H1. house org (A1): the owner's bare photo → the old \"Got the picture\" reply; a photo with \"insurance certificate\" → the old path (owner agent), nothing read or stored", async () => {
    await text(HOUSE.owner, PLATFORM, "", [{ contentType: "image/jpeg", spec: { type: "receipt", label: "a1-receipt", vendor: "Marine Supply", date: D(-1), totalCents: 5000, taxCents: 575, category: "materials" } }]);
    let got = sinceMark();
    const reply = smsTo(got, HOUSE.owner);
    check(reply.length === 1 && /^Got the picture — I can't do anything with photos here yet\. Text me what you need\.$/.test(String(reply[0].body).replace(/^[^:]+: (?=Got)/, "")), `A1: "${short(reply[0]?.body, 120)}"`);
    check(readers(got, "receipt_reader").length === 0 && readers(got, "compliance_reader").length === 0 && !got.some((c) => c.kind === "twilio_media"), "nothing fetched or read");
    setMark();
    await text(HOUSE.owner, PLATFORM, "insurance certificate", [{ contentType: "image/jpeg", spec: { type: "cert", label: "a1-coi", kind: "liability_insurance", issuer: "Aviva", expires: D(50) } }]);
    got = sinceMark();
    check(readers(got, "receipt_reader").length === 0 && readers(got, "compliance_reader").length === 0, "no reader on A1's certificate photo");
    const turns = got.filter((c) => c.kind === "anthropic" && c.purpose === "owner_agent");
    const p4Tools = ["fix_receipt", "receipts_summary", "hst_summary", "send_hst_packet", "plans_summary", "enroll_customer", "compliance_status", "file_compliance_doc", "ask_sub_for_docs", "add_subcontractor", "stop_sharing", "materials_status", "mark_materials", "order_materials", "add_supplier", "set_recipe"];
    check(turns.length >= 1 && turns.every((t) => !(t.tools as string[]).some((n) => p4Tools.includes(n))), `A1's words go to the owner agent as before, with no Phase 4 tools (${turns.length} turn(s))`);
    for (const table of ["receipt_texts", "compliance_documents"]) {
      const { data } = await db.from(table).select("id").eq("company_id", houseIds!.companyId);
      check((data ?? []).length === 0, `${table}: none for A1`);
    }
    setMark();
  });

  // P5 runs when its window comes (the first plan visit's −10 days depends on today's date): before
  // whichever later step would move the clock past it, else in its usual place after M0+12.
  let p5Done = false;
  const runP5 = async (): Promise<void> => {
    if (p5Done) return;
    p5Done = true;
    await step("P5. ~10 days before the first plan visit (09:00–20:00): ONE heads-up per customer from the business number; not again", async () => {
      const visit = ids.firstVisit;
      await clockTo(at(addDays(visit, -10), "10:00"));
      await tick();
      const got = sinceMark();
      const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday(visit)];
      for (const p of [ERIN, PAT]) {
        const h = smsTo(got, p.phone);
        console.log(`   ${p.first}: ${short(h[0]?.body)}`);
        check(h.length === 1 && h[0].from === dana.catcher && new RegExp(`^Hi ${p.first}, it's Northshore Snow & Lawn\\. Your .+ is booked for ${wd} ${esc(mon(visit))}, morning\\. Reply to change\\.`).test(String(h[0].body)), `${p.first}'s heads-up`);
      }
      setMark();
      await clockTo(at(addDays(visit, -10), "14:00"));
      await tick();
      check(allSms(sinceMark()).filter((m) => m.to === ERIN.phone || m.to === PAT.phone).length === 0, "no second heads-up");
      setMark();
    });
  };
  const p5Before = async (date: string, hhmm: string): Promise<void> => {
    if (!p5Done && ids.firstVisit && at(addDays(ids.firstVisit, -10), "14:00") <= at(date, hhmm)) await runP5();
  };

  await p5Before(D(7), "10:00");
  await step("P4. Monday M0+7: the renewal batch → plan_renewals (Pat, ending in 18-11 days) → Y → Pat texted the renewal link; the renewal page works", async () => {
    await clockTo(at(D(7), "10:00"));
    await tick();
    let got = sinceMark();
    const appr = await latestApproval(dana.companyId!, "plan_renewals");
    const ask = smsTo(got, dana.phone).find((m) => /renew/.test(String(m.body)));
    console.log(`   owner: ${short(ask?.body, 500)}`);
    check(appr?.status === "pending" && new RegExp(`#${appr?.short_code} 1 plan renews in the next 30 days \\(\\$420\\): Pat Moore ${esc(mon(D(19)))} \\$420/yr\\. Y texts each customer their renewal link \\(pay now to keep their .+\\)\\. Reply Y ${appr?.short_code} to text them, N ${appr?.short_code} to skip\\.`).test(String(ask?.body)), `plan_renewals #${appr?.short_code} asked`);
    check(!new RegExp("Erin").test(String(ask?.body)), "Erin (a year to go) is not in it");
    setMark();
    await tick();
    check(!smsTo(sinceMark(), dana.phone).some((m) => /renews in the next 30 days/.test(String(m.body))), "asked once (a second tick asks nothing)");
    setMark();
    await text(dana.phone, PLATFORM, `Y ${appr?.short_code}`);
    got = sinceMark();
    const toPat = smsTo(got, PAT.phone);
    console.log(`   Pat: ${short(toPat[0]?.body)}`);
    check(toPat.length === 1 && toPat[0].from === dana.catcher && new RegExp(`^Hi Pat, it's Northshore Snow & Lawn\\. Your Winter Property Checks plan renews ${esc(mon(D(19)))} \\(\\$420 \\+ HST for the next year\\)\\. Pay here to keep your .+ visit: http://app\\.everdoer\\.localhost:\\d+/s/${esc(slug)}/plans/renew/[a-f0-9]{32}`).test(String(toPat[0].body)), "Pat's renewal text with the link");
    const own = smsTo(got, dana.phone);
    check(own.length === 1 && /Texted 1 customer their renewal link \(\$420\)\./.test(String(own[0].body)), `owner: "${short(own[0]?.body, 160)}"`);
    const { data: ag } = await db.from("service_agreements").select("status, renewal_texted_at, renewal_token").eq("id", ids.patAgreement).single();
    check(ag?.status === "renewal_due" && ag?.renewal_texted_at, `Pat's agreement ${ag?.status}, renewal texted`);
    const token = String(toPat[0]?.body ?? "").match(/renew\/([a-f0-9]{32})/)?.[1] ?? "";
    const page = await fetch(`${HOUSE_APP}/s/${slug}/plans/renew/${token}`);
    const html = await page.text();
    check(page.status === 200 && /Pay \$420 \+ HST and renew/.test(html), `renewal page ${page.status}`);
    const bad = await fetch(`${HOUSE_APP}/s/${slug}/plans/renew/${"0".repeat(32)}`);
    check(bad.status === 404, `unknown token → 404 (${bad.status})`);
    setMark();
  });

  await p5Before(D(8), "10:00");
  await step("C3. M0+8: the certificate's 30-day text (one); the first share link has expired (410); a second share → Y → link works → turned off in Settings → 410", async () => {
    await clockTo(at(D(8), "10:00"));
    await tick();
    let got = sinceMark();
    const heads = smsTo(got, dana.phone).filter((m) => /Heads up:/.test(String(m.body)));
    console.log(`   owner: ${short(heads[0]?.body)}`);
    check(heads.length === 1 && heads[0].from === PLATFORM && /Heads up: Liability insurance expires in 30 days\. Text me a photo of the new one when you have it\./.test(String(heads[0].body)), "the 30-day text");
    const { data: coi } = await db.from("compliance_documents").select("status, reminded_30_at, reminded_7_at").eq("id", ids.coi).single();
    check(coi?.reminded_30_at && !coi?.reminded_7_at && coi?.status === "expiring", `reminded_30_at set, status ${coi?.status}`);
    setMark();
    await tick();
    check(smsTo(sinceMark(), dana.phone).filter((m) => /Heads up:/.test(String(m.body))).length === 0, "not again on a second pass");
    const expired = await fetch(ids.share1Url, { redirect: "manual" });
    const eh = await expired.text();
    check(expired.status === 410 && /This link has expired or was turned off\. Ask Northshore Snow (&|&amp;) Lawn for a new one\./.test(eh), `the 7-day-old link → ${expired.status} (${short(eh.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "), 120)})`);
    setMark();
    await text(LEE.phone, dana.catcher!, "Sorry, the insurance certificate link expired - can you send me proof of insurance again?");
    const appr = await latestApproval(dana.companyId!, "share_compliance_doc");
    check(appr?.id !== ids.share1 && appr?.status === "pending", `a new share question #${appr?.short_code}`);
    await text(dana.phone, PLATFORM, `Y ${appr?.short_code}`);
    got = sinceMark();
    const link = smsTo(got, LEE.phone).find((m) => /compliance\/doc\//.test(String(m.body)));
    const url = (String(link?.body ?? "").match(/(http\S+\/compliance\/doc\/[A-Za-z0-9_-]+)/)?.[1] ?? "").replace(/^http:\/\/app\.everdoer\.localhost/, "http://127.0.0.1");
    const open = await fetch(url, { redirect: "manual" });
    check(open.status === 302, `the new link works (${open.status})`);
    const { data: share } = await db.from("compliance_shares").select("id").eq("approval_id", appr?.id).single();
    const off = await api(danaToken, "POST", `${coBase()}/ai-settings/compliance`, { action: "revoke_share", id: share?.id });
    check(off.status === 200 && /Link turned off/.test(String(dataOf(off)?.message)), `Settings revoke_share → ${off.status} ${short(dataOf(off)?.message, 60)}`);
    const gone = await fetch(url, { redirect: "manual" });
    check(gone.status === 410, `after Turn off → ${gone.status}`);
    const { data: s2 } = await db.from("compliance_shares").select("status, revoked_at").eq("id", share?.id).single();
    check(s2?.status === "revoked" && s2?.revoked_at, `share revoked (${s2?.status})`);
    setMark();
  });

  await p5Before(D(9), "09:05");
  await step("T1. M0+9 09:05: the HST reminder (10 days before the due date, correct figures: imported + draft invoices out, meals at 50%) → accountant_packet → \"Y n\" emails the packet (PDF + 2 CSVs) to the accountant", async () => {
    await clockTo(at(D(9), "09:05"));
    await tick();
    // The reminder goes out at the first pass inside its window (due − 10 days … due). Depending on
    // today's date that can be an earlier tick than this one (M0+7 / M0+8), so look at every text.
    const appr = await latestApproval(dana.companyId!, "accountant_packet");
    ids.packetCode = String(appr?.short_code ?? "");
    const reminders = smsTo(captured(), dana.phone).filter((m) => /^(CrankLeads: )?#\d+ Q\d HST: collected/.test(String(m.body)));
    check(reminders.length === 1, `one HST reminder (${reminders.length})`);
    const ask = reminders[0];
    console.log(`   owner: ${short(ask?.body, 600)}`);
    // Collected 520 + 195 = $715 (the draft and the imported OLD-77 are out); ITCs 130 + 6.50/2 + 13 = $146.25.
    const due = mon(hst.due);
    check(appr?.status === "pending" && ask?.from === PLATFORM && new RegExp(`^(CrankLeads: )?#${appr?.short_code} ${hst.label} HST: collected \\$715, ITCs \\$146\\.25, owing about \\$568\\.75\\. Due ${esc(due)}\\. Prepared figures - you or your accountant file the return\\. Y emails the ${hst.label} packet to ${esc(ACCOUNTANT)}\\. Text 'hst' for the breakdown\\. Reply Y ${appr?.short_code} to email it, N ${appr?.short_code} to skip\\.$`).test(String(ask?.body)), "the exact reminder text and figures");
    const { data: hp } = await db.from("hst_periods").select("*").eq("company_id", dana.companyId!);
    check((hp ?? []).length === 1 && hp![0].period_start === hst.start && hp![0].period_end === hst.end && hp![0].status === "reminded" && hp![0].figures?.collectedCents === 71500 && hp![0].figures?.itcCents === 14625, `hst_periods: ${JSON.stringify((hp ?? []).map((r: { period_start: string; status: string; figures: unknown }) => [r.period_start, r.status, r.figures]))}`);
    setMark();
  });

  await step("C4. M0+9: the sub's clearance is 7 days out → request_sub_docs (exact text) → Y → Mike gets the upload link from the business number", async () => {
    const got = captured().slice(0); // the 09:05 tick above
    const appr = await latestApproval(dana.companyId!, "request_sub_docs");
    ids.subReqCode = String(appr?.short_code ?? "");
    const ask = smsTo(got, dana.phone).find((m) => new RegExp(`#${appr?.short_code} `).test(String(m.body)) && /Mike's Electric/.test(String(m.body)));
    console.log(`   owner: ${short(ask?.body, 600)}`);
    // docs: "expires Fri." — the app adds the date ("expires Wed Oct 28.").
    const wd = `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday(D(16))]}(?: ${esc(mon(D(16)))})?`;
    check(appr?.status === "pending" && new RegExp(`#${appr?.short_code} Mike's Electric's WSIB clearance expires ${wd}\\. Y texts Mike a link to upload a new clearance \\+ insurance\\. They'd get: "Hi Mike, it's Northshore Snow & Lawn\\. Your WSIB clearance on file with us expires ${wd}\\. Please upload a new WSIB clearance and your liability insurance here: \\[upload link\\] \\(the link works for 14 days\\)\\. Thanks!" Reply Y ${appr?.short_code} to text them the link, N ${appr?.short_code} to skip\\.`).test(String(ask?.body)), `request_sub_docs #${appr?.short_code} asked`);
    setMark();
    await text(dana.phone, PLATFORM, `Y ${appr?.short_code}`);
    const g2 = sinceMark();
    const toMike = smsTo(g2, MIKE.phone);
    console.log(`   Mike: ${short(toMike[0]?.body)}`);
    check(toMike.length === 1 && toMike[0].from === dana.catcher && new RegExp(`^Hi Mike, it's Northshore Snow & Lawn\\. Your WSIB clearance on file with us expires ${wd}\\. Please upload a new WSIB clearance and your liability insurance here: http://app\\.everdoer\\.localhost:\\d+/compliance/upload/[A-Za-z0-9_-]+ \\(the link works for 14 days\\)\\. Thanks!`).test(String(toMike[0].body)), "Mike's text with the upload link");
    ids.subToken = String(toMike[0]?.body ?? "").match(/compliance\/upload\/([A-Za-z0-9_-]+)/)?.[1] ?? "";
    const own = smsTo(g2, dana.phone);
    check(own.length === 1 && /Texted Mike \(Mike's Electric\) a link to upload a new clearance \+ insurance \(works 14 days\)\. I'll tell you when they send it\./.test(String(own[0].body)), `owner: "${short(own[0]?.body, 200)}"`);
    setMark();
  });

  await step("T2. \"Y n\" on the HST packet → ONE email to the accountant with the summary PDF + expenses CSV (meal at 50%) + invoices CSV (draft and imported left out); the owner's reply", async () => {
    await text(dana.phone, PLATFORM, `Y ${ids.packetCode}`);
    const got = sinceMark();
    const mail = emails(got).filter((e) => e.to === ACCOUNTANT);
    const atts = (mail[0]?.attachments ?? []) as Array<{ filename: string; content: string; bytes: number }>;
    console.log(`   email: ${short(mail[0]?.subject, 120)}; attachments ${atts.map((a) => `${a.filename} (${a.bytes} B)`).join(", ")}`);
    check(mail.length === 1, `one packet email to ${ACCOUNTANT} (${mail.length})`);
    const pdf = atts.find((a) => /^hst-summary-.+\.pdf$/.test(a.filename));
    const exCsv = atts.find((a) => /^expenses-.+\.csv$/.test(a.filename));
    const invCsv = atts.find((a) => /^invoices-.+\.csv$/.test(a.filename));
    check(atts.length === 3 && pdf && pdf.bytes > 500 && String(pdf.content).startsWith("%PDF") && exCsv && invCsv, "attachments: hst-summary PDF, expenses CSV, invoices CSV");
    console.log(`   expenses CSV:\n      ${String(exCsv?.content).replace(/\n/g, "\n      ")}`);
    console.log(`   invoices CSV:\n      ${String(invCsv?.content).replace(/\n/g, "\n      ")}`);
    check(/Tim Hortons/.test(String(exCsv?.content)) && /6\.50,3\.25|6\.5,3\.25/.test(String(exCsv?.content)), "expenses CSV: the meal's HST 6.50 → ITC 3.25");
    check(/INV-Q-1/.test(String(invCsv?.content)) && /INV-Q-2/.test(String(invCsv?.content)) && !/INV-Q-3|OLD-77/.test(String(invCsv?.content)), "invoices CSV: the two that count, not the draft or the imported one");
    const own = smsTo(got, dana.phone);
    console.log(`   owner: ${short(own[0]?.body)}`);
    check(own.length === 1 && new RegExp(`Emailed the ${hst.label} HST packet to ${esc(ACCOUNTANT)}: \\$715 collected, \\$146\\.25 ITCs, owing about \\$568\\.75\\. Prepared figures - you or your accountant file the return\\.`).test(String(own[0].body)), "owner: emailed + disclaimer");
    const { data: hp } = await db.from("hst_periods").select("packet_emailed_at, packet_emailed_to").eq("company_id", dana.companyId!).single();
    check(hp?.packet_emailed_at && hp?.packet_emailed_to === ACCOUNTANT, `hst_periods packet_emailed_at ${hp?.packet_emailed_at} to ${hp?.packet_emailed_to}`);
    setMark();
  });

  await step("U1. purchasing: two confirmed quoted jobs 3 and 4 days out (roof, 7.2 squares) → the draft sweep → ONE materials_order text each (recipe list, estimate, pickup day)", async () => {
    await clockTo(at(D(9), "09:40"));
    const quote = async (contactId: string, title: string) =>
      (must(
        await db
          .from("quotes")
          .insert({
            organization_id: dana.orgId!,
            company_id: dana.companyId!,
            contact_id: contactId,
            public_token: `q_${Math.random().toString(36).slice(2, 14)}`,
            status: "approved",
            title,
            input_snapshot: { services: [{ serviceId: "roof_replacement", measure: 7.2 }] },
            line_items: [{ serviceId: "roof_replacement", label: "Roof replacement (per square)", quantity: 7.2, unitPriceCents: 45000, amountCents: 324000, selected: true }],
            subtotal_cents: 324000,
            tax_cents: 42120,
            total_cents: 366120,
          })
          .select("id")
          .single(),
        "quote",
      ) as { id: string }).id;
    ids.smithQuote = await quote(ids.smith, "Roof replacement");
    ids.ngQuote = await quote(ids.ng, "Roof replacement");
    ids.smithJob = await booking(scope(), { contactId: ids.smith, title: "Roof replacement", at: at(D(12), "08:00"), minutes: 480, location: "21 Bay St, Midland", quoteId: ids.smithQuote });
    ids.ngJob = await booking(scope(), { contactId: ids.ng, title: "Roof replacement", at: at(D(13), "09:00"), minutes: 480, location: "9 Hill Rd, Midland", quoteId: ids.ngQuote });
    setMark();
    await tick();
    const got = sinceMark();
    const { data: pos } = await db.from("purchase_orders").select("*").eq("company_id", dana.companyId!).order("po_seq");
    console.log(`   POs: ${JSON.stringify((pos ?? []).map((p: { po_number: string; status: string; booking_id: string; est_total_cents: number; lines: unknown }) => [p.po_number, p.status, p.booking_id === ids.smithJob ? "Smith" : "Ng", p.est_total_cents, p.lines]))}`);
    const smithPo = (pos ?? []).find((p: { booking_id: string }) => p.booking_id === ids.smithJob);
    const ngPo = (pos ?? []).find((p: { booking_id: string }) => p.booking_id === ids.ngJob);
    ids.smithPo = smithPo?.po_number;
    ids.ngPo = ngPo?.po_number;
    check((pos ?? []).length === 2 && smithPo?.status === "draft" && ngPo?.status === "draft" && smithPo?.basis === "recipe", "two draft POs from the recipe");
    // 7.2 squares: 21.6 → 22 bundles shingles, 2.88 → 3 rolls underlay, 0.72 → 1 box nails; 22×38 + 3×95 + 49 = $1,170.
    check(JSON.stringify((smithPo?.lines ?? []).map((l: { label: string; qty: number; unit: string }) => [l.label, l.qty, l.unit])) === JSON.stringify([["shingles", 22, "bundles"], ["underlay", 3, "rolls"], ["nails", 1, "box"]]) && smithPo?.est_total_cents === 117000, "recipe × 7.2 squares rounded up: 22 bundles, 3 rolls, 1 box (~$1,170)");
    const asks = smsTo(got, dana.phone).filter((m) => /Materials for /.test(String(m.body)));
    for (const a of asks) console.log(`   owner: ${short(a.body, 500)}`);
    const smithAppr = await db.from("owner_approvals").select("*").eq("id", smithPo?.approval_id).single();
    const ngAppr = await db.from("owner_approvals").select("*").eq("id", ngPo?.approval_id).single();
    ids.smithCode = String(smithAppr.data?.short_code ?? "");
    ids.ngCode = String(ngAppr.data?.short_code ?? "");
    const wd = (d: string) => `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday(d)]} ${mon(d)}`;
    const smithAsk = asks.find((m) => /Smith/.test(String(m.body)));
    check(asks.length === 2 && smithAsk?.from === PLATFORM && new RegExp(`#${ids.smithCode} Materials for Smith - Roof replacement ${esc(wd(D(12)))} \\(${ids.smithPo}\\): 22 bundles shingles, 3 rolls underlay, 1 box nails \\(~\\$1,170\\)\\. Y emails Home Depot Pro \\(Barrie\\) for pickup ${esc(wd(D(11)))}\\. Reply Y ${ids.smithCode} to order it, Y ${ids.smithCode} delivery for delivery, Y ${ids.smithCode} no nails to leave nails out, N ${ids.smithCode} to skip\\.`).test(String(smithAsk?.body)), "the exact materials_order text (Smith)");
    setMark();
    await tick();
    check(smsTo(sinceMark(), dana.phone).filter((m) => /Materials for /.test(String(m.body))).length === 0, "drafted once per job");
    const { data: jm } = await db.from("job_materials").select("id").eq("organization_id", dana.orgId!);
    check((jm ?? []).length === 0, "purchasing never writes job_materials");
    setMark();
  });

  await step("U2. other kinds' plain replies are unaffected while materials orders wait: a customer's insurance ask → \"N n\" declines it (the customer is NOT texted; the conversation goes to the owner) and both materials orders stay pending", async () => {
    await text(KIM.phone, dana.catcher!, "Do you have a certificate of insurance you can send me?");
    const appr = await latestApproval(dana.companyId!, "share_compliance_doc");
    check(appr?.status === "pending" && /Kim Ross/.test(appr?.summary ?? ""), `share question #${appr?.short_code} for Kim`);
    setMark();
    await text(dana.phone, PLATFORM, `N ${appr?.short_code}`);
    const got = sinceMark();
    const toKim = smsTo(got, KIM.phone);
    check(toKim.length === 0, `no text to Kim on N (${toKim.length})`);
    const { data: a2 } = await db.from("owner_approvals").select("status").eq("id", appr?.id).single();
    check(a2?.status === "declined" || a2?.status === "rejected", `share approval ${a2?.status}`);
    const { data: pos } = await db.from("purchase_orders").select("status").eq("company_id", dana.companyId!);
    check((pos ?? []).every((p: { status: string }) => p.status === "draft"), "both materials orders still drafts");
    setMark();
  });

  await step("U3. \"Y n delivery\" → the supplier gets an email (PO, items, delivery by …, the job site address, the account number; NO customer name, NO prices); \"Y m\" → the pickup order", async () => {
    await text(dana.phone, PLATFORM, `Y ${ids.ngCode} delivery`);
    let got = sinceMark();
    let mail = emails(got).filter((e) => e.to === SUPPLIER_EMAIL);
    console.log(`   supplier email: ${short(mail[0]?.subject, 120)}\n      ${short(mail[0]?.body, 900)}`);
    const body = `${mail[0]?.subject ?? ""}\n${mail[0]?.body ?? ""}\n${mail[0]?.html ?? ""}`;
    check(mail.length === 1 && body.includes(String(ids.ngPo)) && /22 bundles shingles/.test(body) && /Please deliver this order by/.test(body) && /9 Hill Rd, Midland/.test(body) && /12345/.test(body), "delivery email: PO, list, deliver by, site address, account");
    check(!/\bNg\b|Alex/.test(body) && !/\$/.test(body), "no customer name, no prices");
    check(mail[0]?.replyTo === dana.email || (Array.isArray(mail[0]?.replyTo) && (mail[0].replyTo as string[]).includes(dana.email)), `reply-to the owner (${JSON.stringify(mail[0]?.replyTo)})`);
    const own = smsTo(got, dana.phone);
    console.log(`   owner: ${short(own[0]?.body)}`);
    check(own.length === 1 && new RegExp(`Emailed ${ids.ngPo} to Home Depot Pro \\(Barrie\\) for delivery`).test(String(own[0].body)), "owner: emailed for delivery");
    const { data: ng } = await db.from("purchase_orders").select("status, fulfilment, sent_via, sent_to").eq("po_number", ids.ngPo).eq("company_id", dana.companyId!).single();
    check(ng?.status === "sent" && ng?.fulfilment === "delivery" && ng?.sent_via === "email", `PO ${JSON.stringify(ng)}`);
    setMark();
    await text(dana.phone, PLATFORM, `Y ${ids.smithCode}`);
    got = sinceMark();
    mail = emails(got).filter((e) => e.to === SUPPLIER_EMAIL);
    const b2 = `${mail[0]?.subject ?? ""}\n${mail[0]?.body ?? ""}\n${mail[0]?.html ?? ""}`;
    check(mail.length === 1 && b2.includes(String(ids.smithPo)) && /pick/i.test(b2) && !/\bSmith\b|\bSam\b/.test(b2) && !/\$/.test(b2), "pickup email: PO, no name, no prices");
    const own2 = smsTo(got, dana.phone);
    console.log(`   owner: ${short(own2[0]?.body)}`);
    check(own2.length === 1 && new RegExp(`Emailed ${ids.smithPo} to Home Depot Pro \\(Barrie\\) for pickup ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday(D(11))]} ${esc(mon(D(11)))}\\. Their reply goes to ${esc(dana.email)}\\. Text "${ids.smithPo} ready" when it's ready\\.`).test(String(own2[0].body)), "owner: emailed for pickup (exact)");
    const { data: ex } = await db.from("expenses").select("id").eq("booking_id", ids.smithJob);
    check((ex ?? []).length === 0, "purchasing never writes expenses");
    setMark();
  });

  await p5Before(D(11), "07:01");
  await step("O1. M0+11 07:01: the briefing carries the heads-ups — the sub's clearance (≤ 7 days), Smith's materials pickup (job tomorrow), HST due — and stays ≤ 612 septets", async () => {
    await clockTo(at(D(11), "07:01"));
    await tick();
    const got = sinceMark();
    const b = smsTo(got, dana.phone).filter((m) => /Morning /.test(String(m.body)));
    const body = String(b[0]?.body ?? "");
    console.log(`   briefing (${body.length} chars, ${septets(body)} septets):\n      ${body.replace(/\n/g, "\n      ")}`);
    check(b.length === 1 && b[0].from === PLATFORM, `one briefing from the platform number (${b.length})`);
    check(/Mike's Electric('s)? WSIB clearance expires in 5 days/.test(body), "heads-up: the sub's WSIB clearance expires in 5 days");
    check(new RegExp(`Pick up materials at Home Depot Pro \\(Barrie\\) for Smith \\(${ids.smithPo}\\)`).test(body), "heads-up: the materials pickup");
    // Since Phase 5 the Profit advisor's cash line ranks ahead of Receipts & HST (docs/ai-staff.md →
    // Office manager: at most 4 heads-ups, each role's first line in role order). With compliance,
    // purchasing, service plans and a tight forecast all reporting, the HST line is the fifth and is
    // left out; otherwise it must be there.
    const hstLine = new RegExp(`${hst.label} HST due in ${daysBetween(D(11), hst.due)} days \\(about \\$568\\.75\\)`).test(body);
    const fourBefore = /Cash looks tight around/.test(body) && /plan renewal unpaid/.test(body);
    check(hstLine || fourBefore, `heads-up: HST due${!hstLine && fourBefore ? " (left out: four earlier roles fill the four slots)" : ""}`);
    check(septets(body) <= 612, `≤ 612 GSM septets (${septets(body)})`);
    check([...body].every((ch) => ch.charCodeAt(0) < 128), "plain ASCII");
    setMark();
  });

  await step("C5. the sub uploads through the public link (upload_url → PUT → submit) → filed under the sub, replaces the old clearance, the owner is told", async () => {
    await clockTo(at(D(11), "09:00"));
    const view = await api(null, "GET", `/api/public/compliance/upload/${ids.subToken}`);
    check(view.status === 200, `GET /api/public/compliance/upload/<token> → ${view.status} ${short(view.text, 160)}`);
    const bad = await api(null, "GET", `/api/public/compliance/upload/${"x".repeat(32)}`);
    check(bad.status === 404, `unknown token → ${bad.status}`);
    const up = await api(null, "POST", `/api/public/compliance/upload/${ids.subToken}`, { action: "upload_url", contentType: "application/pdf" });
    const u = dataOf(up);
    check(up.status === 200 && u?.bucket === "compliance-docs" && /\/sub-/.test(String(u?.path)), `upload_url → ${up.status} ${u?.path}`);
    const fresh = { type: "cert", label: "mike-wsib-new", kind: "wsib_clearance", title: "WSIB clearance", issuer: "WSIB", number: "CLR-0099886789", holder: MIKE.business, issued: D(11), expires: D(101) };
    check((await uploadSigned("compliance-docs", u.path, u.token, docBytes(fresh, "application/pdf"), "application/pdf")) === 200, "PUT the PDF");
    setMark();
    const sub = await api(null, "POST", `/api/public/compliance/upload/${ids.subToken}`, { action: "submit", path: u.path, contentType: "application/pdf" }, { "user-agent": "e2e-phase4" });
    check(sub.status === 200, `submit → ${sub.status} ${short(sub.text, 200)}`);
    await drain();
    const got = sinceMark();
    const { data: docs } = await db.from("compliance_documents").select("id, status, expires_on, uploaded_via, replaced_by").eq("company_id", dana.companyId!).eq("subcontractor_id", ids.sub).order("created_at");
    console.log(`   sub docs: ${JSON.stringify(docs)}`);
    const neu = (docs ?? []).find((d: { uploaded_via: string }) => d.uploaded_via === "sub_link");
    const old = (docs ?? []).find((d: { id: string }) => d.id === ids.subDoc);
    check(neu?.expires_on === D(101) && neu?.status === "current" && old?.status === "replaced", "filed under the sub, the old clearance replaced");
    const own = smsTo(got, dana.phone);
    console.log(`   owner: ${short(own[0]?.body)}`);
    check(own.length === 1 && new RegExp(`Mike's Electric sent a new WSIB clearance \\(expires ${esc(monYear(D(101)))}\\)\\.`).test(String(own[0].body)), "the owner is told");
    const { data: ev } = await db.from("compliance_events").select("event, ip, user_agent").eq("company_id", dana.companyId!).eq("event", "sub_upload");
    check((ev ?? []).length === 1, `audited (${JSON.stringify(ev)})`);
    setMark();
  });

  await step("U4. 15:05 the day before Smith's job: ONE pickup reminder (not picked up yet); nothing for Ng's delivery (not tomorrow)", async () => {
    await clockTo(at(D(11), "15:05"));
    await tick();
    const got = sinceMark();
    const rem = smsTo(got, dana.phone).filter((m) => /^(CrankLeads: )?Tomorrow: /.test(String(m.body)));
    console.log(`   owner: ${short(rem[0]?.body)}`);
    check(rem.length === 1 && new RegExp(`Tomorrow: Smith - Roof replacement \\(8:00 a\\.m\\.\\)\\. Materials ${ids.smithPo} from Home Depot Pro \\(Barrie\\) aren't picked up yet\\. Text "${ids.smithPo} picked up" once you have them\\.`).test(String(rem[0].body)), "the pickup reminder");
    setMark();
    await tick();
    check(smsTo(sinceMark(), dana.phone).filter((m) => /Tomorrow: /.test(String(m.body))).length === 0, "once");
    setMark();
  });

  await step("U5. a receipt texted with only \"PO-n\" → filed on that PO's job (Smith) → materials_status shows it as the actual", async () => {
    const r: Doc = { contentType: "application/pdf", spec: { type: "supplier_invoice", label: "hdpro-po", vendor: "Home Depot Pro", date: D(11), totalCents: 125990, taxCents: 14494, category: "materials", description: "Shingles, underlay, nails" } };
    await text(dana.phone, PLATFORM, String(ids.smithPo), [r]);
    let got = sinceMark();
    const reply = smsTo(got, dana.phone);
    console.log(`   owner: ${short(reply[0]?.body)}`);
    check(reply.length === 1 && new RegExp(`Got it: Home Depot Pro \\$1,259\\.90 \\(HST \\$144\\.94\\), Materials, [^,]*Smith[^,]*\\(${esc(mon(D(12)))}\\), ${ids.smithPo}\\.`).test(String(reply[0].body)), "reply names Smith's job and the PO");
    const { data: ex } = await db.from("expenses").select("booking_id, receipt_type").eq("company_id", dana.companyId!).eq("vendor", "Home Depot Pro");
    check((ex ?? []).length === 1 && ex![0].booking_id === ids.smithJob && ex![0].receipt_type === "application/pdf", "expense on Smith's booking (PDF kept)");
    const { data: rt } = await db.from("receipt_texts").select("po_reference").eq("company_id", dana.companyId!).eq("po_reference", ids.smithPo);
    check((rt ?? []).length === 1, `receipt_texts.po_reference ${ids.smithPo}`);
    setMark();
    await text(dana.phone, PLATFORM, `materials status ${ids.smithPo}`);
    got = sinceMark();
    const turns = got.filter((c) => c.kind === "anthropic" && c.purpose === "owner_agent");
    check(turns.some((t) => (t.tools as string[]).includes("materials_status")), "the owner agent is offered materials_status");
    const st = smsTo(got, dana.phone);
    console.log(`   owner: ${short(st[0]?.body)}`);
    // Actual = before tax: 1,259.90 - 144.94 = $1,114.96.
    check(st.length === 1 && /estimated \$1,170/.test(String(st[0].body)) && /actual \$1,114\.96/.test(String(st[0].body)), "materials_status: estimated $1,170 vs actual $1,114.96");
    setMark();
  });

  await runP5();

  await step("C6. the certificate's 7-day text (M0+31), one", async () => {
    await clockTo(at(D(31), "10:00"));
    await tick();
    const heads = smsTo(sinceMark(), dana.phone).filter((m) => /Heads up:/.test(String(m.body)));
    console.log(`   owner: ${short(heads.map((h) => h.body).join(" || "))}`);
    check(heads.length === 1 && /Heads up: Liability insurance expires in 7 days\./.test(String(heads[0].body)), "the 7-day text");
    setMark();
  });

  await step("P6. 14 days after Pat's term ended, unpaid → lapsed: the owner told; only the untouched future visit is removed (a hand-moved one stays); Erin's plan untouched", async () => {
    // Pat's later visits (booked by the recurring sweep, ≤ 60 days out): move one by hand (a
    // recurrence exception) before the lapse — at 08:30, before the 09:00–20:00 lapse window opens.
    await clockTo(at(D(33), "08:30"));
    await tick();
    const { data: before } = await db.from("bookings").select("id, scheduled_for, status, recurrence_exception").eq("recurring_job_id", ids.patSeries).order("scheduled_for");
    const future = (before ?? []).filter((b: { scheduled_for: string }) => Date.parse(b.scheduled_for) > Date.now());
    console.log(`   Pat's visits: ${JSON.stringify((before ?? []).map((b: { scheduled_for: string; status: string }) => [localDate(Date.parse(b.scheduled_for)), b.status]))}`);
    check(future.length >= 2, `at least two future visits booked (${future.length})`);
    const moved = future[future.length - 1];
    const untouched = future.slice(0, -1).map((b: { id: string }) => b.id);
    must(await db.from("bookings").update({ scheduled_for: new Date(Date.parse(moved.scheduled_for) + 86_400_000).toISOString(), recurrence_exception: true }).eq("id", moved.id).select("id"), "move a visit by hand");
    const erinBefore = (await db.from("bookings").select("id").eq("recurring_job_id", (await db.from("service_agreements").select("recurring_job_id").eq("id", ids.erinAgreement).single()).data?.recurring_job_id)).data?.length ?? 0;
    setMark();
    await clockTo(at(D(33), "10:00"));
    await tick();
    const got = sinceMark();
    const { data: ag } = await db.from("service_agreements").select("status, lapsed_at").eq("id", ids.patAgreement).single();
    check(ag?.status === "lapsed", `Pat ${ag?.status}`);
    const { data: after } = await db.from("bookings").select("id, status").eq("recurring_job_id", ids.patSeries);
    const afterIds = new Set((after ?? []).map((b: { id: string }) => b.id));
    check(untouched.every((id: string) => !afterIds.has(id)) && afterIds.has(moved.id), `untouched future visit(s) removed (${untouched.length}), the hand-moved one kept`);
    const own = smsTo(got, dana.phone).filter((m) => /lapsed/.test(String(m.body)));
    console.log(`   owner: ${short(own[0]?.body)}`);
    check(own.length === 1 && new RegExp(`Pat Moore's Winter Property Checks plan lapsed: the renewal wasn't paid by ${esc(monYear(addDays(D(18), 14)).replace(/^(\w+) /, "$1 "))}\\. I took ${untouched.length} upcoming visit${untouched.length === 1 ? "" : "s"} off the calendar\\.`).test(String(own[0].body)), "the lapse text");
    const { data: series } = await db.from("recurring_jobs").select("status").eq("id", ids.patSeries).single();
    check(series?.status === "ended", `Pat's series ${series?.status}`);
    const { data: erin } = await db.from("service_agreements").select("status").eq("id", ids.erinAgreement).single();
    const erinAfter = (await db.from("bookings").select("id").eq("recurring_job_id", (await db.from("service_agreements").select("recurring_job_id").eq("id", ids.erinAgreement).single()).data?.recurring_job_id)).data?.length ?? 0;
    check(erin?.status === "active" && erinAfter >= erinBefore, `Erin still active, her visits untouched (${erinBefore} → ${erinAfter})`);
    setMark();
  });

  await step("P7. job done → invoice with the company's auto-invoicing on: a prepaid (annual) plan visit is NOT invoiced again; an ordinary quoted job still is", async () => {
    must(await db.from("companies").update({ invoice_settings: { autoInvoiceOnComplete: "draft" } }).eq("id", dana.companyId!).select("id"), "auto-invoice on");
    const ctx = { organizationId: dana.orgId!, actorProfileId: null, supabase: admin } as never;
    const { data: erin } = await db.from("service_agreements").select("recurring_job_id").eq("id", ids.erinAgreement).single();
    const { data: visit } = await db.from("bookings").select("id, scheduled_for").eq("recurring_job_id", erin?.recurring_job_id).order("scheduled_for").limit(1).single();
    const count = async () => (await db.from("invoices").select("id").eq("company_id", dana.companyId!)).data?.length ?? 0;
    const before = await count();
    await updateBookingStatus(ctx, { bookingId: visit.id, status: "completed" });
    check((await count()) === before, `completing Erin's plan visit (${localDate(Date.parse(visit.scheduled_for))}) makes no invoice`);
    await updateBookingStatus(ctx, { bookingId: ids.smithJob, status: "completed" });
    const { data: inv } = await db.from("invoices").select("status, total_cents").eq("company_id", dana.companyId!).order("created_at", { ascending: false }).limit(1);
    check((await count()) === before + 1 && inv?.[0]?.status === "draft", `completing Smith's quoted job drafts an invoice (${JSON.stringify(inv?.[0])})`);
  });

  await step("C7. the certificate's expiry-day text (M0+38), one; three expiry texts in all", async () => {
    await clockTo(at(D(38), "10:00"));
    await tick();
    const heads = smsTo(sinceMark(), dana.phone).filter((m) => /Heads up:/.test(String(m.body)));
    console.log(`   owner: ${short(heads.map((h) => h.body).join(" || "))}`);
    check(heads.length === 1 && /Heads up: Liability insurance expires today\./.test(String(heads[0].body)), "the expiry-day text");
    const all = smsTo(captured(), dana.phone).filter((m) => /Liability insurance expires/.test(String(m.body)) && /Heads up/.test(String(m.body)));
    check(all.length === 3, `30 / 7 / 0: exactly three texts all run (${all.length})`);
    setMark();
  });

  await step("Z. house (A1) tenant: none of the four features created rows or sent texts; its recurring series is as it was (rule-based, no visit_dates, every visit kept) and job-done invoicing still drafts an invoice", async () => {
    const h = houseIds!;
    const roles = (await activeRolesFor(admin, { organizationId: h.orgId, companyId: h.companyId })).map((r) => r.role);
    check(!roles.some((r) => /tax|plan|compliance|purchas/i.test(r)), `activeRolesFor(A1) = [${roles.join(", ")}]`);
    for (const table of ["receipt_texts", "hst_periods", "tax_clerk_notices", "service_plans", "service_agreements", "service_plan_messages", "compliance_documents", "subcontractors", "compliance_upload_requests", "compliance_shares", "suppliers", "material_recipes", "purchase_orders", "purchase_order_drafts"]) {
      const { data, error } = await db.from(table).select("id").eq("company_id", h.companyId);
      check(!error && (data ?? []).length === 0, `${table}: none for A1${error ? ` (${error.message})` : ""}`);
    }
    const { data: appr } = await db.from("owner_approvals").select("kind").eq("company_id", h.companyId);
    check((appr ?? []).length === 0, `no owner_approvals for A1 (${JSON.stringify(appr)})`);
    const toHouse = captured().filter((c) => c.kind === "sms" && [HOUSE.owner, HOUSE.customer].includes(String(c.to)));
    console.log(`   texts to A1 numbers: ${toHouse.map((c) => `${c.to}: ${short(c.body, 60)}`).join(" | ")}`);
    check(toHouse.every((c) => c.to === HOUSE.owner && /Got the picture|I can help/.test(String(c.body))), "the only texts to A1 numbers were its owner's old replies");
    // The series: same rule, still no visit_dates, every original visit still there unchanged.
    const { data: series } = await db.from("recurring_jobs").select("*").eq("id", ids.houseSeries).single();
    const strip = (r: Record<string, unknown> | undefined) => {
      const { generated_through: _g, updated_at: _u, ...rest } = r ?? {};
      return JSON.stringify(rest);
    };
    check(strip(series) === strip(houseBaseline.series) && series?.visit_dates == null, "A1 series row unchanged (but its generation horizon), visit_dates NULL");
    const { data: visits } = await db.from("bookings").select("id, scheduled_for, status").eq("recurring_job_id", ids.houseSeries).order("scheduled_for");
    const byId = new Map((visits ?? []).map((v: { id: string }) => [v.id, v]));
    check(houseBaseline.visits!.every((v) => JSON.stringify(byId.get(v.id)) === JSON.stringify(v)), `every original A1 visit kept as it was (${houseBaseline.visits!.length})`);
    check((visits ?? []).every((v: { scheduled_for: string }) => weekday(localDate(Date.parse(v.scheduled_for))) === 2 && torontoTime(Date.parse(v.scheduled_for)).endsWith("09:00")), `all ${(visits ?? []).length} A1 visits on its own rule (Tuesdays 09:00)`);
    // Job done → invoice, as before.
    const first = houseBaseline.visits![0];
    const ctx = { organizationId: h.orgId, actorProfileId: null, supabase: admin } as never;
    await updateBookingStatus(ctx, { bookingId: first.id, status: "completed" });
    const { data: inv } = await db.from("invoices").select("id, status, total_cents").eq("company_id", h.companyId);
    check((inv ?? []).length === houseBaseline.invoices! + 1 && (inv ?? []).some((i: { status: string }) => i.status === "draft"), `completing an A1 visit drafts an invoice (${JSON.stringify(inv)})`);
  });

  // ── timeline ───────────────────────────────────────────────────────────────
  const names = new Map<string, string>([
    [dana.phone, "owner"],
    [PLATFORM, "platform"],
    [dana.catcher ?? "", "company#"],
    [ERIN.phone, "Erin"],
    [PAT.phone, "Pat"],
    [LEE.phone, "Lee"],
    [KIM.phone, "Kim"],
    [MIKE.phone, "Mike(sub)"],
    [HOUSE.catcher, "A1#"],
    [HOUSE.owner, "A1 owner"],
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
  writeFileSync(join(OUT, "phase4-results.json"), JSON.stringify({ results, checks, failedChecks }, null, 2));
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
