import { describe, expect, it, vi } from "vitest";

const sendSms = vi.fn();
vi.mock("@/server/outbound/sms", () => ({ sendSms: (...a: unknown[]) => sendSms(...a) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: () => Promise.resolve() }));

import type { Json, Tables } from "@/server/db/database.types";
import { buildCallSummary, formatDuration, prettyPhone, type CallSummaryInput } from "@/server/services/retell/call-summary";
import { evaluateWorkflowConditions } from "@/server/services/workflow-engine/conditions";
import { buildMessageTemplateData, buildWorkflowEventContext } from "@/server/services/workflow-engine/context";
import { parseWorkflowDefinition } from "@/server/services/workflow-engine/definitions";
import { renderTemplate } from "@/server/services/workflow-engine/interpolate";
import { deliverMessage } from "@/server/services/workflow-engine/messaging";
import { ALL_RECIPES, getRecipe } from "@/server/services/workflow-engine/recipes";
import { computeResumeAt, nextWithinHours } from "@/server/services/workflow-engine/timing";
import type { WorkflowEventContext } from "@/server/services/workflow-engine/types";
import { renderDigestEmail, renderDigestSms, SMS_MAX_CHARS, type DigestData } from "@/server/templates/digest";

// ── The owner's end-of-call text ───────────────────────────────────────────────

const baseCall: CallSummaryInput = {
  agentName: "Marina",
  direction: "inbound",
  fromNumber: "+17055551234",
  toNumber: "+17059961010",
  durationMs: 185_000,
  inVoicemail: false,
  callSuccessful: true,
  disconnectionReason: "user_hangup",
  summary: "Dana wants her 24 ft bowrider wrapped before the frost and booked Tuesday morning.",
  urgent: false,
  analysis: { services_requested: ["shrink wrap", "winterization"] },
  contactName: "Dana Lee",
  quote: { subtotalCents: 115325, boat: "24 ft bowrider", depositPaid: false },
  bookingLabel: "Tuesday, September 29th in the morning",
  depositLinkSent: true,
};

describe("call summary text", () => {
  it("says who, what was quoted and booked, and the gist", () => {
    expect(buildCallSummary(baseCall)).toBe(
      [
        "📞 Marina call done · (705) 555-1234 · 3m05s",
        "Dana Lee · 24 ft bowrider · shrink wrap, winterization",
        "Quoted $1,153.25 · Booked Tuesday, September 29th in the morning · deposit link sent",
        "Dana wants her 24 ft bowrider wrapped before the frost and booked Tuesday morning.",
      ].join("\n"),
    );
  });

  it("flags a promised callback, urgency and a paid deposit", () => {
    const text = buildCallSummary({
      ...baseCall,
      urgent: true,
      bookingLabel: null,
      quote: { ...baseCall.quote!, depositPaid: true },
      analysis: { callback_requested: true, caller_name: "ignored when the contact is known" },
    });
    expect(text).toContain("Quoted $1,153.25 · deposit PAID · URGENT");
    expect(text).toContain("☎️ CALL BACK (705) 555-1234 — Marina told them you'd call within the hour.");
  });

  it("marks a transfer instead of a callback", () => {
    const text = buildCallSummary({ ...baseCall, disconnectionReason: "call_transfer", summary: "They asked to call them back." });
    expect(text).toContain("transferred to you");
    expect(text).not.toContain("CALL BACK");
  });

  it("describes an unknown caller from the call's own analysis", () => {
    const text = buildCallSummary({
      ...baseCall,
      contactName: null,
      quote: null,
      bookingLabel: null,
      depositLinkSent: false,
      inVoicemail: true,
      durationMs: 12_000,
      summary: null,
      analysis: { caller_name: "Mike", boat_length_ft: 22, boat_type: "pontoon" },
    });
    expect(text).toBe("📞 Marina call done · (705) 555-1234 · 12s · voicemail\nMike · 22 ft pontoon");
  });

  it("reports an outbound call nobody answered", () => {
    const text = buildCallSummary({ ...baseCall, direction: "outbound", durationMs: 4000, disconnectionReason: "dial_no_answer" });
    expect(text.split("\n")[0]).toBe("📤 Marina called (705) 996-1010 · Dana Lee · 24 ft bowrider · 4s");
    expect(text.split("\n")[1]).toMatch(/^no answer · Quoted/);
    expect(text).not.toContain("wrapped before the frost"); // no summary for a missed call
  });

  it("formats phones and durations", () => {
    expect(prettyPhone("17055551234")).toBe("(705) 555-1234");
    expect(prettyPhone(null)).toBe("unknown number");
    expect(formatDuration(59_400)).toBe("59s");
    expect(formatDuration(null)).toBe("");
  });
});

