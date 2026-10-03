import { describe, expect, it } from "vitest";

import { DEFAULT_BOOKING_POLICY } from "@/server/services/booking-windows";
import { planLeadBooking } from "@/server/services/lead-intake/intake";

const TZ = "America/Toronto";
const POLICY = DEFAULT_BOOKING_POLICY; // morning 09:00 (180m), afternoon 13:00 (180m)

describe("planLeadBooking (web-form bookings onto the calendar)", () => {
  it("reads the form's time in the company's zone, not UTC", () => {
    // 1:00 pm Toronto in October (EDT) is 17:00 UTC — the old parser stored 13:00 UTC (9am).
    expect(planLeadBooking("2026-10-13", "13:00", null, TZ)).toEqual({
      scheduledFor: "2026-10-13T17:00:00.000Z",
      windowKey: null,
    });
  });

  it("snaps to the half-day window the time falls in", () => {
    expect(planLeadBooking("2026-10-13", "13:00", POLICY, TZ)).toMatchObject({ scheduledFor: "2026-10-13T17:00:00.000Z", windowKey: "afternoon", durationMinutes: 180 });
    expect(planLeadBooking("2026-10-13", "16:00", POLICY, TZ)).toMatchObject({ windowKey: "afternoon", scheduledFor: "2026-10-13T17:00:00.000Z" });
    expect(planLeadBooking("2026-10-13", "11:00", POLICY, TZ)).toMatchObject({ windowKey: "morning", scheduledFor: "2026-10-13T13:00:00.000Z" });
    expect(planLeadBooking("2026-10-13", "09:00", POLICY, TZ)).toMatchObject({ windowKey: "morning" });
  });

  it("puts a time before the first window into the first window", () => {
    expect(planLeadBooking("2026-10-13", "08:00", POLICY, TZ)).toMatchObject({ windowKey: "morning", scheduledFor: "2026-10-13T13:00:00.000Z" });
    expect(planLeadBooking("2026-10-13", "8:00", POLICY, TZ)).toMatchObject({ windowKey: "morning" });
  });

  it("handles a missing or odd time, and DST", () => {
    expect(planLeadBooking("2026-10-13", undefined, POLICY, TZ)).toMatchObject({ windowKey: "morning" });
    expect(planLeadBooking("2026-10-13", "afternoon-ish", POLICY, TZ)).toMatchObject({ windowKey: "morning" });
    // After the November DST change Toronto is UTC-5: 1pm = 18:00 UTC.
    expect(planLeadBooking("2026-11-16", "13:00", POLICY, TZ)).toMatchObject({ scheduledFor: "2026-11-16T18:00:00.000Z" });
  });

  it("refuses a missing or invalid date", () => {
    expect(planLeadBooking(undefined, "13:00", POLICY, TZ)).toBeNull();
    expect(planLeadBooking("not-a-date", "13:00", POLICY, TZ)).toBeNull();
  });
});
