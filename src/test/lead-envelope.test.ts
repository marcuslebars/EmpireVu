import { describe, expect, it } from "vitest";

import { parseLeadEnvelope } from "@/server/services/lead-intake/envelope";
import { keysMatch, normalizeEmail, normalizePhoneLast10 } from "@/server/services/lead-intake/matching";

describe("matching normalization", () => {
  it("normalizes email (trim + lowercase)", () => {
    expect(normalizeEmail("  Jane@Example.COM ")).toBe("jane@example.com");
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });

  it("phone matches on last 10 digits across formatting/+1 variance", () => {
    expect(normalizePhoneLast10("+1 (705) 555-0101")).toBe("7055550101");
    expect(normalizePhoneLast10("705.555.0101")).toBe("7055550101");
    expect(normalizePhoneLast10("17055550101")).toBe("7055550101");
    expect(normalizePhoneLast10("555-0101")).toBeNull(); // < 10 digits
  });

  it("keysMatch on either email or phone", () => {
    expect(keysMatch({ email: "A@b.com" }, { email: "a@b.com" })).toBe(true);
    expect(keysMatch({ phone: "+1 705 555 0101" }, { phone: "(705) 555-0101" })).toBe(true);
    expect(keysMatch({ email: "a@b.com" }, { email: "c@d.com" })).toBe(false);
    expect(keysMatch({ phone: "705-555-0101" }, { email: "a@b.com" })).toBe(false);
  });
});

describe("envelope validation (sorts, never throws)", () => {
  const base = {
    schemaVersion: 1,
    source: "a1marinestorage-contact",
    sourceSite: "a1marinestorage",
    formType: "contact",
    receivedAt: "2026-07-06T14:00:00.000Z",
    contact: { name: "Jane", email: "jane@example.com" },
  };

  it("accepts a well-formed envelope", () => {
    expect(parseLeadEnvelope(base).valid).toBe(true);
  });

  it("accepts phone-only contact (email OR phone)", () => {
    expect(parseLeadEnvelope({ ...base, contact: { phone: "705-555-0101" } }).valid).toBe(true);
  });

  it("rejects contact with neither email nor phone", () => {
    const r = parseLeadEnvelope({ ...base, contact: { name: "Nobody" } });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/email or phone/i);
  });

  it("rejects missing sourceSite (the required brand tag)", () => {
    const { sourceSite, ...noBrand } = base;
    expect(parseLeadEnvelope(noBrand).valid).toBe(false);
  });

  it("rejects an unknown schemaVersion", () => {
    expect(parseLeadEnvelope({ ...base, schemaVersion: 2 }).valid).toBe(false);
  });

  it("does not throw on garbage", () => {
    expect(parseLeadEnvelope(null).valid).toBe(false);
    expect(parseLeadEnvelope("nonsense").valid).toBe(false);
    expect(parseLeadEnvelope(42).valid).toBe(false);
  });
});
