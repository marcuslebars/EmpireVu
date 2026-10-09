/**
 * SMS agent eval — realistic Ontario trades conversations against the REAL model.
 *
 *   ANTHROPIC_API_KEY=… npx tsx scripts/sms-agent-eval/run.ts            # all scenarios
 *   ANTHROPIC_API_KEY=… npx tsx scripts/sms-agent-eval/run.ts roof        # names containing "roof"
 *   AI_MODEL_SMS_AGENT=claude-opus-5 … npx tsx scripts/sms-agent-eval/run.ts
 *
 * Skips (exit 0) without ANTHROPIC_API_KEY. Uses an in-memory database and fake quote / booking /
 * SMS services — it never touches a real database, Twilio, or any customer data. It prints each
 * transcript (customer ↔ assistant, tool calls, owner approvals / alerts) and a soft check of
 * what we expected the assistant to do. Read the transcripts; the checks are a guide, not a gate.
 */
import type Anthropic from "@anthropic-ai/sdk";

import type { InboundCustomerSms } from "@/server/services/front-desk/contracts";
import { defaultModelClient, type ModelClient } from "@/server/services/sms-agent/agent";
import { runSmsAgent, type SmsAgentDeps } from "@/server/services/sms-agent/entry";
import { loadBusinessFacts } from "@/server/services/sms-agent/facts";
import type { AgentServices } from "@/server/services/sms-agent/services";
import { getSmsAgentModel } from "@/server/ai/config";
import { createFakeDb, type FakeDb } from "../../src/test/helpers/fake-supabase";
import { BUSINESSES, SCENARIOS, type Scenario } from "./scenarios";

type Row = Record<string, unknown>;

const ORG = "11111111-1111-1111-1111-111111111111";
const CONTACT = "33333333-3333-3333-3333-333333333333";
const PHONE = "+17055550123";

interface Log {
  lines: string[];
  texts: string[];
  ownerAlerts: string[];
  quotes: number;
  bookings: number;
  tools: string[];
}

function seed(s: Scenario): Record<string, Row[]> {
  const biz = BUSINESSES[s.business];
  return {
    organizations: [{ id: ORG, platform_brand: "crankleads" }],
    companies: [
      {
        id: biz.id,
        organization_id: ORG,
        name: biz.name,
        ai_settings: s.autonomy ? { sms_agent: { autonomy: s.autonomy } } : {},
        timezone: "America/Toronto",
        hours: { summary: biz.hours },
        service_area: biz.serviceArea,
        owner_phone_e164: "+17055550199",
        online_booking_settings: { enabled: true },
        booking_policy: null,
        industry_pack: { id: biz.pack, version: 1, appliedAt: "2026-09-01", recipes: [] },
        cancellation_policy_text: biz.cancellation ?? null,
      },
    ],
    organization_memberships: [{ organization_id: ORG, profile_id: "owner", role: "owner" }],
    profiles: [{ id: "owner", full_name: biz.owner }],
    contacts: [
      {
        id: CONTACT,
        organization_id: ORG,
        company_id: biz.id,
        first_name: s.knownName ?? PHONE,
        last_name: null,
        phone: PHONE,
        email: null,
        notes: null,
        metadata: {},
        sms_opt_out_at: null,
        sms_consent_at: new Date().toISOString(),
        consent_source: "inbound_sms",
      },
    ],
    service_catalog_items: biz.prices.map((p, i) => ({
      id: `item-${i}`,
      organization_id: ORG,
      company_id: biz.id,
      service_key: p.key,
      label: p.label,
      description: p.description ?? null,
      pricing_type: p.type ?? "flat",
      rate_cents: p.cents,
      minimum_cents: p.minimumCents ?? 0,
      unit_label: p.unit ?? null,
      modifier_groups: null,
      active: true,
      sort_order: i,
    })),
    message_log: [],
    sms_conversations: [],
    owner_approvals: [],
  };
}

