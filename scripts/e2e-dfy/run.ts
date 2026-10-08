/**
 * Done-for-you CrankLeads, end to end, as a buyer would experience it (scripts/e2e-dfy/README.md).
 * Real local Postgres + PostgREST + Next dev + Vite dev; only third parties are fake (fakes.mjs).
 * Run through scripts/e2e-dfy/run.sh (it starts the stack and puts this process on the fake clock).
 */
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import Stripe from "stripe";

import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createCrankleadsCheckout } from "@/server/services/crankleads/checkout";
import { claimBillingEventJobs } from "@/server/services/billing/jobs";
import { processBillingEventJob } from "@/server/services/billing/events";
import { processPendingEnrichments } from "@/server/services/dfy/enrich";
import { processDoneForYou } from "@/server/services/dfy/orchestrator";
import { generatePendingSites, notifyPublishedSites } from "@/server/services/dfy/site-generator";
import { processPendingIntakeSends } from "@/server/services/dfy/intake";
import { processSetupFollowups } from "@/server/services/crankleads/setup-followups";
import { processInboundWebhookJobs } from "@/server/services/inbound-webhook-jobs";
import { runScheduler } from "@/server/services/workflow-engine/scheduler";
import { claimWorkflowEventJobs, processWorkflowEventJob } from "@/server/services/workflow-event-jobs";

type Admin = ReturnType<typeof createSupabaseAdminClient>;

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
};
const BUYER_APP = env("CRANKLEADS_APP_BASE_URL");
const HOUSE_APP = env("APP_BASE_URL");
const CAPTURE = env("E2E_CAPTURE_LOG");
const SHOTS = env("E2E_SHOTS");
const CLOCK_FILE = env("E2E_CLOCK_FILE");
const OPERATOR = env("OWNER_EMAIL");
const PASSWORD = "e2e-password-123";
const CHROME = process.env.E2E_CHROME ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const FAKES = `http://127.0.0.1:${env("E2E_FAKES_PORT")}`;
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";

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

