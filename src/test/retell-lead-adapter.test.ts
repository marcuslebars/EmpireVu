import { describe, expect, it } from "vitest";

import { parseLeadEnvelope } from "@/server/services/lead-intake/envelope";
import {
  buildPhoneLeadEnvelope,
  readRetellCallFields,
  readRetellFunctionFields,
} from "@/server/services/retell/lead-adapter";

const RECEIVED_AT = "2026-08-11T15:04:05.000Z";
const SOURCE = "retell_voice_agent";

const callAnalyzed = {
  event: "call_analyzed",
  call: {
    call_id: "call_9f2c1e7b4a3d8e60",
    agent_id: "agent_1",
    direction: "inbound",
    from_number: "+17055550188",
    to_number: "+17055551000",
    transcript: "Agent: Hello...\nUser: I need my boat winterized...",
    transcript_object: [{ role: "agent", content: "Hello" }],
    call_analysis: {
      call_summary: "Caller wants winterization + shrink wrap, then outdoor storage.",
      user_sentiment: "Positive",
      call_successful: true,
      in_voicemail: false,
      custom_analysis_data: {
        caller_name: "Paul Genereux",
        caller_email: "paul@example.com",
        boat_make_model: "2017 Sea Ray SPX 210",
        boat_length_ft: "24 feet",
        boat_type: "bowrider",
        engine_type: "outboard",
        engine_count: "twin",
        boat_location: "Midland",
        on_trailer: "yes",
        services_requested: ["Winterization", "Shrink Wrapping", "Outdoor Storage"],
        is_urgent: "yes",
      },
    },
  },
};

describe("retell call_analyzed → canonical phone-lead envelope", () => {
  it("produces an envelope the existing intake schema accepts", () => {
    const env = buildPhoneLeadEnvelope(readRetellCallFields(callAnalyzed), "a1marinestorage", SOURCE, RECEIVED_AT);
    const parsed = parseLeadEnvelope(env);
    expect(parsed.reason).toBeNull();
    expect(parsed.valid).toBe(true);
  });

  it("maps the post-call analysis fields onto the canonical shape", () => {
    const env = buildPhoneLeadEnvelope(readRetellCallFields(callAnalyzed), "a1marinestorage", SOURCE, RECEIVED_AT);
    const parsed = parseLeadEnvelope(env);
    if (!parsed.valid || !parsed.envelope) throw new Error("expected a valid envelope");
    const r = parsed.envelope;

    expect(r.formType).toBe("phone-lead");
    expect(r.source).toBe(SOURCE);
    expect(r.sourceSite).toBe("a1marinestorage");
    expect(r.contact.name).toBe("Paul Genereux");
    expect(r.contact.email).toBe("paul@example.com");
    expect(r.contact.phone).toBe("+17055550188");
    expect(r.asset?.makeModel).toBe("2017 Sea Ray SPX 210");
    expect(r.asset?.lengthFt).toBe(24);
    expect(r.asset?.type).toBe("bowrider");
    expect(r.asset?.engineType).toBe("outboard");
    expect(r.asset?.engineCount).toBe(2);
    expect(r.asset?.onTrailer).toBe(true);
    expect(r.asset?.location).toBe("Midland");
    expect(r.services).toEqual(["Winterization", "Shrink Wrapping", "Outdoor Storage"]);
    expect(r.meta?.urgent).toBe(true);
    expect(r.meta?.retell?.callId).toBe("call_9f2c1e7b4a3d8e60");
    // The summary rides in the message so the notification email is self-contained.
    expect(r.message).toContain("winterization");
    expect(r.message).toContain(callAnalyzed.call.call_id);
  });

  it("extracts the urgency flag from the custom analysis field", () => {
    expect(readRetellCallFields(callAnalyzed).urgent).toBe(true);
  });

  it("reads a phone-only call (no name/email) into a valid envelope", () => {
    const phoneOnly = {
      event: "call_analyzed",
      call: { call_id: "c3", from_number: "4165551234", call_analysis: { custom_analysis_data: {} } },
    };
    const env = buildPhoneLeadEnvelope(readRetellCallFields(phoneOnly), "a1marinestorage", SOURCE, RECEIVED_AT);
    const parsed = parseLeadEnvelope(env);
    expect(parsed.valid).toBe(true);
    expect(parsed.envelope?.contact.phone).toBe("+14165551234");
    expect(parsed.envelope?.meta?.urgent).toBeUndefined();
  });

  it("degrades to a schema-sorted (invalid) envelope when the call captured no contact", () => {
    const noContact = { event: "call_analyzed", call: { call_id: "c2", call_analysis: { custom_analysis_data: {} } } };
    const env = buildPhoneLeadEnvelope(readRetellCallFields(noContact), "a1marinestorage", SOURCE, RECEIVED_AT);
    const parsed = parseLeadEnvelope(env);
    // No phone/email → intake stores it raw + flags rather than dropping; the adapter
    // must not pretend it's valid.
    expect(parsed.valid).toBe(false);
  });
});

describe("retell mid-call capture-lead function → envelope", () => {
  const fnCall = {
    call: { call_id: "call_mid_1", from_number: "+14165551234" },
    name: "capture_lead",
    args: {
      caller_name: "Dana",
      services_requested: "winterization",
      boat_length_ft: 22,
      is_urgent: false,
    },
  };

  it("builds a valid envelope from function args + call identity", () => {
    const env = buildPhoneLeadEnvelope(readRetellFunctionFields(fnCall), "a1marinestorage", SOURCE, RECEIVED_AT);
    const parsed = parseLeadEnvelope(env);
    expect(parsed.valid).toBe(true);
    expect(parsed.envelope?.contact.name).toBe("Dana");
    expect(parsed.envelope?.contact.phone).toBe("+14165551234");
    expect(parsed.envelope?.asset?.lengthFt).toBe(22);
    expect(parsed.envelope?.services).toEqual(["winterization"]);
    expect(parsed.envelope?.meta?.retell?.callId).toBe("call_mid_1");
  });
});
