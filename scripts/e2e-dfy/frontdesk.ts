/**
 * Phase 1 — the AI front desk, end to end (docs/front-desk-ai.md), on the done-for-you e2e stack
 * (scripts/e2e-dfy/README.md → "Phase 1 front desk"). Real local Postgres + PostgREST + Next +
 * Vite; Twilio / Retell / Anthropic / Resend / Stripe are the fakes in fakes.mjs (the "model" is
 * scripted and builds every reply only from what it was sent). Run with
 * scripts/e2e-dfy/frontdesk.sh (fresh stack, fake clock at 09:05 Toronto).
 *
 * A live CrankLeads Close company is made the way a buyer gets one (signed Stripe webhook →
 * billing worker → provisioned org/company/catcher number), then switched on with the real
 * done-for-you switch-on (automations, booking hours) and marked live.
 */
import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import Stripe from "stripe";

import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createCrankleadsCheckout } from "@/server/services/crankleads/checkout";
import { claimBillingEventJobs } from "@/server/services/billing/jobs";
import { processBillingEventJob } from "@/server/services/billing/events";
import { switchOnEverything } from "@/server/services/dfy/switch-on";
import { processInboundWebhookJobs } from "@/server/services/inbound-webhook-jobs";
import { runScheduler } from "@/server/services/workflow-engine/scheduler";
import { claimWorkflowEventJobs, processWorkflowEventJob } from "@/server/services/workflow-event-jobs";
import { processWeeklyReports, resetWeeklyReportThrottle } from "@/server/services/weekly-report/send";
import { smsSegments } from "@/server/templates/weekly-report";

type Admin = ReturnType<typeof createSupabaseAdminClient>;

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
};
const BUYER_APP = env("CRANKLEADS_APP_BASE_URL");
const HOUSE_APP = env("APP_BASE_URL");
const CAPTURE = env("E2E_CAPTURE_LOG");
const SHOTS = env("E2E_FRONTDESK_SHOTS", join(env("E2E_ROOT"), "frontdesk-shots"));
const CLOCK_FILE = env("E2E_CLOCK_FILE");
const PLATFORM = env("TWILIO_FROM_NUMBER");
const PASSWORD = "e2e-password-123";
const CHROME = process.env.E2E_CHROME ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const FAKES = `http://127.0.0.1:${env("E2E_FAKES_PORT")}`;
const TZ = "America/Toronto";

mkdirSync(SHOTS, { recursive: true });
const admin: Admin = createSupabaseAdminClient();

// ── reporting ────────────────────────────────────────────────────────────────
const results: Array<{ step: string; ok: boolean; notes: string[] }> = [];
let current: { step: string; ok: boolean; notes: string[] } | null = null;
function check(cond: unknown, message: string): boolean {
  const ok = Boolean(cond);
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
    current.notes.push(`ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    console.log(`   ERROR ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
  results.push(current);
  current = null;
}
const shots: string[] = [];
async function shot(page: Page, name: string, fullPage = true): Promise<void> {
  const file = join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage });
  shots.push(file);
  console.log(`   shot ${file}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const torontoTime = (ms: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);

// ── fake clock ───────────────────────────────────────────────────────────────
function clockOffsetMinutes(): number {
  return Number(readFileSync(CLOCK_FILE, "utf8").trim().replace(/m$/, ""));
}
async function advanceClock(minutes: number): Promise<void> {
  const next = clockOffsetMinutes() + minutes;
  writeFileSync(CLOCK_FILE, `${next >= 0 ? "+" : ""}${next}m\n`);
  await sleep(2500);
  console.log(`   clock +${minutes} min → ${new Date().toISOString()} (${torontoTime(Date.now())} Toronto)`);
}

// ── captured third-party traffic ─────────────────────────────────────────────
interface Captured {
  t: string;
  kind: string;
  to?: string;
  from?: string;
  body?: string;
  subject?: string;
  [k: string]: unknown;
}
function captured(): Captured[] {
  return readFileSync(CAPTURE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Captured);
}
let mark = 0;
/** Everything captured since the last `since()` mark. */
function sinceMark(): Captured[] {
  return captured().slice(mark);
}
function setMark(): void {
  mark = captured().length;
}
const smsTo = (list: Captured[], phone: string) => list.filter((c) => c.kind === "sms" && c.to === phone);

// ── queue drains (the workflow worker's loop body) ───────────────────────────
async function drain(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const inbound = await processInboundWebhookJobs(admin, { batch: 20, staleAfterSeconds: 900, workerId: "e2e-worker" });
    const jobs = await claimWorkflowEventJobs(admin, { limit: 20, staleAfterSeconds: 900, workerId: "e2e-worker" });
    for (const job of jobs) await processWorkflowEventJob(admin, job).catch((e) => console.log("   workflow job error", e instanceof Error ? e.message : e));
    if (jobs.length === 0 && inbound === 0) break;
  }
}

// ── Twilio / Retell webhooks, signed the way they sign ──────────────────────
function twilioSignature(url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", env("TWILIO_AUTH_TOKEN")).update(Buffer.from(data, "utf8")).digest("base64");
}
async function postTwilio(path: string, params: Record<string, string>): Promise<Response> {
  const url = `${HOUSE_APP}${path}`;
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(url, params) },
    body: new URLSearchParams(params).toString(),
  });
}
let sidSeq = 0;
const newSid = (prefix: string) => `${prefix}${Date.now().toString(16)}${(++sidSeq).toString(16).padStart(4, "0")}`.padEnd(34, "0").slice(0, 34);

/** A text arriving at a Twilio number (what Twilio POSTs), then the worker drains the queue. */
async function text(from: string, to: string, body: string, media: Array<{ url: string; type: string }> = []): Promise<void> {
  const params: Record<string, string> = {
    AccountSid: env("TWILIO_ACCOUNT_SID"),
    MessageSid: newSid("SM"),
    From: from,
    To: to,
    Body: body,
    NumMedia: String(media.length),
  };
  media.forEach((m, i) => {
    params[`MediaUrl${i}`] = m.url;
    params[`MediaContentType${i}`] = m.type;
  });
  const res = await postTwilio("/api/twilio/sms/inbound", params);
  if (res.status !== 200) console.log(`   inbound SMS webhook → ${res.status} ${await res.text()}`);
  await drain();
}

/** A forwarded call reaching the catcher number → the TwiML Twilio would get. */
async function call(from: string, to: string, forwardedFrom: string | null): Promise<{ twiml: string; callSid: string }> {
  const callSid = newSid("CA");
  const res = await postTwilio("/api/twilio/voice/inbound", {
    AccountSid: env("TWILIO_ACCOUNT_SID"),
    CallSid: callSid,
    From: from,
    To: to,
    Called: to,
    ...(forwardedFrom ? { ForwardedFrom: forwardedFrom } : {}),
    CallStatus: "ringing",
    Direction: "inbound",
  });
  const twiml = await res.text();
  return { twiml, callSid };
}

async function retellWebhook(payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  const ts = String(Date.now());
  const digest = createHmac("sha256", env("RETELL_API_KEY")).update(body + ts, "utf8").digest("hex");
  return fetch(`${HOUSE_APP}/api/retell/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-retell-signature": `v=${ts},d=${digest}` }, body });
}