// ── fake clock (libfaketime offset file shared by every process) ─────────────
function clockOffsetMinutes(): number {
  const raw = readFileSync(CLOCK_FILE, "utf8").trim();
  return Number(raw.replace(/m$/, ""));
}
async function advanceClock(minutes: number): Promise<void> {
  const next = clockOffsetMinutes() + minutes;
  writeFileSync(CLOCK_FILE, `${next >= 0 ? "+" : ""}${next}m\n`);
  await sleep(2200); // libfaketime re-reads the file at most once a second per process
  console.log(`   clock +${minutes} min → ${new Date().toISOString()} (${torontoTime(Date.now())} Toronto)`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const torontoTime = (ms: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);

// ── captured third-party traffic ─────────────────────────────────────────────
interface Captured {
  t: string;
  kind: string;
  to?: string;
  from?: string;
  body?: string;
  subject?: string;
  html?: string | null;
  [k: string]: unknown;
}
function captured(): Captured[] {
  return readFileSync(CAPTURE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Captured);
}
function messagesFor(buyer: { phone: string; email: string }): Captured[] {
  return captured().filter(
    (c) => (c.kind === "sms" && c.to === buyer.phone) || (c.kind === "email" && String(c.to).toLowerCase() === buyer.email.toLowerCase()),
  );
}
const operatorEmails = () => captured().filter((c) => c.kind === "email" && String(c.to).toLowerCase() === OPERATOR.toLowerCase());
const linkIn = (text: string | undefined, path: string): string | null => {
  const m = String(text ?? "").match(new RegExp(`https?://[^\\s"'<>]+${path}[^\\s"'<>)]*`));
  return m ? m[0].replace(/[.,]$/, "") : null;
};

// ── scheduler passes (what the workflow worker's runScheduler → runDoneForYouPasses does) ──
/** The workflow worker's queue drain (workflow events + inbound webhooks), as its loop does. */
async function drainQueues(): Promise<number> {
  let n = 0;
  for (let i = 0; i < 5; i++) {
    const jobs = await claimWorkflowEventJobs(admin, { limit: 20, staleAfterSeconds: 900, workerId: "e2e-worker" });
    for (const job of jobs) await processWorkflowEventJob(admin, job).catch((e) => console.log("   workflow job error", e instanceof Error ? e.message : e));
    const inbound = await processInboundWebhookJobs(admin, { batch: 20, staleAfterSeconds: 900, workerId: "e2e-worker" });
    n += jobs.length + inbound;
    if (jobs.length === 0 && inbound === 0) break;
  }
  return n;
}

async function passes(label: string): Promise<void> {
  await drainQueues();
  const now = Date.now();
  const sends = await processPendingIntakeSends(admin, { nowMs: now });
  const enrich = await processPendingEnrichments(admin, { nowMs: now });
  const dfy = await processDoneForYou(admin, now);
  const sites = await generatePendingSites(admin);
  const notified = await notifyPublishedSites(admin);
  const follow = await processSetupFollowups(admin, now);
  const drained = await drainQueues();
  console.log(
    `   pass[${label}] jobs=${drained} sends=${JSON.stringify(sends)} enrich=${JSON.stringify(enrich)} dfy=${JSON.stringify(dfy.map((r) => ({ steps: r.steps, skipped: r.skipped, error: r.error })))} sites=${JSON.stringify(sites)} notified=${JSON.stringify(notified)} followups=${JSON.stringify(follow.map((f) => `${f.action}:${f.reason ?? ""}`))}`,
  );
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
}

function fakeStripe(): Stripe {
  let n = 0;
  return {
    checkout: {
      sessions: {
        create: async () => {
          n += 1;
          const id = `cs_test_e2e_${Date.now().toString(36)}${n}`;
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
  const metadata = {
    source: "crankleads",
    purchaseId: checkout.purchaseId,
    tier: buyer.tier,
    plan: buyer.tier === "front_desk" ? "growth" : "starter",
    businessName: buyer.businessName,
    businessType: buyer.businessType,
    ownerName: buyer.name,
    ownerPhone: buyer.phone,
    utm: "{}",
  };
  const event = {
    id: `evt_e2e_${suffix}`,
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
        customer: `cus_e2e_${suffix}`,
        subscription: `sub_e2e_${suffix}`,
        customer_email: buyer.email,
        customer_details: { email: buyer.email, name: buyer.name, phone: buyer.phone },
        client_reference_id: checkout.purchaseId,
        metadata,
      },
    },
  };
  const payload = JSON.stringify(event);
  const header = new Stripe(env("STRIPE_SECRET_KEY")).webhooks.generateTestHeaderString({ payload, secret: env("STRIPE_WEBHOOK_SECRET") });
  const res = await fetch(`${HOUSE_APP}/api/webhooks/stripe`, { method: "POST", headers: { "stripe-signature": header, "content-type": "application/json" }, body: payload });
  check(res.status === 200, `Stripe webhook accepted the signed checkout.session.completed (${res.status})`);
  // The billing worker's loop body.
  for (let i = 0; i < 3; i++) {
    const jobs = await claimBillingEventJobs(admin, { limit: 10, staleAfterSeconds: 900, workerId: "e2e-billing" });
    for (const job of jobs) await processBillingEventJob(admin, job).catch((e) => console.log("   billing job error", e));
    if (jobs.length === 0) break;
  }
  const { data: purchase } = await admin.from("crankleads_purchases").select("*").eq("id", checkout.purchaseId).single();
  buyer.orgId = purchase?.organization_id ?? undefined;
  buyer.companyId = purchase?.company_id ?? undefined;
  check(purchase?.status === "provisioned", `purchase provisioned (status=${purchase?.status}, error=${purchase?.last_error ?? "-"})`);
}

// ── browser helpers ──────────────────────────────────────────────────────────
let browser: Browser;
async function mobileContext(ua = IPHONE_UA, width = 390): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: ua, locale: "en-CA", timezoneId: "America/Toronto" });
  await routeFakeWebsite(ctx);
  return ctx;
}
async function desktopContext(): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "en-CA", timezoneId: "America/Toronto" });
  await routeFakeWebsite(ctx);
  return ctx;
}
async function routeFakeWebsite(ctx: BrowserContext): Promise<void> {
  // The browser runs on real time; give its pages the harness clock ("2 min ago" etc. agree).
  await ctx.clock.install({ time: Date.now() });
  // No internet for the browser: fail font requests fast instead of hanging the "load" event.
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await ctx.route(/https:\/\/(www\.)?northshoresnow\.ca\/.*/, async (route) => {
    const url = new URL(route.request().url());
    const res = await fetch(`${FAKES}/northshoresnow.ca${url.pathname}`, { headers: { "x-e2e-host": "northshoresnow.ca" } });
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
  });
}
async function signIn(ctx: BrowserContext, base: string, email: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`${base}/signin`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"), { timeout: 30_000 });
  return page;
}
/** What a buyer can see: body text, the tab title, icons and the share/meta tags. */
async function visibleBrandText(page: Page): Promise<string> {
  return page.evaluate(() =>
    [
      document.body.innerText,
      document.title,
      ...Array.from(document.querySelectorAll("meta[content]")).map((m) => m.getAttribute("content") ?? ""),
      ...Array.from(document.querySelectorAll('link[rel~="icon"]')).map((l) => l.getAttribute("href") ?? ""),
      ...Array.from(document.querySelectorAll("img[alt]")).map((i) => i.getAttribute("alt") ?? ""),
    ].join("\n"),
  );
}
function noEmpireVu(text: string): boolean {
  const hit = text.match(/.{0,60}empire\s*vu.{0,60}/i);
  if (hit) console.log(`   EmpireVu seen: …${hit[0]}…`);
  return !hit;
}

// ── Twilio webhook signing (what Twilio does) ────────────────────────────────
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

// ════════════════════════════════════════════════════════════════════════════
const dana: Buyer = {
  name: "Dana Whitfield",
  email: "dana@northshoresnow.ca",
  phone: "+17055550142",
  businessName: "Northshore Snow & Lawn",
  businessType: "Property maintenance & snow",
  tier: "close",
};
const ravi: Buyer = {
  name: "Ravi Mehta",
  email: "ravi@bayviewroofing.ca",
  phone: "+17055550188",
  businessName: "Bayview Roofing",
  businessType: "Roofing",
  tier: "catch",
};
let house: { orgId: string; companyId: string; snapshot: string } | null = null;
let siteSlug: string | null = null;
let forwardUrl: string | null = null;

