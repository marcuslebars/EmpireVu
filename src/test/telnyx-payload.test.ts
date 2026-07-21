import { describe, expect, it } from "vitest";

import {
  coerceBoatLengthFt,
  coerceBoolean,
  coerceEngineType,
  extractCalledNumber,
  extractCallerNumber,
  extractConversationId,
  normalizePhoneLast10,
  readNumber,
  readString,
  readStringArray,
  toE164,
} from "@/server/services/telnyx/payload";

describe("caller/called number extraction", () => {
  it("reads the documented nested shape", () => {
    const payload = { call: { from: "+14165551234", to: "+19055559876" } };
    expect(extractCallerNumber(payload)).toBe("+14165551234");
    expect(extractCalledNumber(payload)).toBe("+19055559876");
  });

  it("falls back to the telnyx_* target fields", () => {
    const payload = {
      telnyx_agent_target: "+19055559876",
      telnyx_end_user_target: "+14165551234",
    };
    expect(extractCallerNumber(payload)).toBe("+14165551234");
    expect(extractCalledNumber(payload)).toBe("+19055559876");
  });

  it("falls back to flat from/to", () => {
    expect(extractCallerNumber({ from: "+14165551234" })).toBe("+14165551234");
    expect(extractCalledNumber({ to: "+19055559876" })).toBe("+19055559876");
  });

  it("returns null rather than throwing on junk", () => {
    expect(extractCallerNumber(null)).toBeNull();
    expect(extractCallerNumber({ call: "not-an-object" })).toBeNull();
    expect(extractCallerNumber({ call: { from: "   " } })).toBeNull();
    expect(extractCalledNumber(undefined)).toBeNull();
  });

  it("finds the conversation id across shapes", () => {
    expect(extractConversationId({ telnyx_conversation_id: "conv_1" })).toBe("conv_1");
    expect(extractConversationId({ data: { conversation_id: "conv_2" } })).toBe("conv_2");
    expect(extractConversationId({})).toBeNull();
  });
});

describe("normalizePhoneLast10 (Ontario edge cases)", () => {
  it("matches the same number in every format a caller might arrive as", () => {
    const expected = "4165551234";
    expect(normalizePhoneLast10("+14165551234")).toBe(expected);
    expect(normalizePhoneLast10("14165551234")).toBe(expected);
    expect(normalizePhoneLast10("4165551234")).toBe(expected);
    expect(normalizePhoneLast10("(416) 555-1234")).toBe(expected);
    expect(normalizePhoneLast10("416.555.1234")).toBe(expected);
    expect(normalizePhoneLast10("+1 (416) 555-1234")).toBe(expected);
    expect(normalizePhoneLast10(" 416 555 1234 ")).toBe(expected);
  });

  it("is null below 10 digits (too weak to match on)", () => {
    expect(normalizePhoneLast10("5551234")).toBeNull();
    expect(normalizePhoneLast10("")).toBeNull();
    expect(normalizePhoneLast10(null)).toBeNull();
    expect(normalizePhoneLast10(undefined)).toBeNull();
  });
});

describe("toE164", () => {
  it("normalizes NANP input", () => {
    expect(toE164("4165551234")).toBe("+14165551234");
    expect(toE164("14165551234")).toBe("+14165551234");
    expect(toE164("(416) 555-1234")).toBe("+14165551234");
    expect(toE164("+14165551234")).toBe("+14165551234");
  });

  it("strips SIP/tel schemes and host parts", () => {
    expect(toE164("sip:+14165551234@sip.telnyx.com")).toBe("+14165551234");
    expect(toE164("tel:+14165551234")).toBe("+14165551234");
  });

  it("returns null when there is no plausible number", () => {
    expect(toE164("hello")).toBeNull();
    expect(toE164("")).toBeNull();
    expect(toE164(null)).toBeNull();
  });
});

describe("coerceBoatLengthFt (the LLM sends anything)", () => {
  it("accepts numbers and numeric strings", () => {
    expect(coerceBoatLengthFt(24)).toBe(24);
    expect(coerceBoatLengthFt("24")).toBe(24);
    expect(coerceBoatLengthFt("24.5")).toBe(24.5);
  });

  it("accepts spoken-style strings", () => {
    expect(coerceBoatLengthFt("24 feet")).toBe(24);
    expect(coerceBoatLengthFt("24ft")).toBe(24);
    expect(coerceBoatLengthFt("about 24'")).toBe(24);
    expect(coerceBoatLengthFt("it's a 26 footer")).toBe(26);
  });

  it("rejects values that would price a guess", () => {
    expect(coerceBoatLengthFt("not sure")).toBeNull();
    expect(coerceBoatLengthFt(null)).toBeNull();
    expect(coerceBoatLengthFt(0)).toBeNull();
    expect(coerceBoatLengthFt(-10)).toBeNull();
  });
});

describe("coerceEngineType", () => {
  it("maps the common phrasings", () => {
    expect(coerceEngineType("outboard")).toBe("outboard");
    expect(coerceEngineType("Outboard motor")).toBe("outboard");
    expect(coerceEngineType("sterndrive")).toBe("sterndrive");
    expect(coerceEngineType("inboard")).toBe("inboard");
  });

  it("resolves I/O phrasing to sterndrive, not inboard", () => {
    expect(coerceEngineType("I/O")).toBe("sterndrive");
    expect(coerceEngineType("inboard/outboard")).toBe("sterndrive");
    expect(coerceEngineType("stern drive")).toBe("sterndrive");
  });

  it("returns null when unknown", () => {
    expect(coerceEngineType("jet drive")).toBeNull();
    expect(coerceEngineType("")).toBeNull();
    expect(coerceEngineType(null)).toBeNull();
  });
});

describe("misc readers", () => {
  it("reads numbers from money-ish strings", () => {
    expect(readNumber({ quote_total: "$1,340.50" }, ["quote_total"])).toBe(1340.5);
    expect(readNumber({ quote_total: 340 }, ["quote_total"])).toBe(340);
    expect(readNumber({}, ["quote_total"])).toBeNull();
  });

  it("reads arrays, single strings and comma lists", () => {
    expect(readStringArray({ services: ["a", "b"] }, ["services"])).toEqual(["a", "b"]);
    expect(readStringArray({ services: "shrink wrap, winterization" }, ["services"])).toEqual([
      "shrink wrap",
      "winterization",
    ]);
    expect(readStringArray({}, ["services"])).toEqual([]);
  });

  it("reads dotted paths", () => {
    expect(readString({ contact: { name: "Marcus" } }, ["contact.name"])).toBe("Marcus");
  });

  it("coerces loose booleans", () => {
    expect(coerceBoolean("yes")).toBe(true);
    expect(coerceBoolean("no")).toBe(false);
    expect(coerceBoolean(true)).toBe(true);
    expect(coerceBoolean("maybe")).toBeNull();
  });
});