// ── Quiet hours ────────────────────────────────────────────────────────────────

describe("wait.within_hours", () => {
  const TZ = "America/Toronto";
  const civil = { start: "09:00", end: "20:00" };
  const at = (iso: string) => Date.parse(iso);

  it("leaves a daytime resume alone", () => {
    expect(new Date(nextWithinHours(at("2026-09-27T16:00:00Z"), civil, TZ)).toISOString()).toBe("2026-09-27T16:00:00.000Z");
  });

  it("moves a 3am resume to 9am the same day", () => {
    expect(new Date(nextWithinHours(at("2026-09-28T07:00:00Z"), civil, TZ)).toISOString()).toBe("2026-09-28T13:00:00.000Z");
  });

  it("moves a 10pm resume to 9am the next day, across the November clock change", () => {
    // 22:00 EDT on Sat Oct 31 → 09:00 EST on Sun Nov 1.
    expect(new Date(nextWithinHours(at("2026-11-01T02:00:00Z"), civil, TZ)).toISOString()).toBe("2026-11-01T14:00:00.000Z");
  });

  it("applies after the duration: paid at 11pm + 4h → 9am", () => {
    const empty = { contact: null, company: null, booking: null, quote: null, fields: {} };
    expect(computeResumeAt({ duration: "4h", within_hours: civil }, empty, at("2026-09-28T03:00:00Z"), TZ)).toBe(
      "2026-09-28T13:00:00.000Z",
    );
  });

  it("is accepted by the workflow definition schema", () => {
    const def = parseWorkflowDefinition(getRecipe("deposit-paid-pick-date")!.definition as unknown as Json);
    expect(def.actions[0]).toMatchObject({ type: "wait", within_hours: civil });
  });
});

// ── Templates ──────────────────────────────────────────────────────────────────

describe("templates", () => {
  it("formats money for a text and reads the call summary", () => {
    const data = {
      contact: null,
      company: null,
      booking: null,
      quote: { subtotal_cents: 48125 },
      call: { owner_summary: "📞 Marina call done" },
      fields: {},
    };
    expect(renderTemplate("{{ quote.subtotal_cents | dollars }} / {{call.owner_summary}}", data)).toBe(
      "$481.25 / 📞 Marina call done",
    );
    expect(renderTemplate("{{ 67200 | dollars }}", { ...data, fields: { "67200": 67200 } })).toBe("$672");
  });
});

// ── Live quote state for conditions ────────────────────────────────────────────

/** A tiny Supabase stand-in: filters are ignored except the ones a test asserts on. */
function fakeSupabase(tables: Record<string, unknown>) {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "in", "is", "order", "limit", "gte"]) b[m] = () => b;
      b.maybeSingle = async () => {
        const v = tables[table];
        return { data: Array.isArray(v) ? v[0] ?? null : v ?? null, error: null };
      };
      b.then = (resolve: (x: unknown) => unknown) => {
        const v = tables[table];
        return Promise.resolve({ data: Array.isArray(v) ? v : v ? [v] : [], error: null }).then(resolve);
      };
      return b;
    },
  };
}

function event(over: Partial<Tables<"activity_events">>): Tables<"activity_events"> {
  const ts = "2026-09-27T14:00:00.000Z";
  return {
    actor_user_id: null,
    company_id: "co_care",
    created_at: ts,
    entity_id: "contact_1",
    entity_type: "contact",
    event_type: "quote.deposit_paid",
    id: "evt_1",
    metadata_json: { quoteId: "q1" },
    occurred_at: ts,
    organization_id: "org_1",
    related_entity_id: null,
    related_entity_type: null,
    updated_at: ts,
    ...over,
  } as Tables<"activity_events">;
}

