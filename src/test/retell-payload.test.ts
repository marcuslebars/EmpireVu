import { describe, expect, it } from "vitest";

import {
  coerceBoatLengthFt,
  coerceBoolean,
  coerceEngineCount,
  coerceEngineType,
  normalizePhoneLast10,
  readBoolean,
  readFirst,
  readNumber,
  readString,
  readStringArray,
  toE164,
} from "@/server/services/retell/payload";

describe("retell payload coercers", () => {
  it("coerceBoatLengthFt from number / string / units", () => {
    expect(coerceBoatLengthFt(24)).toBe(24);
    expect(coerceBoatLengthFt("24")).toBe(24);
    expect(coerceBoatLengthFt("about 24.5 ft")).toBe(24.5);
    expect(coerceBoatLengthFt("no idea")).toBeNull();
    expect(coerceBoatLengthFt(0)).toBeNull();
    expect(coerceBoatLengthFt(null)).toBeNull();
  });

  it("coerceEngineCount, including spelled-out words", () => {
    expect(coerceEngineCount(2)).toBe(2);
    expect(coerceEngineCount("twin")).toBe(2);
    expect(coerceEngineCount("single")).toBe(1);
    expect(coerceEngineCount("triple outboards")).toBe(3);
    expect(coerceEngineCount("3")).toBe(3);
    expect(coerceEngineCount("none mentioned")).toBeNull();
  });

  it("coerceEngineType checks sterndrive/IO before outboard", () => {
    expect(coerceEngineType("outboard")).toBe("outboard");
    expect(coerceEngineType("I/O")).toBe("sterndrive");
    expect(coerceEngineType("inboard/outboard")).toBe("sterndrive");
    expect(coerceEngineType("inboard")).toBe("inboard");
    expect(coerceEngineType("jet drive")).toBeNull();
  });

  it("coerceBoolean truthiness", () => {
    expect(coerceBoolean("yes")).toBe(true);
    expect(coerceBoolean("urgent")).toBe(true);
    expect(coerceBoolean(true)).toBe(true);
    expect(coerceBoolean("no")).toBe(false);
    expect(coerceBoolean("maybe")).toBeNull();
  });

  it("normalizePhoneLast10 / toE164 (NANP + SIP)", () => {
    expect(normalizePhoneLast10("+1 (705) 555-0188")).toBe("7055550188");
    expect(normalizePhoneLast10("555-0188")).toBeNull();
    expect(toE164("7055550188")).toBe("+17055550188");
    expect(toE164("+1 705 555 0188")).toBe("+17055550188");
    expect(toE164("sip:+17055550188@carrier")).toBe("+17055550188");
    expect(toE164("123")).toBeNull();
  });
});

describe("retell payload readers (defensive, dotted paths)", () => {
  const src = {
    call: {
      from_number: "+17055550188",
      call_analysis: {
        call_summary: "Hi",
        custom_analysis_data: {
          boat_length_ft: "24 ft",
          services_requested: "winterization, shrink wrap",
          is_urgent: "yes",
          engine_count: "twin",
        },
      },
    },
  };

  it("readString across candidate + dotted paths", () => {
    expect(readString(src, ["call.call_analysis.call_summary"])).toBe("Hi");
    expect(readString(src, ["nope", "call.from_number"])).toBe("+17055550188");
    expect(readString(src, ["missing"])).toBeNull();
  });

  it("readNumber tolerates unit strings", () => {
    expect(readNumber(src, ["call.call_analysis.custom_analysis_data.boat_length_ft"])).toBe(24);
  });

  it("readStringArray splits comma strings", () => {
    expect(readStringArray(src, ["call.call_analysis.custom_analysis_data.services_requested"])).toEqual([
      "winterization",
      "shrink wrap",
    ]);
  });

  it("readBoolean + readFirst", () => {
    expect(readBoolean(src, ["call.call_analysis.custom_analysis_data.is_urgent"])).toBe(true);
    expect(readFirst(src, ["x", "call.call_analysis.custom_analysis_data.engine_count"])).toBe("twin");
    expect(readFirst(src, ["x"])).toBeUndefined();
  });
});
