import { describe, expect, it, vi } from "vitest";

import { createFakeDb, fakeTenantContext } from "./fake-supabase";

const sendSms = vi.fn((..._a: unknown[]) => Promise.resolve({ sid: "SM1" }));
vi.mock("@/server/outbound/sms", () => ({ sendSms: (...a: unknown[]) => sendSms(...a) }));
vi.mock("@/server/outbound/email", () => ({ sendEmail: () => Promise.resolve({ id: "em1" }) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: () => Promise.resolve() }));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({
  emitActivityEventAndDispatch: () => Promise.resolve({ activityEvent: { id: "e" }, workflowEventJob: null }),
}));

import type { Tables } from "@/server/db/database.types";
import { buildForwardingInstructions, prettyPhone, toDialNumber } from "@/lib/carrier-forwarding";
import { missedCallToContactCall } from "@/server/services/calls";
import { pushMessageForEvent } from "@/server/services/push/activity";
import type { TenantServiceContext } from "@/server/services/shared";
import {
  buildCatcherGreetingTwiml,
  buildVoicemailDoneTwiml,
  catcherGreetingText,
  escapeXml,
  voicemailMaxSeconds,
} from "@/server/services/twilio/voice-twiml";
import { deliverMessage, resolveCompanySmsFrom } from "@/server/services/workflow-engine/messaging";

describe("carrier forwarding instructions (golden)", () => {
  it("fills the catcher number into the GSM conditional-forwarding codes", () => {
    const i = buildForwardingInstructions("705-555-0100");
    expect({ ...i, landline: undefined, verifyNote: undefined, testSteps: undefined }).toEqual({
      number: "+17055550100",
      pretty: "(705) 555-0100",
      recommended: {
        condition: "all_conditional",
        label: "All of the above in one code (no answer, busy, unreachable)",
        activate: "**004*+17055550100#",
        deactivate: "##004#",
      },
      codes: [
        { condition: "no_answer", label: "When you don't answer", activate: "**61*+17055550100#", deactivate: "##61#" },
        { condition: "busy", label: "When you're on another call", activate: "**67*+17055550100#", deactivate: "##67#" },
        { condition: "unreachable", label: "When your phone is off or has no signal", activate: "**62*+17055550100#", deactivate: "##62#" },
      ],
      noAnswerWithRingTime: { seconds: 20, activate: "**61*+17055550100**20#" },
      landline: undefined,
      verifyNote: undefined,
      testSteps: undefined,
    });
    expect(i.landline).toContain('"call forward no answer"');
    expect(i.landline).toContain("(705) 555-0100");
    expect(i.verifyNote).toMatch(/confirm|call your carrier/i);
    expect(i.testSteps[0]).toMatch(/DIFFERENT phone/);
  });

  it("clamps the ring time to GSM's 5–30s in steps of 5", () => {
    expect(buildForwardingInstructions("+17055550100", 47).noAnswerWithRingTime.activate).toBe("**61*+17055550100**30#");
    expect(buildForwardingInstructions("+17055550100", 12).noAnswerWithRingTime.seconds).toBe(10);
  });

  it("normalises numbers for dialling and display", () => {
    expect(toDialNumber("17055550100")).toBe("+17055550100");
    expect(prettyPhone("+17055550100")).toBe("(705) 555-0100");
    expect(prettyPhone("+447700900123")).toBe("+447700900123");
  });
});

describe("catcher TwiML", () => {
  it("names the company and escapes XML", () => {
    expect(catcherGreetingText("A&B <Heating>")).toBe(
      "Sorry we missed your call. This is A&B <Heating>. We'll text you right away. Leave a message after the tone.",
    );
    expect(escapeXml(`A&B <"x">'`)).toBe("A&amp;B &lt;&quot;x&quot;&gt;&apos;");
    const xml = buildCatcherGreetingTwiml({
      companyName: "A&B",
      actionUrl: "https://x/a?event=action&y=1",
      recordingStatusUrl: "https://x/s",
      transcribeUrl: null,
      maxLengthSeconds: 9999,
      voice: "alice",
    });
    expect(xml).toContain('<Say voice="alice">Sorry we missed your call. This is A&amp;B.');
    expect(xml).toContain('action="https://x/a?event=action&amp;y=1"');
    expect(xml).toContain('maxLength="600"');
    expect(xml).not.toContain("transcribe=");
  });

  it("caps the voicemail length sanely", () => {
    expect(voicemailMaxSeconds(null)).toBe(120);
    expect(voicemailMaxSeconds("90")).toBe(90);
    expect(voicemailMaxSeconds("2")).toBe(5);
    expect(voicemailMaxSeconds("abc")).toBe(120);
  });

  it("says goodbye and hangs up after the voicemail", () => {
    expect(buildVoicemailDoneTwiml()).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">Thanks, we got your message. Talk soon.</Say><Hangup/></Response>',
    );
  });
});

