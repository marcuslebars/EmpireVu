import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "./fake-supabase";

// The worker side of AI answering: a claimed ('ai_pending') call gets NO generic text-back,
// the watchdog releases a hand-off whose post-call never came, and the "minutes used up"
// owner notice goes once a month.
const h = vi.hoisted(() => ({
  db: null as FakeDb | null,
  intakeCalls: 0,
  dispatches: [] as Array<{ eventType: unknown; emitOnly: boolean }>,
}));

vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.db?.client }));
vi.mock("@/server/services/lead-intake/intake", () => ({
  handleLeadIntake: () => {
    h.intakeCalls += 1;
    h.db!.tables.raw_leads ??= [];
    h.db!.tables.raw_leads.push({ lead_id: `lead_${h.intakeCalls}`, contact_id: "contact-1" });
    return Promise.resolve({ ok: true, leadId: `lead_${h.intakeCalls}` });
  },
}));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({
  emitActivityEventAndDispatch: (_ctx: unknown, input: Record<string, unknown>, options?: Record<string, unknown>) => {
    h.dispatches.push({ eventType: input.eventType, emitOnly: Boolean(options?.emitOnly) });
    h.db!.tables.activity_events ??= [];
    h.db!.tables.activity_events.push({ id: `ev-${h.dispatches.length}`, organization_id: ORG, event_type: input.eventType, metadata_json: input.metadata });
    return Promise.resolve({ activityEvent: { id: "ev" }, workflowEventJob: null });
  },
}));

import { handleMissedCall } from "@/server/services/twilio/missed-call";
import { handleVoiceAiJob, minutesExhaustedText } from "@/server/services/voice/jobs";
import type { DeliverMessageInput } from "@/server/services/workflow-engine/messaging";

const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const CATCHER = "+17055550100";

const env = { ...process.env };
afterAll(() => {
  process.env = env;
});

const params = { CallSid: "CA0001", From: "+17055550123", To: CATCHER, CallStatus: "ringing" };

function seed(missed: Array<Record<string, unknown>> = []): FakeDb {
  return createFakeDb({
    voice_numbers: [{ id: "vn-1", organization_id: ORG, company_id: COMPANY, phone_e164: CATCHER, provider: "twilio", mode: "missed_call_catcher", active: true }],
    companies: [{ id: COMPANY, organization_id: ORG, name: "Northshore Plumbing", slug: "northshore", owner_phone_e164: "+17055550111", owner_email: "dana@northshore.test" }],
    organizations: [{ id: ORG, plan: "operate", slug: "northshore" }],
    workflows: [],
    missed_calls: missed,
  });
}

beforeEach(() => {
  h.db = seed();
  h.intakeCalls = 0;
  h.dispatches = [];
  delete process.env.AI_ANSWER_WATCHDOG_MINUTES;
});

const db = () => h.db!;

describe("handleMissedCall with an AI hand-off", () => {
  it("an 'ai_pending' call: no lead, no call.missed (so no generic text-back) — just the watchdog", async () => {
    h.db = seed([{ id: "mc-1", call_sid: "CA0001", organization_id: ORG, company_id: COMPANY, text_back_status: "ai_pending", raw_payload: params }]);
    const now = Date.parse("2026-10-09T15:00:00Z");
    const result = await handleMissedCall(params, now);
    expect(result.status).toBe("ai_pending");
    expect(h.intakeCalls).toBe(0);
    expect(h.dispatches).toHaveLength(0);
    const watchdog = db().tables.inbound_webhook_jobs.find((j) => j.external_id === "watchdog:CA0001");
    expect(watchdog).toMatchObject({ provider: "twilio_voice_ai", payload: { kind: "watchdog", CallSid: "CA0001" } });
    expect(watchdog!.run_at).toBe(new Date(now + 30 * 60_000).toISOString());
    // A retry schedules nothing new.
    await handleMissedCall(params, now);
    expect(db().tables.inbound_webhook_jobs.filter((j) => j.external_id === "watchdog:CA0001")).toHaveLength(1);
  });

  it("an 'ai_handled' call is a duplicate (nothing more)", async () => {
    h.db = seed([{ id: "mc-1", call_sid: "CA0001", organization_id: ORG, company_id: COMPANY, text_back_status: "ai_handled" }]);
    expect((await handleMissedCall(params)).status).toBe("duplicate");
    expect(h.dispatches).toHaveLength(0);
  });

  it("a released call ('pending' again) runs the normal path: lead + call.missed (text-back)", async () => {
    h.db = seed([{ id: "mc-1", call_sid: "CA0001", organization_id: ORG, company_id: COMPANY, text_back_status: "pending", caller_phone_last10: "7055550123" }]);
    const result = await handleMissedCall(params);
    expect(result.status).toBe("emitted");
    expect(h.intakeCalls).toBe(1);
    expect(h.dispatches).toEqual([{ eventType: "call.missed", emitOnly: false }]);
  });
});

describe("handleVoiceAiJob", () => {
  it("watchdog: still 'ai_pending' → released to the normal path once", async () => {
    h.db = seed([{ id: "mc-1", call_sid: "CA0001", organization_id: ORG, company_id: COMPANY, text_back_status: "ai_pending", raw_payload: params }]);
    const runMissedCall = vi.fn(async () => ({}));
    await handleVoiceAiJob({ kind: "watchdog", CallSid: "CA0001" }, { runMissedCall });
    expect(db().tables.missed_calls[0].text_back_status).toBe("pending");
    expect(runMissedCall).toHaveBeenCalledWith(params);
    await handleVoiceAiJob({ kind: "watchdog", CallSid: "CA0001" }, { runMissedCall });
    expect(runMissedCall).toHaveBeenCalledTimes(1);
  });

  it("watchdog: the AI already handled it → nothing", async () => {
    h.db = seed([{ id: "mc-1", call_sid: "CA0001", organization_id: ORG, company_id: COMPANY, text_back_status: "ai_handled" }]);
    const runMissedCall = vi.fn(async () => ({}));
    await handleVoiceAiJob({ kind: "watchdog", CallSid: "CA0001" }, { runMissedCall });
    expect(runMissedCall).not.toHaveBeenCalled();
    expect(db().tables.missed_calls[0].text_back_status).toBe("ai_handled");
  });

  it("minutes notice: texts the owner once per company per month", async () => {
    const send = vi.fn(async (_input: DeliverMessageInput) => ({ status: "sent" as const, body: "" }));
    const job = { kind: "minutes_notice", organizationId: ORG, companyId: COMPANY, month: "2026-10-01" };
    await handleVoiceAiJob(job, { send });
    await handleVoiceAiJob(job, { send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ channel: "sms", to: "+17055550111", contactId: null });
    expect(String((send.mock.calls[0][0] as { body: string }).body)).toContain("minutes for October are used up");
    expect(db().tables.call_answering_notices).toHaveLength(1);
    expect(db().tables.call_answering_notices[0].sent_at).toBeTruthy();
  });

  it("the notice copy names the month and the fallback, never the platform", () => {
    const text = minutesExhaustedText("Northshore Plumbing", "2026-10-01");
    expect(text).toMatch(/October/);
    expect(text).toMatch(/voicemail/);
    expect(text).not.toMatch(/EmpireVu|CrankLeads/);
  });
});
