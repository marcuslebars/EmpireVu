import { describe, expect, it } from "vitest";

import {
  computeResumeAt,
  localDailySlotUtcMs,
  parseDuration,
  resolveUntil,
} from "@/server/services/workflow-engine/timing";
import type { MessageTemplateData } from "@/server/services/workflow-engine/interpolate";

function templateData(over: Partial<MessageTemplateData> = {}): MessageTemplateData {
  return { contact: null, company: null, booking: null, quote: null, fields: {}, ...over };
}

describe("parseDuration", () => {
  it("parses each unit into milliseconds", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("4h")).toBe(14_400_000);
    expect(parseDuration("2d")).toBe(172_800_000);
    expect(parseDuration("1w")).toBe(604_800_000);
  });

  it("tolerates whitespace, decimals, and mixed case", () => {
    expect(parseDuration(" 2 d ")).toBe(172_800_000);
    expect(parseDuration("1.5h")).toBe(5_400_000);
    expect(parseDuration("3D")).toBe(259_200_000);
  });

  it("returns null for unparseable specs", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("10")).toBeNull();
    expect(parseDuration("10y")).toBeNull();
    expect(parseDuration("d")).toBeNull();
  });
});

describe("resolveUntil", () => {
  const data = templateData({
    booking: { scheduled_for: "2026-09-20T10:00:00.000Z" },
    fields: { follow_up_at: "2026-09-21T00:00:00.000Z" },
  });

  it("resolves a bare path to that instant", () => {
    expect(resolveUntil("booking.scheduled_for", data)).toBe("2026-09-20T10:00:00.000Z");
  });

  it("applies a negative offset (N before the field)", () => {
    expect(resolveUntil("booking.scheduled_for - 24h", data)).toBe("2026-09-19T10:00:00.000Z");
  });

  it("applies a positive offset (N after the field)", () => {
    expect(resolveUntil("booking.scheduled_for + 2h", data)).toBe("2026-09-20T12:00:00.000Z");
  });

  it("resolves a bare event field via the fields fallback", () => {
    expect(resolveUntil("follow_up_at + 0h", data)).toBe("2026-09-21T00:00:00.000Z");
  });

  it("returns null when the path is missing or not a date", () => {
    expect(resolveUntil("booking.scheduled_for - 24h", templateData())).toBeNull();
    expect(resolveUntil("contact.first_name", templateData({ contact: { first_name: "Jane" } }))).toBeNull();
  });
});

describe("computeResumeAt", () => {
  const NOW = Date.parse("2026-09-15T12:00:00.000Z");

  it("prefers duration: now + duration", () => {
    expect(computeResumeAt({ duration: "2d" }, templateData(), NOW)).toBe("2026-09-17T12:00:00.000Z");
  });

  it("uses until when there is no duration", () => {
    const data = templateData({ booking: { scheduled_for: "2026-09-20T10:00:00.000Z" } });
    expect(computeResumeAt({ until: "booking.scheduled_for - 24h" }, data, NOW)).toBe("2026-09-19T10:00:00.000Z");
  });

  it("falls back to now when neither resolves (never stalls forever)", () => {
    expect(computeResumeAt({ until: "booking.scheduled_for" }, templateData(), NOW)).toBe("2026-09-15T12:00:00.000Z");
    expect(computeResumeAt({}, templateData(), NOW)).toBe("2026-09-15T12:00:00.000Z");
  });
});

describe("localDailySlotUtcMs (America/Toronto, DST-safe)", () => {
  const TZ = "America/Toronto";
  const at = (iso: string) => localDailySlotUtcMs("08:00", TZ, Date.parse(iso));
  const localHhmm = (ms: number) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
      new Date(ms),
    );

  it("maps 08:00 local to 13:00Z in winter (EST, UTC-5)", () => {
    expect(new Date(at("2026-01-15T18:00:00Z")).toISOString()).toBe("2026-01-15T13:00:00.000Z");
  });

  it("maps 08:00 local to 12:00Z in summer (EDT, UTC-4)", () => {
    expect(new Date(at("2026-07-15T18:00:00Z")).toISOString()).toBe("2026-07-15T12:00:00.000Z");
  });

  it("holds 08:00 local across the spring-forward boundary (Mar 8, 2026)", () => {
    // Day before is still EST; the transition day is already EDT.
    expect(new Date(at("2026-03-07T18:00:00Z")).toISOString()).toBe("2026-03-07T13:00:00.000Z");
    expect(new Date(at("2026-03-08T18:00:00Z")).toISOString()).toBe("2026-03-08T12:00:00.000Z");
  });

  it("holds 08:00 local across the fall-back boundary (Nov 1, 2026)", () => {
    expect(new Date(at("2026-10-31T18:00:00Z")).toISOString()).toBe("2026-10-31T12:00:00.000Z");
    expect(new Date(at("2026-11-01T18:00:00Z")).toISOString()).toBe("2026-11-01T13:00:00.000Z");
  });

  it("always lands on 08:00 wall-clock regardless of season", () => {
    for (const iso of ["2026-01-15", "2026-03-08", "2026-07-15", "2026-11-01"]) {
      expect(localHhmm(at(`${iso}T18:00:00Z`))).toBe("08:00");
    }
  });
});