async function seedHouseTenant(): Promise<void> {
  const { data: org, error } = await admin
    .from("organizations")
    .insert({ name: "A1 Group (house)", slug: "a1-group-house", subscription_status: "active" })
    .select("id")
    .single();
  if (error) throw new Error(`house org: ${error.message}`);
  const { data: company, error: cErr } = await admin
    .from("companies")
    .insert({ organization_id: org.id, name: "A1 Marine Care", slug: "a1-marine-care", timezone: "America/Toronto", owner_phone_e164: "+17055550111", owner_email: "owner@a1.test" })
    .select("id")
    .single();
  if (cErr) throw new Error(`house company: ${cErr.message}`);
  house = { orgId: org.id, companyId: company.id, snapshot: await houseSnapshot(org.id, company.id) };
}
async function houseSnapshot(orgId: string, companyId: string): Promise<string> {
  const [{ data: c }, { data: o }, { count: sites }, { count: intakes }, { count: progress }, { count: workflows }] = await Promise.all([
    admin.from("companies").select("*").eq("id", companyId).single(),
    admin.from("organizations").select("*").eq("id", orgId).single(),
    admin.from("company_sites").select("id", { count: "exact", head: true }).eq("company_id", companyId),
    admin.from("setup_intakes").select("id", { count: "exact", head: true }).eq("company_id", companyId),
    admin.from("dfy_progress").select("id", { count: "exact", head: true }).eq("company_id", companyId),
    admin.from("workflows").select("id", { count: "exact", head: true }).eq("organization_id", orgId),
  ]);
  return JSON.stringify({ c, o, sites, intakes, progress, workflows });
}