function services(db: FakeDb, log: Log, companyId: string, clock: () => Date): AgentServices {
  const items = () => db.tables.service_catalog_items as Row[];
  return {
    async priceServices(_c, lines) {
      const priced = lines.map((l) => {
        const item = items().find((i) => i.service_key === l.service_key);
        if (!item) throw Object.assign(new Error(`"${l.service_key}" is not on the price list`), { code: "unknown_service" });
        const units = item.pricing_type === "flat" ? 1 : (l.measure ?? l.quantity ?? 1);
        const amount = Math.max((item.rate_cents as number) * units, item.minimum_cents as number);
        return { serviceId: l.service_key, label: item.label as string, description: "", quantity: units, unitPriceCents: item.rate_cents as number, amountCents: amount, bundleEligible: false, optional: false, selected: true, custom: false };
      });
      const subtotal = priced.reduce((a, l) => a + l.amountCents, 0);
      const tax = Math.round(subtotal * 0.13);
      return { currency: "CAD", lineItems: priced, bundleId: null, bundleSavingsCents: 0, subtotalCents: subtotal, taxRateBps: 1300, taxCents: tax, totalCents: subtotal + tax, depositRateBps: 2500, depositFlatCents: null, depositCents: Math.round((subtotal + tax) / 4) };
    },
    async createAndSendQuote(_a, _f, input) {
      log.quotes += 1;
      const subtotal = input.customLines?.length ? input.customLines.reduce((a, l) => a + l.amountCents, 0) : (await this.priceServices(companyId, input.lines ?? [])).subtotalCents;
      log.lines.push(`   [quote created: ${input.title} — $${(subtotal / 100).toFixed(2)} + HST]`);
      return { quoteId: `quote-${log.quotes}`, url: `https://quotes.example.ca/q/demo${log.quotes}`, subtotalCents: subtotal, totalCents: Math.round(subtotal * 1.13), quoteNumber: `Q-${log.quotes}`, title: input.title };
    },
    async checkAvailability() {
      const base = clock();
      const slots = [1, 2, 4].map((d) => {
        const at = new Date(base.getTime() + d * 86_400_000);
        at.setUTCHours(13, 0, 0, 0);
        return { date: at.toISOString().slice(0, 10), window: null, startsAt: at.toISOString(), label: `${at.toLocaleDateString("en-CA", { timeZone: "America/Toronto", weekday: "long", month: "long", day: "numeric" })}, 9:00 a.m.` };
      });
      return { ok: true, mode: "hourly", slots };
    },
    async bookSlot(_a, _f, input) {
      log.bookings += 1;
      log.lines.push(`   [booked ${input.startsAt ?? input.date}]`);
      return { ok: true, bookingId: `booking-${log.bookings}`, label: input.startsAt ? new Date(input.startsAt).toLocaleString("en-CA", { timeZone: "America/Toronto" }) : String(input.date), duplicate: false };
    },
    async textCustomer(_a, _f, contact, body) {
      log.texts.push(body);
      log.lines.push(`   ASSISTANT: ${body}`);
      db.tables.message_log.push({ id: `out-${Math.random()}`, organization_id: ORG, company_id: companyId, contact_id: contact.id, channel: "sms", direction: "outbound", status: "sent", body, created_at: clock().toISOString(), sent_by: "sms_agent" });
      return { status: "sent", providerRef: "SMfake", body };
    },
    async alertOwner(_a, _f, body) {
      log.ownerAlerts.push(body);
      log.lines.push(`   [owner alert] ${body}`);
      return { sent: true };
    },
    async recordQuoteEvent() {},
    now: clock,
  };
}

function loggingClient(inner: ModelClient, log: Log): ModelClient {
  return {
    async createMessage(params, options) {
      const res = await inner.createMessage(params, options);
      for (const b of res.content) {
        if (b.type === "tool_use") {
          log.tools.push(b.name);
          log.lines.push(`   [tool] ${b.name} ${JSON.stringify(b.input)}`);
        }
      }
      return res as Anthropic.Message;
    },
  };
}