async function fakeControl(patch: Record<string, unknown>): Promise<void> {
  await fetch(`${FAKES}/__control`, { method: "POST", body: JSON.stringify(patch) });
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
    checkout: {
      sessions: {
        create: async () => {
          n += 1;
          const id = `cs_test_fd_${Date.now().toString(36)}${n}`;
          return { id, url: `https://checkout.stripe.test/c/pay/${id}` };
        },
      },
    },
    coupons: { retrieve: async () => ({ valid: false }) },
  } as unknown as Stripe;
}

async function buy(buyer: Buyer): Promise<void> {
  const checkout = await createCrankleadsCheckout(
    admin,
    { tier: buyer.tier, name: buyer.name, email: buyer.email, phone: buyer.phone, businessName: buyer.businessName, businessType: buyer.businessType },
    fakeStripe(),
  );
  buyer.purchaseId = checkout.purchaseId;
  const suffix = checkout.purchaseId.slice(0, 8);
  const event = {
    id: `evt_fd_${suffix}`,
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
        customer: `cus_fd_${suffix}`,
        subscription: `sub_fd_${suffix}`,
        customer_email: buyer.email,
        customer_details: { email: buyer.email, name: buyer.name, phone: buyer.phone },
        client_reference_id: checkout.purchaseId,
        metadata: {
          source: "crankleads",
          purchaseId: checkout.purchaseId,
          tier: buyer.tier,
          plan: buyer.tier === "front_desk" ? "growth" : "starter",
          businessName: buyer.businessName,
          businessType: buyer.businessType,
          ownerName: buyer.name,
          ownerPhone: buyer.phone,
          utm: "{}",
        },
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

// ── browser ──────────────────────────────────────────────────────────────────
let browser: Browser;
async function context(width: number): Promise<BrowserContext> {
  const mobile = width < 600;
  const ctx = await browser.newContext({
    viewport: { width, height: mobile ? 844 : 900 },
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    locale: "en-CA",
    timezoneId: TZ,
  });
  await ctx.clock.install({ time: Date.now() });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  return ctx;
}
async function signIn(ctx: BrowserContext, email: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`${BUYER_APP}/signin`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"), { timeout: 30_000 });
  return page;
}

// ════════════════════════════════════════════════════════════════════════════
const dana: Buyer = {
  name: "Dana Whitfield",
  email: "dana@northshoresnow.ca",
  phone: "+17055550142",
  businessName: "Northshore Snow & Lawn",
  businessType: "Property maintenance & snow",
  tier: "close",
};
const JAMIE = { first: "Jamie", last: "Lee", phone: "+17055550123" };
const CASEY = { name: "Casey Morgan", phone: "+17055550177" };
const HOUSE = { owner: "+17055550111", catcher: "+17055550161", customer: "+17055550190" };
let jamieId = "";
let houseIds: { orgId: string; companyId: string } | null = null;
let approvalPendingForShots = false;

async function seedHouse(): Promise<void> {
  const { data: org, error } = await admin.from("organizations").insert({ name: "A1 Group (house)", slug: "a1-group-house-fd", subscription_status: "active" }).select("id").single();
  if (error) throw new Error(`house org: ${error.message}`);
  const { data: company, error: cErr } = await admin
    .from("companies")
    .insert({ organization_id: org.id, name: "A1 Marine Care", slug: "a1-marine-care-fd", timezone: TZ, owner_phone_e164: HOUSE.owner, owner_email: "owner@a1.test" })
    .select("id")
    .single();
  if (cErr) throw new Error(`house company: ${cErr.message}`);
  const { error: vErr } = await admin
    .from("voice_numbers")
    .insert({ organization_id: org.id, company_id: company.id, provider: "twilio", mode: "missed_call_catcher", phone_e164: HOUSE.catcher, active: true });
  if (vErr) throw new Error(`house number: ${vErr.message}`);
  houseIds = { orgId: org.id, companyId: company.id };
}

async function main(): Promise<void> {
  browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--no-proxy-server"], env: { ...process.env, LD_PRELOAD: "", FAKETIME_TIMESTAMP_FILE: "" } });
  {
    const warm = await (await browser.newContext()).newPage();
    await warm.goto(`${BUYER_APP}/signin`, { timeout: 180_000 }).catch(() => undefined);
    await warm.waitForTimeout(5000);
    await warm.context().close();
  }
  console.log(`clock now ${new Date().toISOString()} (${torontoTime(Date.now())} Toronto)`);

  await step("0. a live CrankLeads Close company (purchase → provisioned → switch-on → live) + a house tenant", async () => {
    await seedHouse();
    await buy(dana);
    const { data: numbers } = await admin.from("voice_numbers").select("phone_e164, mode, provider").eq("company_id", dana.companyId!);
    dana.catcher = (numbers ?? []).find((n) => n.mode === "missed_call_catcher")?.phone_e164;
    check(dana.catcher?.startsWith("+1705"), `company number (catcher) ${dana.catcher}`);
    // What the quick setup + enrichment would have filled in.
    const { error: cErr } = await admin
      .from("companies")
      .update({
        hours: { summary: "Monday: 7:00 AM – 6:00 PM; Tuesday: 7:00 AM – 6:00 PM; Wednesday: 7:00 AM – 6:00 PM; Thursday: 7:00 AM – 6:00 PM; Friday: 7:00 AM – 6:00 PM; Saturday: 8:00 AM – 12:00 PM; Sunday: Closed" },
        service_area: "Midland and surrounding area",
        timezone: TZ,
        owner_email: dana.email,
      })
      .eq("id", dana.companyId!);
    if (cErr) throw new Error(cErr.message);
    const { error: iErr } = await admin.from("service_catalog_items").upsert([
      { organization_id: dana.orgId!, company_id: dana.companyId!, service_key: "seasonal_double_driveway", label: "Seasonal snow contract — double driveway", description: "Plowing every 5 cm, Nov 15 – Apr 15", pricing_type: "flat", rate_cents: 65000, minimum_cents: 0, active: true, sort_order: 1 },
      { organization_id: dana.orgId!, company_id: dana.companyId!, service_key: "spring_cleanup", label: "Spring cleanup", pricing_type: "flat", rate_cents: 25000, minimum_cents: 0, active: true, sort_order: 2 },
    ], { onConflict: "company_id,service_key" });
    if (iErr) throw new Error(`catalog: ${iErr.message}`);
    const switched = await switchOnEverything({ organizationId: dana.orgId!, actorProfileId: null, supabase: admin as never }, dana.companyId!, "close");
    console.log(`   switch-on: ${JSON.stringify(switched).slice(0, 300)}`);
    const now = new Date().toISOString();
    const { error: lErr } = await admin.from("crankleads_purchases").update({ live_at: now, setup_followups_exempt_at: now }).eq("id", dana.purchaseId!);
    if (lErr) throw new Error(`live: ${lErr.message}`);
    // An existing customer (the CRM already has Jamie from last winter).
    const { data: jamie, error: jErr } = await admin
      .from("contacts")
      .insert({ organization_id: dana.orgId!, company_id: dana.companyId!, first_name: JAMIE.first, last_name: JAMIE.last, phone: JAMIE.phone, sms_consent_at: now, consent_source: "inbound_sms" })
      .select("id")
      .single();
    if (jErr) throw new Error(`contact: ${jErr.message}`);
    jamieId = jamie.id;
    const { data: wfs } = await admin.from("workflows").select("slug, status").eq("organization_id", dana.orgId!);
    const active = (wfs ?? []).filter((w) => w.status === "active").map((w) => w.slug);
    console.log(`   active automations: ${active.join(", ")}`);
    check(active.includes("customer-text-to-owner"), "the owner's 'forward customer texts to me' relay is ON (so 'no echo' below means something)");
    await drain();
    setMark();
  });

  await step("1. customer asks a price → ONE AI reply (disclosure + price-list price, company number, sent_by sms_agent), no relay echo", async () => {
    await text(JAMIE.phone, dana.catcher!, "Hi, how much for a seasonal snow contract for a double driveway in Midland?");
    const got = sinceMark();
    const toJamie = smsTo(got, JAMIE.phone);
    check(toJamie.length === 1, `exactly one reply to the customer (${toJamie.length})`);
    const reply = String(toJamie[0]?.body ?? "");
    console.log(`   reply: ${reply.replace(/\n/g, " | ")}`);
    check(/automated assistant/i.test(reply), "AI disclosure");
    check(/\$650/.test(reply), "the price-list price ($650)");
    check(toJamie[0]?.from === dana.catcher, `from the company number (${toJamie[0]?.from})`);
    const model = got.filter((c) => c.kind === "anthropic" && c.purpose === "sms_agent");
    check(model.length === 3, `model rounds: get_price_list → quote_from_price_list → reply (${model.length})`);
    const { data: logged } = await admin.from("message_log").select("sent_by, status, to_addr").eq("contact_id", jamieId).eq("direction", "outbound");
    check((logged ?? []).some((r) => r.sent_by === "sms_agent" && r.status === "sent"), "message_log.sent_by = sms_agent");
    const echo = smsTo(got, dana.phone).filter((m) => /how much|seasonal snow/i.test(String(m.body)));
    check(echo.length === 0, `no customer-text-to-owner echo to the owner (${echo.length})`);
    setMark();
  });

  await step("2. '$500?' → approval → owner 'Reply Y/N' from the platform number → 'Y but $575' → $575 quote link once + result line", async () => {
    await text(JAMIE.phone, dana.catcher!, "Can you do it for $500?");
    let got = sinceMark();
    const { data: approvals } = await admin.from("owner_approvals").select("*").eq("company_id", dana.companyId!).eq("kind", "custom_price");
    check((approvals ?? []).length === 1 && approvals![0].status === "pending", `custom_price approval pending (#${approvals?.[0]?.short_code})`);
    const ask = smsTo(got, dana.phone).find((m) => /Reply Y/.test(String(m.body)));
    check(ask && ask.from === PLATFORM, `owner asked from the platform number: "${ask?.body}" (from ${ask?.from})`);
    const code = approvals?.[0]?.short_code;
    // Built in code from the payload: the code, the exact line label the quote will carry, the instruction.
    check(new RegExp(`#${code} `).test(String(ask?.body)) && new RegExp(`Reply Y ${code} \\$price`).test(String(ask?.body)), `approval text shows #${code} and "Reply Y ${code} $price"`);
    check(/The quote will say "Seasonal snow contract, double driveway, Midland"/.test(String(ask?.body)), "approval text shows the exact quote line label");
    check(/Their text: "Can you do it for \$500\?"/.test(String(ask?.body)), "approval text quotes the customer's own words");
    const holding = smsTo(got, JAMIE.phone);
    check(holding.length === 1 && /check with Dana/i.test(String(holding[0].body)), `customer told we're checking: "${holding[0]?.body}"`);
    setMark();
    await text(dana.phone, PLATFORM, "Y but $575");
    got = sinceMark();
    const quoteText = smsTo(got, JAMIE.phone);
    check(quoteText.length === 1, `one text to the customer (${quoteText.length})`);
    check(/\$575/.test(String(quoteText[0]?.body)) && /\/q\//.test(String(quoteText[0]?.body)), `the $575 quote link: "${quoteText[0]?.body}"`);
    check(quoteText[0]?.from === dana.catcher, "from the company number");
    const result = smsTo(got, dana.phone);
    check(result.length === 1 && result[0].from === PLATFORM && /\$575/.test(String(result[0].body)), `owner result line: "${result[0]?.body}"`);
    const { data: after } = await admin.from("owner_approvals").select("status, decided_via, result, execution_claimed_at").eq("id", approvals![0].id).single();
    check(after?.status === "executed" && after?.decided_via === "sms" && after?.execution_claimed_at, `approval executed via sms (${after?.status})`);
    const { data: quotes } = await admin.from("quotes").select("id, total_cents, subtotal_cents").eq("contact_id", jamieId);
    check((quotes ?? []).filter((q) => q.subtotal_cents === 57500).length === 1, `exactly one $575 quote (${JSON.stringify(quotes)})`);
    setMark();
    await text(dana.phone, PLATFORM, "Y");
    got = sinceMark();
    check(smsTo(got, JAMIE.phone).length === 0, "a second 'Y' runs nothing again");
    console.log(`   second Y → owner: "${smsTo(got, dana.phone)[0]?.body ?? "(no reply)"}"`);
    setMark();
  });

  await step("3. a photo (MMS) → message_log.media; the model gets an image block", async () => {
    const mediaUrl = `https://api.twilio.com/2010-04-01/Accounts/${env("TWILIO_ACCOUNT_SID")}/Messages/MM${"a".repeat(32)}/Media/ME${"b".repeat(32)}`;
    await text(JAMIE.phone, dana.catcher!, "Here's the driveway", [{ url: mediaUrl, type: "image/png" }]);
    const got = sinceMark();
    const { data: rows } = await admin.from("message_log").select("media, body").eq("contact_id", jamieId).eq("direction", "inbound").order("created_at", { ascending: false }).limit(1);
    const media = rows?.[0]?.media as Array<{ url: string }> | null;
    check(media?.[0]?.url === mediaUrl, `message_log.media stored (${JSON.stringify(media)})`);
    const fetched = got.filter((c) => c.kind === "twilio_media");
    check(fetched.length === 1 && fetched[0].basicAuth === true, "the image was fetched from Twilio with Basic auth");
    const saw = got.filter((c) => c.kind === "anthropic" && c.purpose === "sms_agent" && Number(c.images) > 0);
    check(saw.length >= 1, `the model saw ${saw[0]?.images ?? 0} image block(s)`);
    const reply = smsTo(got, JAMIE.phone);
    check(reply.length === 1, `one reply: "${reply[0]?.body}"`);
    setMark();
  });

  await step("4. complaint → hand-off: state owner, owner alerted, AI silent on the next text", async () => {
    await text(JAMIE.phone, dana.catcher!, "This is ridiculous, your guy damaged my lawn");
    let got = sinceMark();
    const { data: conv } = await admin.from("sms_conversations").select("state, owner_takeover_at, summary").eq("contact_id", jamieId).single();
    check(conv?.state === "owner", `conversation state owner (${conv?.state})`);
    const alert = smsTo(got, dana.phone).find((m) => /needs you/i.test(String(m.body)));
    check(alert, `owner alerted: "${alert?.body}" (from ${alert?.from})`);
    const toJamie = smsTo(got, JAMIE.phone);
    check(toJamie.length === 1, `customer told someone will follow up: "${toJamie[0]?.body}"`);
    setMark();
    await text(JAMIE.phone, dana.catcher!, "Hello?? Anyone there?");
    got = sinceMark();
    check(smsTo(got, JAMIE.phone).length === 0, "AI silent on the next customer text");
    check(got.filter((c) => c.kind === "anthropic" && c.purpose === "sms_agent").length === 0, "no model call");
    const relayed = smsTo(got, dana.phone).filter((m) => /Anyone there/.test(String(m.body)));
    console.log(`   (the owner's own relay now forwards it, since the AI stepped back: ${relayed.length} text)`);
    setMark();
  });

  await step("5. owner by text: what's on tomorrow / move Jamie to Friday 9 → Y / tell Jamie → takeover", async () => {
    // A booking for Jamie tomorrow at 10:00.
    const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(Date.now() + 86_400_000);
    const at = new Date(`${tomorrow}T10:00:00-04:00`).toISOString();
    const { data: booking, error } = await admin
      .from("bookings")
      .insert({ organization_id: dana.orgId!, company_id: dana.companyId!, contact_id: jamieId, title: "Driveway assessment", scheduled_for: at, duration_minutes: 60, status: "confirmed" })
      .select("id")
      .single();
    if (error) throw new Error(`booking: ${error.message}`);
    await text(dana.phone, PLATFORM, "what's on tomorrow");
    let got = sinceMark();
    const agenda = smsTo(got, dana.phone);
    check(agenda.length === 1 && /Jamie/.test(String(agenda[0].body)) && agenda[0].from === PLATFORM, `agenda: "${agenda[0]?.body}"`);
    setMark();
    await text(dana.phone, PLATFORM, "move Jamie to Friday 9");
    got = sinceMark();
    const confirm = smsTo(got, dana.phone);
    const moveCode = /Reply (\d{4}) to confirm/.exec(String(confirm[0]?.body))?.[1];
    check(confirm.length === 1 && moveCode, `confirm with a 4-digit code: "${confirm[0]?.body}"`);
    setMark();
    // A bare "Y" doesn't confirm a destructive command (a spoofer can't see the code).
    await text(dana.phone, PLATFORM, "Y");
    got = sinceMark();
    const { data: notMoved } = await admin.from("bookings").select("scheduled_for").eq("id", booking.id).single();
    check(Date.parse(String(notMoved?.scheduled_for)) === Date.parse(at) && /4-digit code/.test(String(smsTo(got, dana.phone)[0]?.body)), `a bare Y doesn't move it: "${smsTo(got, dana.phone)[0]?.body}"`);
    setMark();
    await text(dana.phone, PLATFORM, moveCode ?? "0000");
    got = sinceMark();
    const { data: moved } = await admin.from("bookings").select("scheduled_for").eq("id", booking.id).single();
    const local = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, weekday: "long", hour: "numeric", minute: "2-digit" }).format(new Date(moved!.scheduled_for));
    check(/Friday/.test(local) && /9:00/.test(local), `booking moved to ${local}`);
    console.log(`   owner: "${smsTo(got, dana.phone)[0]?.body ?? "(none)"}"`);
    console.log(`   customer: "${smsTo(got, JAMIE.phone)[0]?.body ?? "(none)"}"`);
    // Simulate the 72h takeover lapsing so the relay's takeover is visible.
    await admin.from("sms_conversations").update({ state: "ai", owner_takeover_at: null }).eq("contact_id", jamieId);
    setMark();
    await text(dana.phone, PLATFORM, "tell Jamie we'll be there at 9");
    got = sinceMark();
    const echo = smsTo(got, dana.phone)[0];
    const tellCode = /Reply (\d{4}) to confirm/.exec(String(echo?.body))?.[1];
    check(/Send to Jamie Lee: "We'll be there at 9\."\?/.test(String(echo?.body)) && tellCode, `the exact message echoed for a code: "${echo?.body}"`);
    check(smsTo(got, JAMIE.phone).length === 0, "nothing sent to the customer before the code");
    setMark();
    await text(dana.phone, PLATFORM, tellCode ?? "0000");
    got = sinceMark();
    console.log(`   owner: "${smsTo(got, dana.phone)[0]?.body ?? "(none)"}"`);
    const told = smsTo(got, JAMIE.phone);
    check(told.length === 1 && /be there at 9/i.test(String(told[0].body)) && told[0].from === dana.catcher, `customer got it from the company number: "${told[0]?.body}"`);
    const { data: conv } = await admin.from("sms_conversations").select("state").eq("contact_id", jamieId).single();
    check(conv?.state === "owner", `conversation → owner takeover (${conv?.state})`);
    setMark();
  });

  await step("6. forwarded call → AI (Dial/Sip) → post-call: lead, owner alert, ONE follow-up, no text-back; caller texts back → reply knows the call; register failure → voicemail", async () => {
    const { twiml, callSid } = await call(CASEY.phone, dana.catcher!, dana.phone);
    console.log(`   TwiML: ${twiml.replace(/\s+/g, " ").slice(0, 300)}`);
    check(/<Dial[^>]*>\s*<Sip>sip:call_e2e_[A-Za-z0-9_-]+@sip\.retellai\.com<\/Sip>\s*<\/Dial>/.test(twiml), "TwiML <Dial><Sip> to the registered Retell call");
    await drain();
    const registered = (await (await fetch(`${FAKES}/__retell/registered`)).json()) as Array<{ call_id: string; agent_id: string; metadata: Record<string, unknown>; retell_llm_dynamic_variables: Record<string, string> }>;
    const reg = registered.at(-1)!;
    check(reg?.metadata?.twilio_call_sid === callSid && reg.metadata.company_id === dana.companyId, "registered with our tenant + CallSid in metadata");
    check(reg?.retell_llm_dynamic_variables?.company_name === dana.businessName, `dynamic variables carry the business (${reg?.retell_llm_dynamic_variables?.company_name})`);
    const { data: pending } = await admin.from("missed_calls").select("text_back_status").eq("call_sid", callSid).single();
    check(pending?.text_back_status === "ai_pending", `missed_calls ai_pending (${pending?.text_back_status})`);
    // The Dial action: the SIP leg completed.
    const dial = await postTwilio("/api/twilio/voice/ai-handoff?event=dial", { AccountSid: env("TWILIO_ACCOUNT_SID"), CallSid: callSid, DialCallStatus: "completed", DialCallDuration: "95" });
    check(/<Hangup\/>/.test(await dial.text()), "Dial action (completed) → <Hangup/>");
    // Retell's post-call webhook (signed).
    const res = await retellWebhook({
      event: "call_analyzed",
      call: {
        call_id: reg.call_id,
        agent_id: reg.agent_id,
        call_type: "phone_call",
        direction: "inbound",
        from_number: CASEY.phone,
        to_number: dana.catcher,
        call_status: "ended",
        duration_ms: 95_000,
        start_timestamp: Date.now() - 100_000,
        end_timestamp: Date.now() - 5_000,
        metadata: reg.metadata,
        transcript: "Agent: Hi, thanks for calling Northshore Snow & Lawn. You've reached their automated assistant...\nUser: Hi, I'm Casey Morgan, I need a seasonal contract for my double driveway at 88 Bay St in Midland. Can someone call me back?",
        call_analysis: {
          call_summary: "Casey Morgan wants a seasonal snow contract for a double driveway at 88 Bay St, Midland, and asked for a callback.",
          call_successful: true,
          in_voicemail: false,
          user_sentiment: "Positive",
          custom_analysis_data: {
            caller_name: "Casey Morgan",
            callback_number: CASEY.phone,
            job_description: "seasonal snow contract for a double driveway",
            service_address: "88 Bay St, Midland",
            urgency: "normal",
            is_urgent: false,
            callback_requested: true,
            callback_time: "this afternoon",
            booking_link_requested: false,
            do_not_text: false,
          },
        },
      },
    });
    check(res.status === 200, `Retell webhook accepted (${res.status})`);
    await drain();
    const got = sinceMark();
    const { data: rc } = await admin.from("retell_calls").select("organization_id, company_id, call_id").eq("call_id", reg.call_id).maybeSingle();
    check(rc?.company_id === dana.companyId, "retell_calls row filed under the company");
    const { data: casey } = await admin.from("contacts").select("id, first_name, last_name").eq("company_id", dana.companyId!).eq("phone_last10", CASEY.phone.slice(-10)).maybeSingle();
    check(casey && /Casey/.test(`${casey.first_name}`), `lead/contact for the caller (${casey?.first_name} ${casey?.last_name ?? ""})`);
    const { data: done } = await admin.from("missed_calls").select("text_back_status, owner_alerted_at, ai_followup_at").eq("call_sid", callSid).single();
    check(done?.text_back_status === "ai_handled", `missed_calls ai_handled (${done?.text_back_status})`);
    const toCaller = smsTo(got, CASEY.phone);
    check(toCaller.length === 1, `ONE follow-up text to the caller (${toCaller.length}): "${toCaller[0]?.body}"`);
    check(!toCaller.some((m) => /sorry we missed|missed your call/i.test(String(m.body))), "no generic missed-call text-back");
    const alert = smsTo(got, dana.phone).find((m) => /took a call/i.test(String(m.body)));
    check(alert, `owner alert: "${alert?.body}"`);
    const { data: seeded } = await admin.from("sms_conversations").select("state, collected, summary").eq("contact_id", casey!.id).maybeSingle();
    check(seeded?.state === "ai" && (seeded.collected as Record<string, unknown>)?.source === "phone_call", "texting AI's conversation seeded from the call");
    setMark();
    // The caller texts back.
    await text(CASEY.phone, dana.catcher!, "Thanks! Can you just text me the price?");
    const back = sinceMark();
    const reply = smsTo(back, CASEY.phone);
    check(reply.length === 1, `one AI reply (${reply.length})`);
    console.log(`   reply: ${String(reply[0]?.body).replace(/\n/g, " | ")}`);
    check(/88 Bay St/.test(String(reply[0]?.body)) && /double driveway/i.test(String(reply[0]?.body)), "the reply knows the call (job + address from the call)");
    check(/\$650/.test(String(reply[0]?.body)), "with the price-list price");
    check(back.some((c) => c.kind === "anthropic" && c.fromCall === true && c.sawCallSummary === true), "the model was told about the earlier call");
    setMark();
    // A discount ask from Casey stays pending (for the Approvals card screenshot).
    await text(CASEY.phone, dana.catcher!, "Could you do it for $600?");
    approvalPendingForShots = true;
    setMark();
    // Retell register failure → the voicemail greeting.
    await fakeControl({ retellRegisterFail: true });
    const failed = await call("+17055550178", dana.catcher!, dana.phone);
    await fakeControl({ retellRegisterFail: false });
    console.log(`   TwiML (register failed): ${failed.twiml.replace(/\s+/g, " ").slice(0, 200)}`);
    check(/<Record/.test(failed.twiml) && !/<Dial/.test(failed.twiml), "register failure → greeting + <Record> voicemail");
    await drain();
    const fb = sinceMark();
    const textBack = smsTo(fb, "+17055550178");
    check(textBack.length === 1, `that caller gets the normal missed-call text-back (${textBack.length}): "${textBack[0]?.body}"`);
    setMark();
  });

  await step("7. minutes used up → voicemail + ONE owner notice", async () => {
    const { data: c } = await admin.from("companies").select("ai_settings").eq("id", dana.companyId!).single();
    const ai = (c?.ai_settings ?? {}) as Record<string, Record<string, unknown>>;
    await admin.from("companies").update({ ai_settings: { ...ai, call_answering: { ...(ai.call_answering ?? {}), included_minutes: 1 } } }).eq("id", dana.companyId!);
    const first = await call("+17055550179", dana.catcher!, dana.phone);
    check(/<Record/.test(first.twiml) && !/<Dial/.test(first.twiml), "voicemail TwiML once minutes are used up");
    await drain();
    const second = await call("+17055550180", dana.catcher!, dana.phone);
    check(/<Record/.test(second.twiml), "second call → voicemail too");
    await drain();
    const got = sinceMark();
    const notices = smsTo(got, dana.phone).filter((m) => /minutes/i.test(String(m.body)) && /used up/i.test(String(m.body)));
    check(notices.length === 1, `exactly ONE owner notice (${notices.length}): "${notices[0]?.body}"`);
    const { data: rows } = await admin.from("call_answering_notices").select("*").eq("company_id", dana.companyId!);
    check((rows ?? []).length === 1, "one call_answering_notices claim");
    setMark();
  });

  await step("S1. screenshots: inbox thread, Approvals card, AI front desk settings (1280 + 390)", async () => {
    for (const width of [1280, 390]) {
      const ctx = await context(width);
      const page = await signIn(ctx, dana.email);
      await page.goto(`${BUYER_APP}/inbox`);
      await page.getByText("Casey Morgan").first().waitFor({ timeout: 30_000 }).catch(() => undefined);
      await page.waitForTimeout(1000);
      const row = page.getByText("Casey Morgan").first();
      if (await row.count()) await row.click();
      await page.getByText(/Take over|Let AI handle it/).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
      await page.waitForTimeout(1500);
      await shot(page, `p1-inbox-thread-casey-${width}`);
      const body = await page.locator("body").innerText();
      check(/Assistant/.test(body), `inbox (${width}): Assistant labels`);
      check(/Take over|Let AI handle it/.test(body), `inbox (${width}): Take over toggle`);
      const jamie = page.getByText("Jamie Lee").first();
      if (await jamie.count()) {
        await jamie.click();
        await page.waitForTimeout(3000);
        await shot(page, `p1-inbox-thread-jamie-${width}`);
      }
      await page.goto(`${BUYER_APP}/`);
      await page.getByText("Weekly report").first().waitFor({ timeout: 30_000 }).catch(() => undefined);
      await page.waitForTimeout(8000);
      const card = page.getByText("Approvals", { exact: false }).first();
      if (await card.count()) await card.scrollIntoViewIfNeeded();
      await shot(page, `p1-dashboard-approvals-${width}`, true);
      const dash = await page.locator("body").innerText();
      check(!approvalPendingForShots || /Approve/.test(dash), `dashboard (${width}): Approvals card with Approve / Skip`);
      check(!/Marina/.test(dash), `dashboard (${width}): no "Marina" for a CrankLeads owner`);
      await page.goto(`${BUYER_APP}/settings`);
      await page.waitForTimeout(2500);
      await page.locator("button", { hasText: "AI front desk" }).first().click();
      await page.getByText(/AI call minutes in/).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
      await page.getByText("Send a test to me").first().waitFor({ timeout: 30_000 }).catch(() => undefined);
      await page.waitForTimeout(1000);
      await shot(page, `p1-settings-ai-front-desk-${width}`);
      const settings = await page.locator("body").innerText();
      check(/Text conversations/.test(settings) && /Phone answering/.test(settings) && /Weekly report/.test(settings), `settings (${width}): Text conversations / Phone answering / Weekly report`);
      check(/AI call minutes in/.test(settings) && !/Couldn't load/.test(settings), `settings (${width}): every section loaded (minutes bar shown)`);
      check(!/empire\s*vu/i.test(settings), `settings (${width}): no EmpireVu`);
      check(!/Marina/.test(settings), `settings (${width}): no "Marina" (AI receptionist)`);
      check(/Your cell for owner texts/.test(settings) && /Confirmed/.test(settings), `settings (${width}): owner's cell shown as confirmed (provisioned = verified)`);
      await ctx.close();
    }
  });

  await step("8. Monday 08:00 local → weekly report SMS (≤2 segments) + email with real numbers; a second run sends nothing", async () => {
    // Next Monday 08:05 Toronto.
    const now = Date.now();
    let target = 0;
    for (let d = 1; d <= 7; d++) {
      const day = new Date(now + d * 86_400_000);
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(day).map((p) => [p.type, p.value]));
      if (parts.weekday === "Mon") {
        const offset = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`).toLocaleString("en-US", { timeZone: TZ, timeZoneName: "shortOffset" }).match(/GMT([+-]\d+)/)?.[1] ?? "-4";
        target = Date.parse(`${parts.year}-${parts.month}-${parts.day}T08:05:00${offset.startsWith("-") ? "-" : "+"}${String(Math.abs(Number(offset))).padStart(2, "0")}:00`);
        break;
      }
    }
    await advanceClock(Math.ceil((target - Date.now()) / 60_000));
    setMark();
    await runScheduler(admin, { workerId: "e2e-worker" });
    await sleep(3000);
    resetWeeklyReportThrottle();
    await processWeeklyReports(admin, Date.now());
    await drain();
    const got = sinceMark();
    const sms = smsTo(got, dana.phone).filter((m) => /weekly report/i.test(String(m.body)));
    check(sms.length === 1 && sms[0].from === PLATFORM, `one weekly report text from the platform number (${sms.length})`);
    console.log(`   SMS: ${String(sms[0]?.body).replace(/\n/g, " | ")}`);
    check(sms[0] && smsSegments(String(sms[0].body)).segments <= 2, `≤ 2 segments (${sms[0] ? smsSegments(String(sms[0].body)).segments : "?"})`);
    const email = got.filter((c) => c.kind === "email" && String(c.to).toLowerCase() === dana.email && /front desk/i.test(String(c.subject)));
    check(email.length === 1, `one weekly report email: "${email[0]?.subject}"`);
    const { data: send } = await admin.from("weekly_report_sends").select("status, metrics, channels").eq("company_id", dana.companyId!).maybeSingle();
    const m = send?.metrics as Record<string, unknown> | null;
    console.log(`   metrics: ${JSON.stringify(m).slice(0, 500)}`);
    check(send?.status === "sent", `weekly_report_sends sent (${send?.status})`);
    check(Number(m?.textConversations) >= 2 && Number(m?.textReplies) >= 4, `AI texts counted (conversations ${m?.textConversations}, texts ${m?.textReplies})`);
    check(Number((m?.calls as Record<string, number>)?.answered) >= 1, `calls answered ${(m?.calls as Record<string, number>)?.answered}`);
    check(Number((m?.approvals as Record<string, number>)?.asked) >= 2, `approvals asked ${(m?.approvals as Record<string, number>)?.asked}`);
    check(Number((m?.quotes as Record<string, number>)?.sent) >= 1, `quotes sent ${(m?.quotes as Record<string, number>)?.sent}`);
    check(!/empire\s*vu/i.test(`${sms[0]?.body} ${email[0]?.subject} ${email[0]?.body}`), "no EmpireVu");
    setMark();
    resetWeeklyReportThrottle();
    await processWeeklyReports(admin, Date.now());
    const again = sinceMark().filter((c) => (c.kind === "sms" && c.to === dana.phone) || (c.kind === "email" && String(c.to).toLowerCase() === dana.email));
    check(again.length === 0, `second run sends nothing (${again.length})`);
    // The weekly report page.
    for (const width of [1280, 390]) {
      const ctx = await context(width);
      const page = await signIn(ctx, dana.email);
      await page.goto(`${BUYER_APP}/reports/weekly`);
      await page.waitForTimeout(6000);
      await shot(page, `p1-weekly-report-${width}`);
      const body = await page.locator("body").innerText();
      check(/text conversations/i.test(body) && !/empire\s*vu/i.test(body), `weekly page (${width}) renders`);
      await ctx.close();
    }
    setMark();
  });

  await step("9. house (non-CrankLeads) org: no AI reply to a customer text; the catcher keeps voicemail", async () => {
    if (!houseIds) throw new Error("no house tenant");
    await text(HOUSE.customer, HOUSE.catcher, "Hi, are you open Saturday?");
    const got = sinceMark();
    check(smsTo(got, HOUSE.customer).length === 0, "no AI reply to the house org's customer");
    check(got.filter((c) => c.kind === "anthropic" && c.purpose === "sms_agent").length === 0, "no model call");
    const { data: ai } = await admin.from("message_log").select("id").eq("organization_id", houseIds.orgId).eq("sent_by", "sms_agent");
    check((ai ?? []).length === 0, "no sms_agent messages for the house org");
    const { twiml } = await call("+17055550191", HOUSE.catcher, HOUSE.owner);
    check(/<Record/.test(twiml) && !/<Dial/.test(twiml), "house catcher call → greeting + voicemail (no AI)");
    await drain();
    setMark();
  });

  // ── timeline ───────────────────────────────────────────────────────────────
  const names = new Map<string, string>([
    [dana.phone, "owner"],
    [JAMIE.phone, "Jamie"],
    [CASEY.phone, "Casey"],
    [PLATFORM, "platform"],
    [dana.catcher ?? "", "company#"],
    [HOUSE.catcher, "house#"],
    [HOUSE.customer, "house cust"],
    [dana.email, "owner email"],
  ]);
  const label = (v: unknown) => names.get(String(v)) ?? String(v);
  console.log("\n── Message timeline (Toronto time · channel · from → to · first line)");
  const all = captured();
  const startIdx = all.findIndex((c) => c.kind === "sms" && c.to === JAMIE.phone);
  for (const c of all.slice(Math.max(0, startIdx - 1))) {
    if (c.kind !== "sms" && c.kind !== "email") continue;
    const first = c.kind === "sms" ? String(c.body).split("\n")[0] : `${c.subject}`;
    console.log(`   ${torontoTime(Date.parse(c.t))}  ${c.kind.padEnd(5)}  ${label(c.from ?? "resend").padEnd(9)} → ${label(c.to).padEnd(11)}  ${first.slice(0, 120)}`);
  }
  const unhandled = all.filter((c) => c.kind === "unhandled");
  if (unhandled.length) console.log(`\n── Unhandled third-party calls: ${JSON.stringify(unhandled).slice(0, 1000)}`);
  console.log("\n── Summary");
  for (const r of results) console.log(`   ${r.ok ? "PASS" : "FAIL"}  ${r.step}`);
  console.log(`\nScreenshots:\n${shots.map((s) => `   ${s}`).join("\n")}`);
  writeFileSync(join(SHOTS, "frontdesk-results.json"), JSON.stringify({ results, shots }, null, 2));
  await browser.close();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await browser?.close().catch(() => undefined);
  process.exit(2);
});