async function main(): Promise<void> {
  browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--no-proxy-server"],
    // This process runs under libfaketime; the browser must not (its network stack stalls).
    env: { ...process.env, LD_PRELOAD: "", FAKETIME_TIMESTAMP_FILE: "" },
  });
  // Warm Vite (its first load optimises dependencies and reloads the page).
  {
    const warm = await (await browser.newContext()).newPage();
    await warm.goto(`${BUYER_APP}/signin`, { timeout: 180_000 }).catch(() => undefined);
    await warm.waitForTimeout(5000);
    await warm.context().close();
  }
  console.log(`clock now ${new Date().toISOString()} (${torontoTime(Date.now())} Toronto)`);

  await step("0. seed a non-CrankLeads house tenant", seedHouseTenant);

  // ── 1 + 2 ──────────────────────────────────────────────────────────────────
  await step("1. paid CrankLeads Close purchase (signed Stripe webhook → billing worker)", async () => {
    await buy(dana);
  });

  await step("2. org/company, number (705), welcome email + quick-setup SMS, no EmpireVu", async () => {
    const { data: org } = await admin.from("organizations").select("*").eq("id", dana.orgId!).single();
    check(org?.platform_brand === "crankleads", `organizations.platform_brand = crankleads (${org?.platform_brand})`);
    check(org?.crankleads_tier === "close", `crankleads_tier = close (${org?.crankleads_tier})`);
    const { data: company } = await admin.from("companies").select("*").eq("id", dana.companyId!).single();
    check(company?.name === dana.businessName, `company "${company?.name}"`);
    const { data: numbers } = await admin.from("voice_numbers").select("phone_e164, provider, mode").eq("company_id", dana.companyId!);
    const catcher = (numbers ?? []).find((n) => n.mode === "missed_call_catcher");
    check(catcher && catcher.phone_e164.startsWith("+1705"), `text-back number bought in 705 (${catcher?.phone_e164 ?? "none"})`);
    const msgs = messagesFor(dana);
    const welcome = msgs.find((m) => m.kind === "email" && /welcome|you're in|setting/i.test(String(m.subject)));
    check(welcome, `welcome email captured ("${welcome?.subject}")`);
    const setupSms = msgs.find((m) => m.kind === "sms" && /\/setup\//.test(String(m.body)));
    check(setupSms, `quick-setup SMS captured: "${setupSms?.body}"`);
    check(setupSms?.from === env("TWILIO_FROM_NUMBER"), `quick-setup SMS from the platform number (${setupSms?.from})`);
    const setupLink = linkIn(setupSms?.body, "/setup/");
    check(setupLink?.startsWith(BUYER_APP), `setup link on the CrankLeads host (${setupLink})`);
    for (const m of msgs) check(noEmpireVu(`${m.subject ?? ""}\n${m.body ?? ""}\n${m.html ?? ""}`), `no "EmpireVu" in ${m.kind} "${(m.subject ?? m.body ?? "").slice(0, 50)}"`);
  });

  // ── 3 ──────────────────────────────────────────────────────────────────────
  await step("3. quick setup page (390px): search, pick, cell + Bell, one price, submit", async () => {
    const sms = messagesFor(dana).find((m) => m.kind === "sms" && /\/setup\//.test(String(m.body)));
    const link = linkIn(sms?.body, "/setup/");
    if (!link) throw new Error("no setup link");
    const ctx = await mobileContext(IPHONE_UA);
    const page = await ctx.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (m) => m.type() === "error" && !/ERR_FAILED|ERR_TUNNEL|fonts/.test(m.text()) && consoleErrors.push(m.text()));
    await page.goto(link);
    await page.waitForSelector('[data-testid="setup-form"]', { timeout: 60_000 });
    await shot(page, "03a-setup-open");
    check(noEmpireVu(await visibleBrandText(page)), "setup page never says EmpireVu (text, title, meta)");
    await page.fill("#setup-place-search", "Northshore Snow Midland");
    await page.waitForSelector('[data-testid="place-results"] button', { timeout: 20_000 });
    await shot(page, "03b-setup-search-results");
    await page.click('[data-testid="place-results"] button:has-text("Northshore Snow & Lawn")');
    await page.waitForSelector('[data-testid="picked-place"]');
    const phoneValue = await page.inputValue("#setup-phone");
    check(/705/.test(phoneValue), `business phone prefilled from checkout (${phoneValue})`);
    await page.click('[role="radiogroup"][aria-label="Kind of line"] button:has-text("Cell")');
    await page.selectOption("#setup-carrier", { label: "Bell" });
    await shot(page, "03c-setup-picked-cell-bell");
    const priceBox = page.locator('input[aria-label^="Price for Seasonal snow contract — residential"]');
    check((await priceBox.count()) === 1, "pack service 'Seasonal snow contract — residential driveway' is pre-listed with a price box");
    await priceBox.fill("650");
    await shot(page, "03d-setup-price-entered");
    await page.click('button:has-text("Done — set it up for me")');
    await page.waitForSelector('h1:has-text("Done.")', { timeout: 30_000 });
    await shot(page, "03e-setup-done");
    check(consoleErrors.length === 0, `no console errors on the setup page (${consoleErrors.slice(0, 3).join(" | ")})`);
    const { data: intake } = await admin.from("setup_intakes").select("status, answers").eq("company_id", dana.companyId!).single();
    check(intake?.status === "submitted", `setup_intakes.status = submitted (${intake?.status})`);
    await ctx.close();
  });

  // ── 4 ──────────────────────────────────────────────────────────────────────
  await step("4. scheduler passes: enrichment → switch-on → page; facts, automations, booking hours, site", async () => {
    // One real scheduler tick (proves the wiring), then the passes it runs, awaited.
    await runScheduler(admin, { workerId: "e2e-worker" });
    await sleep(3000); // runScheduler starts enrichment without awaiting it
    for (let i = 0; i < 3; i++) await passes(`dana-${i}`);
    const { data: intake } = await admin.from("setup_intakes").select("status, enrichment, last_error").eq("company_id", dana.companyId!).single();
    check(intake?.status === "enriched", `intake enriched (${intake?.status} ${intake?.last_error ?? ""})`);
    const { data: c } = await admin.from("companies").select("*").eq("id", dana.companyId!).single();
    check(c?.website?.includes("northshoresnow.ca"), `website ${c?.website}`);
    const hours = c?.hours as { summary?: string } | null;
    check(/Monday/.test(hours?.summary ?? ""), `hours from Google (${hours?.summary?.slice(0, 60)}…)`);
    check(c?.service_area === "Midland and surrounding area", `service area "${c?.service_area}"`);
    check(Number(c?.google_rating) === 4.8 && c?.google_review_count === 37, `rating ${c?.google_rating} (${c?.google_review_count})`);
    check(c?.brand_review_url?.includes("writereview"), `review link ${c?.brand_review_url}`);
    check(c?.brand_logo_url === "https://northshoresnow.ca/logo.png", `logo ${c?.brand_logo_url}`);
    check(c?.business_phone_kind === "cell" && c?.business_phone_carrier === "bell", `line ${c?.business_phone_kind}/${c?.business_phone_carrier}`);
    const { data: items } = await admin
      .from("service_catalog_items")
      .select("label, rate_cents, active, service_key")
      .eq("company_id", dana.companyId!);
    const priced = (items ?? []).filter((i) => i.rate_cents);
    console.log(`   priced services: ${priced.map((i) => `${i.label}=$${(i.rate_cents ?? 0) / 100}${i.active ? "" : " (off)"}`).join(", ")}`);
    check(priced.some((i) => /seasonal snow contract — residential/i.test(i.label) && i.rate_cents === 65000 && i.active), "owner price $650 on the seasonal residential contract (active)");
    check(priced.some((i) => /spring cleanup/i.test(i.label) && i.rate_cents === 25000), "website-stated $250 spring cleanup applied");
    check(priced.length === 2, `exactly 2 priced services — nothing invented (${priced.length})`);
    const { data: progress } = await admin.from("dfy_progress").select("*").eq("company_id", dana.companyId!).single();
    check(progress?.switched_on_at, `switched on at ${progress?.switched_on_at}`);
    const { data: wfs } = await admin.from("workflows").select("name, status, slug").eq("organization_id", dana.orgId!);
    const active = (wfs ?? []).filter((w) => w.status === "active");
    console.log(`   workflows: ${(wfs ?? []).map((w) => `${w.slug}:${w.status}`).join(", ")}`);
    check(active.some((w) => /missed-call|text-back/i.test(`${w.slug} ${w.name}`)), "missed-call text-back automation active");
    check(active.length >= 3, `${active.length} automations active`);
    const { data: booking } = await admin.from("companies").select("online_booking_settings").eq("id", dana.companyId!).single();
    console.log(`   booking settings: ${JSON.stringify(booking?.online_booking_settings).slice(0, 300)}`);
    const detail = progress?.switch_on_detail as Record<string, unknown> | null;
    console.log(`   switch_on_detail: ${JSON.stringify(detail).slice(0, 400)}`);
    check(detail?.booking === "hours_set", `switch-on set online-booking hours from Google hours (${String(detail?.booking)})`);
    const bk = booking?.online_booking_settings as { startHour?: number; endHour?: number; workingDays?: number[] } | null;
    check(bk?.startHour === 7 && bk?.endHour === 18 && bk?.workingDays?.join(",") === "1,2,3,4,5,6", `booking hours 7–18 Mon–Sat (${JSON.stringify(bk)})`);
    const { data: site } = await admin.from("company_sites").select("*").eq("company_id", dana.companyId!).single();
    check(site?.status === "published", `site ${site?.slug} ${site?.status} (${site?.mode})`);
    check(site?.mode === "price_page", `site mode price_page (they have a website) (${site?.mode})`);
    siteSlug = site?.slug ?? null;
    const content = site?.content as { copySource?: string } | null;
    check(content?.copySource === "ai", `copy written by (fake) Claude, kept after screening (${content?.copySource})`);
    const fwd = messagesFor(dana).find((m) => m.kind === "sms" && /\/forward\//.test(String(m.body)));
    check(fwd, `forwarding text sent: "${fwd?.body}"`);
    forwardUrl = linkIn(fwd?.body, "/forward/");
  });

  await step("4b. owner signs in while we're setting up: progress view (1280 + 390)", async () => {
    for (const [ctx, label] of [[await desktopContext(), "1280"], [await mobileContext(IPHONE_UA), "390"]] as const) {
      const page = await signIn(ctx, BUYER_APP, dana.email);
      await page.goto(`${BUYER_APP}/`);
      const card = page.locator('[data-testid="setup-progress-card"]');
      await card.waitFor({ timeout: 30_000 });
      await page.waitForTimeout(1500);
      await shot(page, `04d-owner-dashboard-card-${label}`, false);
      check(/One thing left for you: turn on call forwarding/.test(await card.innerText()), `dashboard card (${label}): "${(await card.innerText()).replace(/\s+/g, " ")}"`);
      await card.locator("button").click();
      await page.waitForURL(/\/onboarding/, { timeout: 15_000 });
      await page.waitForTimeout(5000);
      await shot(page, `04e-owner-progress-${label}`);
      const text = await visibleBrandText(page);
      check(noEmpireVu(text), `progress view (${label}) never says EmpireVu`);
      check(/forward/i.test(text), `progress view (${label}) shows the one thing left: call forwarding`);
      check(!/step \d+ of \d+/i.test(text), `no wizard steps (${label})`);
      await ctx.close();
    }
  });

  await step("4c. hosted page /s/<slug> (390 + 1280) and its quote form → lead in CRM", async () => {
    if (!siteSlug) throw new Error("no site");
    const url = `${BUYER_APP}/s/${siteSlug}`;
    const raw = await fetch(url);
    const html = await raw.text();
    check(raw.status === 200, `GET /s/${siteSlug} → ${raw.status}`);
    check(noEmpireVu(html), "page never says EmpireVu");
    check(/Site by CrankLeads/i.test(html), "footer credit 'Site by CrankLeads'");
    check(/\$650/.test(html) && /\$250/.test(html), "both real prices on the page");
    check(/Mon–Fri: 7am–6pm/.test(html) && /openingHoursSpecification/.test(html), "hours as per-day lines + openingHoursSpecification");
    check(!/aggregateRating/.test(html), "no aggregateRating in JSON-LD");
    const mctx = await mobileContext(IPHONE_UA);
    const m = await mctx.newPage();
    await m.goto(url);
    await shot(m, "04a-site-390");
    const dctx = await desktopContext();
    const d = await dctx.newPage();
    await d.goto(url);
    await shot(d, "04b-site-1280");
    // Quote form, as a homeowner would (the form enforces a minimum fill time).
    await m.waitForTimeout(3500);
    const form = m.locator("#quote-form");
    check((await form.count()) === 1, "quote form present");
    await form.locator('input[name="name"]').fill("Pat Homeowner");
    await form.locator('input[name="phone"]').fill("705-555-0199");
    const email = form.locator('input[name="email"]');
    if (await email.count()) await email.fill("pat.homeowner@example.ca");
    const msg = form.locator("textarea");
    if (await msg.count()) await msg.first().fill("Need a quote for a seasonal driveway plowing contract on Yonge St.");
    await form.locator('button[type="submit"]').click();
    await m.waitForTimeout(3000);
    await shot(m, "04c-site-quote-sent-390", false);
    const { data: contacts } = await admin.from("contacts").select("id, first_name, last_name, phone, email, stage, metadata, created_at").eq("company_id", dana.companyId!);
    const lead = (contacts ?? []).find((c) => /Pat/.test(c.first_name ?? ""));
    check(lead, `lead landed in the CRM (${JSON.stringify(lead)})`);
    await drainQueues();
    const alert = messagesFor(dana).filter((x) => /Pat/.test(String(x.body)));
    check(alert.length >= 1, `owner alerted about the new lead (${alert.map((a) => `${a.kind}: ${String(a.body).slice(0, 80)}`).join(" | ")})`);
    for (const a of alert) check(noEmpireVu(`${a.subject ?? ""} ${a.body}`), `lead alert never says EmpireVu`);
    await mctx.close();
    await dctx.close();
  });

  // ── 5 ──────────────────────────────────────────────────────────────────────
  await step("5. forwarding page (Android + iPhone), tap, auto test, forwarded leg → ONE You're live", async () => {
    if (!forwardUrl) throw new Error("no forwarding link");
    const actx = await mobileContext(ANDROID_UA, 390);
    const a = await actx.newPage();
    await a.goto(forwardUrl);
    await a.waitForSelector('[data-testid="forward-page"]', { timeout: 30_000 });
    await a.waitForTimeout(800);
    await shot(a, "05a-forward-android");
    const telHref = await a.locator('[data-testid="forward-android"] a').getAttribute("href");
    check(telHref?.startsWith("tel:**004*") && telHref.includes("%23"), `Android tel: link with the code (${telHref})`);
    const ictx = await mobileContext(IPHONE_UA, 390);
    const i = await ictx.newPage();
    await i.goto(forwardUrl);
    await i.waitForSelector('[data-testid="forward-ios"]', { timeout: 30_000 });
    await shot(i, "05b-forward-iphone");
    check(noEmpireVu(await visibleBrandText(i)), "forwarding page never says EmpireVu (text, title, meta)");
    // iPhone path: "I've done it — test it for me".
    await i.click('button:has-text("I\'ve done it")');
    await i.waitForTimeout(1500);
    await shot(i, "05c-forward-iphone-tapped");
    const { data: tapped } = await admin.from("dfy_progress").select("forward_tapped_at").eq("company_id", dana.companyId!).single();
    check(tapped?.forward_tapped_at, `forward_tapped_at stamped (${tapped?.forward_tapped_at})`);
    // ~45 s later the next sweep (or page poll) places ONE automatic test call.
    await advanceClock(1);
    await passes("after-tap");
    const call = captured().filter((c) => c.kind === "call" && c.to === dana.phone);
    check(call.length === 1, `exactly one automatic test call to the business line (${call.length})`);
    const { data: test } = await admin.from("forwarding_tests").select("*").eq("company_id", dana.companyId!).order("created_at", { ascending: false }).limit(1).single();
    check(test?.status === "calling", `forwarding test calling (${test?.status})`);
    // Twilio: the carrier forwards the unanswered test call to our catcher number → the
    // signed voice webhook, then the worker drains the inbound queue.
    const res = await postTwilio("/api/twilio/voice/inbound", {
      AccountSid: env("TWILIO_ACCOUNT_SID"),
      CallSid: `CA${"f".repeat(32)}`,
      From: test!.caller_id,
      To: test!.catcher_number,
      Called: test!.catcher_number,
      ForwardedFrom: dana.phone,
      CallStatus: "ringing",
      Direction: "inbound",
    });
    check(res.status === 200, `voice webhook accepted the forwarded leg (${res.status})`);
    await processInboundWebhookJobs(admin, { batch: 10, staleAfterSeconds: 900, workerId: "e2e-worker" });
    // Status callback for the outbound leg (no-answer at the business line, as forwarding does).
    await postTwilio(`/api/twilio/voice/forwarding-test?testId=${test!.id}&event=status`, {
      AccountSid: env("TWILIO_ACCOUNT_SID"),
      CallSid: test!.outbound_call_sid ?? "CA0",
      CallStatus: "no-answer",
    }).catch(() => undefined);
    await processInboundWebhookJobs(admin, { batch: 10, staleAfterSeconds: 900, workerId: "e2e-worker" });
    // Following sweeps must not send anything more.
    await advanceClock(6);
    await passes("after-pass-1");
    await advanceClock(6);
    await passes("after-pass-2");
    const { data: after } = await admin.from("forwarding_tests").select("status").eq("id", test!.id).single();
    check(after?.status === "passed", `forwarding test passed (${after?.status})`);
    const { data: purchase } = await admin.from("crankleads_purchases").select("live_at").eq("id", dana.purchaseId!).single();
    check(purchase?.live_at, `crankleads_purchases.live_at set (${purchase?.live_at})`);
    const msgs = messagesFor(dana);
    const liveSms = msgs.filter((x) => x.kind === "sms" && /you're live/i.test(String(x.body)));
    const liveEmail = msgs.filter((x) => x.kind === "email" && /you're live/i.test(String(x.subject)));
    check(liveSms.length === 1, `exactly ONE "You're live" text (${liveSms.length})`);
    check(liveEmail.length === 1, `exactly ONE "You're live" email (${liveEmail.length})`);
    check(liveSms[0] && String(liveSms[0].body).includes(`/s/${siteSlug}`), `live text carries the page link: "${liveSms[0]?.body}"`);
    check(liveEmail[0] && String(liveEmail[0].body).includes(`/s/${siteSlug}`), "live email carries the page link");
    check(!msgs.some((x) => /✅ text-back is live|text-back is live/i.test(String(x.body))), 'no "✅ text-back is live" duplicate');
    check(!msgs.some((x) => x.kind === "sms" && /^(CrankLeads: )?Your new page is live/i.test(String(x.body))), "no separate 'Your new page is live' text");
    await i.reload();
    await i.waitForSelector('[data-testid="forward-verified"]', { timeout: 30_000 }).catch(() => undefined);
    await shot(i, "05d-forward-iphone-verified");
    await actx.close();
    await ictx.close();
  });

  // ── 6 ──────────────────────────────────────────────────────────────────────
  await step("6. owner signs in: progress view + dashboard (1280), CrankLeads branding", async () => {
    const ctx = await desktopContext();
    const page = await signIn(ctx, BUYER_APP, dana.email);
    await page.goto(`${BUYER_APP}/onboarding`);
    await page.waitForTimeout(6000);
    await shot(page, "06a-owner-onboarding-after-live-1280");
    const progressText = await visibleBrandText(page);
    check(noEmpireVu(progressText), "progress view never says EmpireVu");
    check(!/step 1 of|Step \d of 8/i.test(progressText), "no 8-step wizard");
    await page.goto(`${BUYER_APP}/`);
    await page.waitForTimeout(9000);
    await shot(page, "06b-owner-dashboard-1280");
    const dash = await visibleBrandText(page);
    check(noEmpireVu(dash), "dashboard never says EmpireVu");
    check(/crankleads/i.test(await page.content()), "CrankLeads branding present");
    await ctx.close();
  });

  // ── 7 ──────────────────────────────────────────────────────────────────────
  await step("7. concierge: operator list + detail, rerun lookup + rebuild site via API, audit rows", async () => {
    const { data: created, error } = await admin.auth.admin.createUser({ email: OPERATOR, email_confirm: true, user_metadata: { full_name: "Marcus (operator)" } });
    if (error) throw error;
    const ctx = await desktopContext();
    const page = await signIn(ctx, HOUSE_APP, OPERATOR);
    await page.goto(`${HOUSE_APP}/concierge`);
    await page.waitForTimeout(4000);
    await shot(page, "07a-concierge-list-1280");
    check(/Northshore Snow/.test(await page.locator("body").innerText()), "list shows Northshore Snow & Lawn");
    await page.goto(`${HOUSE_APP}/concierge/${dana.orgId}`);
    await page.waitForTimeout(4000);
    await shot(page, "07b-concierge-detail-1280");
    // Actions via the API with the operator's session token (what the buttons send).
    const token = await page.evaluate(() => {
      const raw = document.cookie.split("; ").find((c) => c.startsWith("sb-"));
      return raw ?? null;
    });
    void token;
    const session = await (await fetch(`${env("NEXT_PUBLIC_SUPABASE_URL")}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: env("NEXT_PUBLIC_SUPABASE_ANON_KEY") },
      body: JSON.stringify({ email: OPERATOR, password: PASSWORD }),
    })).json() as { access_token: string };
    for (const action of ["rerun_business_lookup", "build_website"]) {
      const res = await fetch(`${HOUSE_APP}/api/concierge/accounts/${dana.orgId}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ action, input: {} }),
      });
      const body = await res.text();
      check(res.status === 200, `${action} → ${res.status} ${body.slice(0, 160)}`);
    }
    // Not an operator → 404.
    const { data: s2 } = await admin.auth.admin.listUsers();
    void s2;
    const ownerSession = await (await fetch(`${env("NEXT_PUBLIC_SUPABASE_URL")}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: env("NEXT_PUBLIC_SUPABASE_ANON_KEY") },
      body: JSON.stringify({ email: dana.email, password: PASSWORD }),
    })).json() as { access_token: string };
    const denied = await fetch(`${HOUSE_APP}/api/concierge/accounts`, { headers: { authorization: `Bearer ${ownerSession.access_token}` } });
    check(denied.status === 404, `a buyer gets 404 from the concierge API (${denied.status})`);
    const { data: audit } = await admin.from("operator_actions").select("operator_email, action, detail, company_id").eq("organization_id", dana.orgId!).order("created_at");
    console.log(`   audit: ${JSON.stringify(audit)}`.slice(0, 800));
    for (const action of ["rerun_business_lookup", "build_website"]) {
      const row = (audit ?? []).find((r) => r.action === action);
      check(row && row.operator_email === OPERATOR && (row.detail as { status?: string })?.status === "ok", `operator_actions row for ${action} (status ${(row?.detail as { status?: string })?.status})`);
    }
    await page.goto(`${HOUSE_APP}/concierge/${dana.orgId}`);
    await page.waitForTimeout(3000);
    await shot(page, "07c-concierge-detail-after-actions-1280");
    void created;
    await ctx.close();
  });

  // ── 8 ──────────────────────────────────────────────────────────────────────
  await step("8a. second buyer never answers: 2h fallback switch-on + site", async () => {
    await buy(ravi);
    await passes("ravi-0");
    const { data: p0 } = await admin.from("dfy_progress").select("switched_on_at").eq("company_id", ravi.companyId!).single();
    check(!p0?.switched_on_at, "not switched on before the 2h fallback");
    await advanceClock(125);
    await passes("ravi-2h");
    await passes("ravi-2h-b");
    const { data: p1 } = await admin.from("dfy_progress").select("switched_on_at, switch_on_detail, forward_text_sent_at").eq("company_id", ravi.companyId!).single();
    check(p1?.switched_on_at, `switched on after 2h without answers (${JSON.stringify(p1?.switch_on_detail).slice(0, 120)})`);
    const { data: site } = await admin.from("company_sites").select("slug, status, mode").eq("company_id", ravi.companyId!).maybeSingle();
    check(site?.status === "published", `site published (${site?.slug} ${site?.status} ${site?.mode})`);
    check(p1?.forward_text_sent_at, "forwarding text sent anyway");
  });

  await step("8b. still not live at 24h → exactly one operator escalation email", async () => {
    const isEscalation = (e: Captured, name: RegExp) => name.test(String(e.subject)) && /^Call /.test(String(e.subject));
    const before = operatorEmails().filter((e) => isEscalation(e, /bayview/i)).length;
    // Move to 24h after purchase, landing inside operator hours (Mon–Fri 08–18 Toronto).
    await advanceClock(22 * 60);
    for (let k = 0; k < 4; k++) {
      await passes(`ravi-24h-${k}`);
      await advanceClock(30);
    }
    const esc = operatorEmails().filter((e) => isEscalation(e, /bayview/i));
    console.log(`   operator emails: ${operatorEmails().map((e) => e.subject).join(" | ")}`);
    check(esc.length - before === 1, `exactly one escalation email for Bayview (${esc.length - before}): "${esc[0]?.subject}"`);
    check(esc[0] && String(esc[0].body).includes(`/concierge/${ravi.orgId}`), "escalation links the concierge account");
    const { data: p } = await admin.from("dfy_progress").select("escalated_at").eq("company_id", ravi.companyId!).single();
    check(p?.escalated_at, `escalated_at ${p?.escalated_at}`);
    const danaEsc = operatorEmails().filter((e) => isEscalation(e, /northshore/i));
    check(danaEsc.length === 0, "no escalation for the buyer who is live");
  });

  await step("8d. concierge shows the stuck buyer under Needs a call", async () => {
    const ctx = await desktopContext();
    const page = await signIn(ctx, HOUSE_APP, OPERATOR);
    await page.goto(`${HOUSE_APP}/concierge`);
    await page.waitForTimeout(5000);
    await shot(page, "08a-concierge-list-needs-call-1280");
    check(/Bayview Roofing/.test(await page.locator("body").innerText()), "Bayview Roofing listed");
    await page.goto(`${HOUSE_APP}/concierge/${ravi.orgId}`);
    await page.waitForTimeout(5000);
    await shot(page, "08b-concierge-detail-stuck-1280");
    await ctx.close();
  });

  await step("8c. house tenant untouched by every sweep", async () => {
    if (!house) throw new Error("no house tenant");
    const now = await houseSnapshot(house.orgId, house.companyId);
    check(now === house.snapshot, "house org/company rows, sites, intakes, dfy_progress, workflows unchanged");
    const touched = captured().filter((c) => (c.kind === "sms" && c.to === "+17055550111") || (c.kind === "email" && c.to === "owner@a1.test"));
    check(touched.length === 0, `no messages to the house owner (${touched.length})`);
  });

  // ── timeline ───────────────────────────────────────────────────────────────
  for (const buyer of [dana, ravi]) {
    console.log(`\n── Message timeline: ${buyer.businessName} (${buyer.name}, ${buyer.phone}, ${buyer.email})`);
    for (const m of messagesFor(buyer)) {
      const first = m.kind === "sms" ? String(m.body).split("\n")[0] : `${m.subject} — ${String(m.body).split("\n").find((l) => l.trim()) ?? ""}`;
      console.log(`   ${torontoTime(Date.parse(m.t))}  ${m.kind.padEnd(5)}  ${first.slice(0, 150)}`);
    }
  }
  console.log("\n── Operator emails");
  for (const m of operatorEmails()) console.log(`   ${torontoTime(Date.parse(m.t))}  ${m.subject}`);
  const unhandled = captured().filter((c) => c.kind === "unhandled");
  if (unhandled.length) console.log(`\n── Unhandled third-party calls: ${JSON.stringify(unhandled)}`);

  console.log("\n── Summary");
  for (const r of results) console.log(`   ${r.ok ? "PASS" : "FAIL"}  ${r.step}`);
  console.log(`\nScreenshots:\n${shots.map((s) => `   ${s}`).join("\n")}`);
  writeFileSync(join(SHOTS, "..", "e2e-results.json"), JSON.stringify({ results, shots }, null, 2));
  await browser.close();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await browser?.close().catch(() => undefined);
  process.exit(2);
});