describe("quote fields on the event context", () => {
  it("reads whether the deposit is paid, a date is booked and the link went out", async () => {
    const supabase = fakeSupabase({
      contacts: { id: "contact_1", first_name: "Dana" },
      quotes: { status: "deposit_paid", deposit_paid_at: "2026-09-27T13:59:00Z" },
      bookings: [],
      quote_events: [{ id: "e1" }],
    });
    const ctx = await buildWorkflowEventContext(
      { organizationId: "org_1", actorProfileId: null, supabase } as never,
      event({}),
    );
    expect(ctx.fields).toMatchObject({
      quote_id: "q1",
      quote_status: "deposit_paid",
      quote_deposit_paid: true,
      quote_booked: false,
      quote_link_sent: true,
    });
  });

  it("finds the quote Marina made on a call", async () => {
    const supabase = fakeSupabase({
      contacts: { id: "contact_1" },
      retell_calls: { lead_id: "lead_1" },
      quotes: { id: "q_call", status: "sent", deposit_paid_at: null },
      bookings: [],
      quote_events: [],
    });
    const ctx = await buildWorkflowEventContext(
      { organizationId: "org_1", actorProfileId: null, supabase } as never,
      event({ event_type: "call.completed", metadata_json: { callId: "call_9", direction: "inbound" } }),
    );
    expect(ctx.fields).toMatchObject({
      call_id: "call_9",
      call_direction: "inbound",
      quote_id: "q_call",
      quote_deposit_paid: false,
      quote_link_sent: false,
    });
  });

  it("builds quote template data with the hosted link and text-ready money", async () => {
    process.env.QUOTE_PUBLIC_BASE_URL = "https://quotes.example.com";
    const supabase = fakeSupabase({
      contacts: { id: "contact_1", first_name: "Dana" },
      companies: { id: "co_care", name: "A1 Marine Care", timezone: "America/Toronto" },
      quotes: {
        id: "q1",
        public_token: "tok",
        quote_number: "Q-1042",
        subtotal_cents: 67200,
        total_cents: 75936,
        deposit_cents: 25000,
        input_snapshot: { services: [{ lengthFt: 24 }], hullType: "bowrider" },
      },
    });
    const ctx = { fields: { contact_id: "contact_1", quote_id: "q1" }, companyId: "co_care", entityType: "contact", entityId: "contact_1" };
    const data = await buildMessageTemplateData(
      { organizationId: "org_1", actorProfileId: null, supabase } as never,
      ctx as unknown as WorkflowEventContext,
    );
    expect(data.quote).toMatchObject({
      public_url: "https://quotes.example.com/q/tok",
      subtotal: "$672",
      deposit: "$250",
      boat: "24 ft bowrider",
      number: "Q-1042",
    });
  });
});

// ── The recipes' conditions ────────────────────────────────────────────────────

function withFields(fields: Record<string, Json>): WorkflowEventContext {
  return { fields } as unknown as WorkflowEventContext;
}

describe("receptionist recipes", () => {
  it("are all valid workflow definitions", () => {
    for (const r of ALL_RECIPES) expect(() => parseWorkflowDefinition(r.definition as unknown as Json)).not.toThrow();
  });

  it("post-call quote text: only when a quote was made and the link hasn't gone out", () => {
    const c = getRecipe("post-call-quote-text")!.definition.conditions;
    const m = (f: Record<string, Json>) => evaluateWorkflowConditions(c, withFields(f)).matched;
    expect(m({ quote_id: "q1", quote_deposit_paid: false, quote_link_sent: false })).toBe(true);
    expect(m({ quote_id: "q1", quote_deposit_paid: false, quote_link_sent: true })).toBe(false);
    expect(m({ quote_id: "q1", quote_deposit_paid: true, quote_link_sent: false })).toBe(false);
    expect(m({ quote_id: null, quote_deposit_paid: null, quote_link_sent: null })).toBe(false);
  });

  it("quote follow-up stops once the customer has paid or booked", () => {
    const wait = getRecipe("quote-follow-up")!.definition.actions[0] as unknown as { resume_conditions: Parameters<typeof evaluateWorkflowConditions>[0] };
    const m = (f: Record<string, Json>) => evaluateWorkflowConditions(wait.resume_conditions, withFields(f)).matched;
    expect(m({ stage: "lead", quote_deposit_paid: false, quote_booked: false })).toBe(true);
    expect(m({ stage: "lead", quote_deposit_paid: true, quote_booked: false })).toBe(false);
    expect(m({ stage: "lead", quote_deposit_paid: false, quote_booked: true })).toBe(false);
    expect(m({ stage: "active", quote_deposit_paid: false, quote_booked: false })).toBe(false);
  });

  it("the call summary recipes only run for calls we have a record of", () => {
    for (const slug of ["call-summary-to-owner", "missed-call-summary-to-owner"]) {
      const c = getRecipe(slug)!.definition.conditions;
      expect(evaluateWorkflowConditions(c, withFields({ call_id: "call_9" })).matched).toBe(true);
      expect(evaluateWorkflowConditions(c, withFields({ call_id: null })).matched).toBe(false);
    }
  });
});