async function runScenario(s: Scenario): Promise<{ ok: boolean; notes: string[] }> {
  const biz = BUSINESSES[s.business];
  const db = createFakeDb(seed(s), { sms_conversations: [["company_id", "contact_id"]] });
  const log: Log = { lines: [], texts: [], ownerAlerts: [], quotes: 0, bookings: 0, tools: [] };
  let t = Date.parse("2026-10-14T15:00:00Z");
  const clock = () => new Date((t += 1000));
  const real = defaultModelClient();
  const deps: SmsAgentDeps = {
    services: services(db, log, biz.id, clock),
    approvalDeps: { notify: async () => ({ notified: true }), now: clock },
    modelClient: () => loggingClient(real, log),
    model: getSmsAgentModel,
    fetchImages: async () => [],
    loadFacts: loadBusinessFacts,
    recordUsage: async () => undefined,
    limits: () => ({ perConversationPerDay: 25, perCompanyPerDay: 300, maxIterations: 6, turnTimeoutMs: 60_000, coalesceMs: 0, leaseMs: 120_000, takeoverMs: 72 * 3_600_000 }),
    sleep: async () => undefined,
    aiConfigured: () => true,
  };

  for (const text of s.customer) {
    const at = clock().toISOString();
    const id = `in-${Math.random()}`;
    db.tables.message_log.push({ id, organization_id: ORG, company_id: biz.id, contact_id: CONTACT, channel: "sms", direction: "inbound", status: "received", body: text, created_at: at, media: null });
    log.lines.push(`   CUSTOMER: ${text}`);
    const sms: InboundCustomerSms = { organizationId: ORG, companyId: biz.id, contactId: CONTACT, messageLogId: id, from: PHONE, to: "+17055550100", body: text, media: [], receivedAt: at };
    const outcome = await runSmsAgent(db.client as never, sms, deps);
    if (outcome.skipped) log.lines.push(`   [no reply: ${outcome.skipped}]`);
  }

  const approvals = db.tables.owner_approvals as Row[];
  for (const a of approvals) log.lines.push(`   [approval #${a.short_code} ${a.kind}] ${a.summary}`);
  const conv = (db.tables.sms_conversations as Row[])[0];
  log.lines.push(`   [state: ${conv?.state ?? "none"} · summary: ${conv?.summary ?? "—"}]`);

  const notes: string[] = [];
  const all = log.texts.join(" ");
  if (s.expect.approval && approvals.length === 0) notes.push("expected an owner approval");
  if (s.expect.noApproval && approvals.length > 0) notes.push("expected no approval");
  if (s.expect.handoff && conv?.state !== "owner") notes.push("expected a hand-off");
  if (s.expect.quote && log.quotes === 0) notes.push("expected a price-list quote link");
  if (s.expect.booking && log.bookings === 0) notes.push("expected a booking");
  if (s.expect.mustNotSay?.some((re) => re.test(all))) notes.push(`said something it shouldn't: ${s.expect.mustNotSay.filter((re) => re.test(all)).join(", ")}`);
  if (log.texts.length && !/automated assistant/i.test(log.texts[0])) notes.push("first message lacks the AI disclosure");
  if (/crank\s?leads|empire\s?vu/i.test(all)) notes.push("named the platform");
  if (log.texts.some((x) => x.length > 459)) notes.push("a reply was too long");

  console.log(`\n── ${s.name} (${biz.name}) ${"─".repeat(Math.max(0, 60 - s.name.length))}`);
  console.log(log.lines.join("\n"));
  console.log(notes.length ? `   CHECK: ${notes.join("; ")}` : "   OK");
  return { ok: notes.length === 0, notes };
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("ANTHROPIC_API_KEY is not set — skipping the SMS agent eval.");
    return;
  }
  const filter = process.argv[2]?.toLowerCase();
  const list = SCENARIOS.filter((s) => !filter || s.name.toLowerCase().includes(filter));
  console.log(`SMS agent eval — model ${getSmsAgentModel()} — ${list.length} conversation(s)`);
  let ok = 0;
  for (const s of list) {
    try {
      if ((await runScenario(s)).ok) ok += 1;
    } catch (err) {
      console.log(`\n── ${s.name}: ERROR ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n${ok}/${list.length} matched expectations.`);
}

void main();