function event(eventType: string, metadata: Record<string, unknown>): Tables<"activity_events"> {
  return {
    id: "e1",
    organization_id: "org-1",
    company_id: "co-1",
    entity_type: "contact",
    entity_id: "c-1",
    event_type: eventType,
    metadata_json: metadata,
    actor_user_id: null,
    related_entity_id: null,
    related_entity_type: null,
    occurred_at: "2026-10-02T14:00:00.000Z",
    created_at: "2026-10-02T14:00:00.000Z",
  } as Tables<"activity_events">;
}

describe("push mapping", () => {
  it("alerts on a caught missed call (not on a Retell short call) and on a voicemail", () => {
    expect(pushMessageForEvent(event("call.missed", { source: "missed_call_catcher", fromNumber: "+17055550123" }), "Lead")).toMatchObject({
      title: "Missed call — +17055550123",
      body: "We texted them back. Tap to follow up.",
      category: "leads",
    });
    expect(pushMessageForEvent(event("call.missed", { callId: "retell_1" }), "Paul")).toBeNull();
    expect(
      pushMessageForEvent(event("call.missed", { source: "missed_call_catcher", textBackSuppressed: true }), "Paul")?.body,
    ).toMatch(/already texted/);
    expect(pushMessageForEvent(event("call.voicemail", { fromNumber: "+17055550123" }), "Paul Smith")).toMatchObject({
      title: "Voicemail — Paul Smith",
    });
  });
});

describe("contact Calls tab", () => {
  it("shows a caught call's voicemail + transcript", () => {
    const call = missedCallToContactCall({
      id: "mc-1",
      call_sid: "CA1",
      created_at: "2026-10-02T14:00:00.000Z",
      recording_url: "https://r/RE1.mp3",
      recording_duration_seconds: 14,
      transcription_text: "Furnace is out",
      text_back_status: "emitted",
    } as Tables<"missed_calls">);
    expect(call).toEqual({
      id: "mc-1",
      callId: "CA1",
      direction: "inbound",
      startedAt: "2026-10-02T14:00:00.000Z",
      durationSeconds: 14,
      summary: "Missed call — left a voicemail.",
      sentiment: null,
      inVoicemail: true,
      recordingUrl: "https://r/RE1.mp3",
      transcript: "Furnace is out",
      segments: [],
    });
  });
});

describe("text-back sends from the company's own Twilio number", () => {
  const ctxWith = (rows: Array<Record<string, unknown>>) => {
    const db = createFakeDb({ voice_numbers: rows, message_log: [] });
    return fakeTenantContext(db, "org-1");
  };

  it("prefers the catcher number, falls back to any active twilio number, else null (env TWILIO_FROM_NUMBER)", async () => {
    const base = { organization_id: "org-1", company_id: "co-1", provider: "twilio", active: true };
    expect(
      await resolveCompanySmsFrom(
        ctxWith([
          { ...base, phone_e164: "+12495550111", mode: "sms_only" },
          { ...base, phone_e164: "+17055550100", mode: "missed_call_catcher" },
        ]),
        "co-1",
      ),
    ).toBe("+17055550100");
    expect(await resolveCompanySmsFrom(ctxWith([{ ...base, phone_e164: "+12495550111", mode: "sms_only" }]), "co-1")).toBe("+12495550111");
    expect(await resolveCompanySmsFrom(ctxWith([{ ...base, provider: "retell", phone_e164: "+1", mode: "ai_receptionist" }]), "co-1")).toBeNull();
    expect(await resolveCompanySmsFrom(ctxWith([]), null)).toBeNull();
  });

  it("deliverMessage passes `from` to Twilio and keeps the STOP footer on the first text", async () => {
    sendSms.mockClear();
    const context = ctxWith([
      { organization_id: "org-1", company_id: "co-1", provider: "twilio", active: true, phone_e164: "+17055550100", mode: "missed_call_catcher" },
    ]);
    const result = await deliverMessage({
      context,
      channel: "sms",
      to: "+17055550123",
      body: "Hi, sorry we missed you — Muskoka Plumbing here.",
      companyId: "co-1",
      contactId: "c-1",
      consentContact: { sms_opt_out_at: null, email_opt_out_at: null, sms_consent_at: new Date().toISOString(), consent_source: "implied_inquiry" },
    });
    expect(result.status).toBe("sent");
    expect(sendSms).toHaveBeenCalledWith({
      to: "+17055550123",
      from: "+17055550100",
      body: "Hi, sorry we missed you — Muskoka Plumbing here.\nReply STOP to opt out",
    });
  });

  it("an opted-out caller is never texted back", async () => {
    sendSms.mockClear();
    const result = await deliverMessage({
      context: ctxWith([]),
      channel: "sms",
      to: "+17055550123",
      body: "Hi",
      companyId: "co-1",
      contactId: "c-1",
      consentContact: { sms_opt_out_at: "2026-10-01T00:00:00Z", email_opt_out_at: null, sms_consent_at: "2026-09-01T00:00:00Z", consent_source: "implied_inquiry" },
    });
    expect(result).toMatchObject({ status: "blocked", reason: "opted_out" });
    expect(sendSms).not.toHaveBeenCalled();
  });
});
