import { describe, expect, it } from "vitest";

import { parseLeadEnvelope } from "@/server/services/lead-intake/envelope";
import {
  buildLeadEnvelope,
  readTelnyxLeadFields,
  TELNYX_LEAD_SOURCE,
} from "@/server/services/telnyx/lead-adapter";
import { raceWithFallback } from "@/server/services/telnyx/dynamic-variables";

const RECEIVED_AT = "2026-07-20T15:04:05.000Z";

describe("telnyx lead adapter → canonical envelope", () => {
  const payload = {
    boat_length: "24 feet",
    boat_type: "bowrider",
    callback_preference: "weekday mornings",
    deposit_amount: 100,
    email: "marcus@example.com",
    name: "Marcus Le Bars",
    notes: "Wants the boat wrapped before the first frost.",
    phone: "(416) 555-1234",
    quote_total: 340,
    services_selected: ["shrink wrap", "winterization"],
    telnyx_conversation_id: "conv_abc123",
  };

  it("produces an envelope the existing intake schema accepts", () => {
    const envelope = buildLeadEnvelope(readTelnyxLeadFields(payload), "a1marinestorage", RECEIVED_AT);
    const parsed = parseLeadEnvelope(envelope);

    expect(parsed.reason).toBeNull();
    expect(parsed.valid).toBe(true);
  });

  it("maps the captured fields onto the canonical shape", () => {
    const envelope = buildLeadEnvelope(readTelnyxLeadFields(payload), "a1marinestorage", RECEIVED_AT);
    const parsed = parseLeadEnvelope(envelope);
    if (!parsed.valid || !parsed.envelope) throw new Error("expected a valid envelope");

    const result = parsed.envelope;
    expect(result.source).toBe(TELNYX_LEAD_SOURCE);
    expect(result.sourceSite).toBe("a1marinestorage");
    // A quote was given on the call, so it's a quote — never "booking", which
    // would have intake create a real appointment from a callback preference.
    expect(result.formType).toBe("quote");
    expect(result.contact.name).toBe("Marcus Le Bars");
    expect(result.contact.email).toBe("marcus@example.com");
    expect(result.contact.phone).toBe("+14165551234");
    expect(result.asset?.lengthFt).toBe(24);
    expect(result.asset?.type).toBe("bowrider");
    // Money crosses into the envelope in CENTS.
    expect(result.lineItems?.[0]?.unitPriceCents).toBe(34_000);
    expect(result.message).toContain("weekday mornings");
    expect(result.message).toContain("conv_abc123");
  });

  it("falls back to a contact enquiry when no price was quoted", () => {
    const { quote_total: _omitted, ...withoutQuote } = payload;
    const envelope = buildLeadEnvelope(
      readTelnyxLeadFields(withoutQuote),
      "a1marinecare",
      RECEIVED_AT,
    );
    const parsed = parseLeadEnvelope(envelope);

    expect(parsed.valid).toBe(true);
    expect(parsed.envelope?.formType).toBe("contact");
    expect(parsed.envelope?.lineItems).toBeUndefined();
  });

  it("still builds a valid envelope from a phone-only call", () => {
    const envelope = buildLeadEnvelope(
      readTelnyxLeadFields({ phone: "4165551234", telnyx_conversation_id: "conv_x" }),
      "a1marinecare",
      RECEIVED_AT,
    );
    const parsed = parseLeadEnvelope(envelope);

    expect(parsed.valid).toBe(true);
    expect(parsed.envelope?.contact.phone).toBe("+14165551234");
  });

  it("is rejected by the schema when the call captured no way to reach them", () => {
    const envelope = buildLeadEnvelope(readTelnyxLeadFields({ name: "Anon" }), "a1marinecare", RECEIVED_AT);
    const parsed = parseLeadEnvelope(envelope);

    // Intake stores this raw and flags it rather than dropping it — the adapter
    // must not pretend it's valid.
    expect(parsed.valid).toBe(false);
  });
});

describe("raceWithFallback (endpoint 1's 800ms guard)", () => {
  it("returns the real result when it lands in time", async () => {
    const result = await raceWithFallback(async () => "real", "fallback", 200);
    expect(result).toBe("real");
  });

  it("returns the fallback when the work overruns the budget", async () => {
    const started = Date.now();
    const result = await raceWithFallback(
      () => new Promise<string>((resolve) => setTimeout(() => resolve("too-slow"), 1_000)),
      "fallback",
      50,
    );

    expect(result).toBe("fallback");
    // Must give up near the budget, not wait out the slow work.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("returns the fallback when the work throws", async () => {
    const result = await raceWithFallback(
      async () => {
        throw new Error("database down");
      },
      "fallback",
      200,
    );
    expect(result).toBe("fallback");
  });
});