describe("deliverMessage", () => {
  it("never sends a blank message", async () => {
    const inserts: unknown[] = [];
    const supabase = { from: () => ({ insert: async (row: unknown) => (inserts.push(row), { error: null }) }) };
    const res = await deliverMessage({
      context: { organizationId: "org_1", actorProfileId: null, supabase } as never,
      channel: "sms",
      to: "+17055551234",
      body: "   ",
      companyId: "co_care",
      contactId: null,
      consentContact: null,
    });
    expect(res).toMatchObject({ status: "blocked", reason: "empty_body" });
    expect(sendSms).not.toHaveBeenCalled();
    expect(inserts[0]).toMatchObject({ status: "blocked", error: "empty_body" });
  });
});

// ── The morning digest's call-back lists ───────────────────────────────────────


const DIGEST: DigestData = {
  companyName: "A1 Marine Care",
  localDate: "2026-09-28",
  calls: { total: 9, booked: 3, quotesSent: 6, needsCallback: 1 },
  newLeads: 4,
  messagesNeedingReply: 0,
  quotesUnviewed48h: 0,
  todaysBookings: 3,
  usage: { smsSent: 0, emailSent: 0, voiceMinutes: 0, cap: null },
  attribution: { approvedCents: 0, paidCents: 0, currency: "CAD" },
  callToday: [
    { name: "Dana Lee", phone: "+17055551234", boat: "24 ft bowrider", amountCents: 67200 },
    { name: "Mike Rowe", phone: "+17055559876", boat: "22 ft pontoon", amountCents: 96800 },
  ],
  paidNoDate: [{ name: "Priya Shah", phone: "+17055550001", boat: "20 ft cuddy", amountCents: 56000 }],
  todaysJobs: [
    { when: "AM", name: "Sam Ortiz" },
    { when: "PM", name: "Jordan Blake" },
  ],
};

describe("digest lists", () => {
  it("puts today's jobs and the call-back list in the text, after the totals", () => {
    const sms = renderDigestSms(DIGEST, "https://app.empirevu.com/inbox");
    expect(sms).toBe(
      "A1 Marine Care: 9 calls, 1 to call back, 4 new leads, 6 quotes sent, 3 bookings today. " +
        "Today: AM Sam, PM Jordan. Call today: Dana 705-555-1234 $672; Mike 705-555-9876 $968. " +
        "Paid, no date: Priya 705-555-0001 $560. https://app.empirevu.com/inbox",
    );
  });

  it("truncates names, never the totals or the link, on a busy morning", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `Customer${i} Name`, phone: "+17055550000", boat: null, amountCents: 100000 }));
    const sms = renderDigestSms({ ...DIGEST, callToday: many, paidNoDate: many }, "https://app.empirevu.com/inbox");
    expect(sms.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
    expect(sms).toMatch(/^A1 Marine Care: 9 calls/);
    expect(sms.endsWith("https://app.empirevu.com/inbox")).toBe(true);
  });

  it("lists everyone in full in the email", () => {
    const { text, html } = renderDigestEmail(DIGEST, { deepLink: "https://x" });
    expect(text).toContain("Quoted, not booked — call today:\n- Dana Lee · +17055551234 · 24 ft bowrider · $672.00");
    expect(text).toContain("Deposit paid, no date yet:\n- Priya Shah");
    expect(html).toContain("Today&#39;s schedule");
  });

  it("counts a pending call-back list as activity", () => {
    const quiet = { ...DIGEST, calls: { total: 0, booked: 0, quotesSent: 0, needsCallback: 0 }, newLeads: 0, todaysBookings: 0, todaysJobs: [], paidNoDate: [] };
    expect(renderDigestSms(quiet, "https://x")).toContain("Call today: Dana");
  });
});
