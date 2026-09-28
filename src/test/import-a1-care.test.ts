import { describe, expect, it } from "vitest";

import {
  parseWinterizationAddon,
  personOf,
  planBooking,
  planImport,
  planQuote,
  type A1Booking,
  type A1Quote,
} from "@/server/services/imports/a1-care";

const QUOTE: A1Quote = {
  id: "q-1",
  createdAt: "2026-09-20T15:00:00.000Z",
  contactName: "Dana  Lee",
  contactEmail: "705-555-1234@no-email.a1marinecare.ca",
  contactPhone: "(705) 555-1234",
  boatLength: "24",
  boatType: "bowrider",
  services: ["Shrink Wrapping", "Winterization"],
  addons: ["winterization:outboard:2"],
  locationSlug: "midland",
  notes: "Quoted by Marina (phone).",
  estimatedTotalCents: 115325,
  requiresManualReview: false,
  channel: "marina",
  retellCallId: "call_1",
  emailPlaceholder: true,
  depositLinkSentAt: "2026-09-20T15:05:00.000Z",
  deposit: { paidAt: "2026-09-21T10:00:00.000Z", stripeSessionId: "cs_123", amountCents: 25000 },
};

const BOOKING: A1Booking = {
  id: "b-1",
  createdAt: "2026-09-21T10:01:00.000Z",
  quoteId: "q-1",
  serviceSlug: "shrink-wrapping",
  locationSlug: "midland",
  date: "2026-11-02",
  timeSlot: "09:00",
  contactName: "Dana Lee",
  contactEmail: "dana@example.com",
  contactPhone: "7055551234",
  notes: null,
  status: "pending",
  window: null,
};

describe("A1 Care import — people", () => {
  it("drops the Care site's phone-only placeholder emails and normalises the phone", () => {
    expect(personOf("Dana  Lee", "705-555-1234@no-email.a1marinecare.ca", "(705) 555-1234")).toEqual({
      name: "Dana  Lee",
      firstName: "Dana",
      lastName: "Lee",
      phone: "+17055551234",
      phoneLast10: "7055551234",
      email: null,
    });
    expect(personOf("Mike", "Mike@Example.com", "1-705-555-0000").email).toBe("mike@example.com");
  });
});

describe("A1 Care import — quotes", () => {
  it("rebuilds the priced services from the quote's boat and add-ons", () => {
    const q = planQuote(QUOTE);
    expect(q).toMatchObject({
      a1Id: "q-1",
      lengthFt: 24,
      hullType: "bowrider",
      services: [
        { serviceId: "shrink_wrap", lengthFt: 24 },
        { serviceId: "winterization_outboard", engineCount: 2 },
      ],
      quotedCents: 115325,
      manualReview: false,
      paid: { at: "2026-09-21T10:00:00.000Z", stripeSessionId: "cs_123" },
      linkSent: true,
    });
    expect(q.notes).toContain("Imported from a1marinecare quote q-1 (quoted 2026-09-20 by Marina on the phone).");
    expect(q.notes).toContain("Deposit paid on the Care site's Stripe (cs_123).");
  });

  it("reads the winterization add-on the way the Care site wrote it", () => {
    expect(parseWinterizationAddon(["winterization:inboard:3"])).toEqual({ engine: "inboard", count: 3 });
    expect(parseWinterizationAddon(["winterization:jet:1", "cover"])).toBeNull();
    expect(parseWinterizationAddon(["winterization:sterndrive:9"])).toEqual({ engine: "sterndrive", count: 4 });
  });

  it("carries a manual-review quote over as a contact only", () => {
    expect(planQuote({ ...QUOTE, requiresManualReview: true }).manualReview).toBe(true);
    expect(planQuote({ ...QUOTE, boatType: "houseboat" }).hullType).toBe("other");
  });
});

describe("A1 Care import — bookings", () => {
  it("puts a shrink wrap in its half-day window, across the November clock change", () => {
    const b = planBooking(BOOKING, "America/Toronto");
    expect(b).toMatchObject({
      windowKey: "morning",
      scheduledFor: "2026-11-02T14:00:00.000Z", // 09:00 EST
      durationMinutes: 180,
      status: "pending",
      title: "Mobile shrink wrap — Dana Lee",
      sourceRef: "a1:b-1",
      createdAt: "2026-09-21T10:01:00.000Z",
    });
    expect(planBooking({ ...BOOKING, timeSlot: "14:00" }, "America/Toronto").windowKey).toBe("afternoon");
    expect(planBooking({ ...BOOKING, window: "afternoon" }, "America/Toronto").windowKey).toBe("afternoon");
  });

  it("keeps other services at their own time, for an hour", () => {
    const b = planBooking({ ...BOOKING, serviceSlug: "boat-detailing", timeSlot: "10:00", date: "2026-10-15", status: "Confirmed" }, "America/Toronto");
    expect(b).toMatchObject({
      windowKey: null,
      scheduledFor: "2026-10-15T14:00:00.000Z",
      durationMinutes: 60,
      status: "confirmed",
      title: "Boat detailing — Dana Lee",
    });
  });
});

describe("A1 Care import — the file", () => {
  it("validates the export before planning anything", () => {
    const plan = planImport({ source: "a1marinecare", exportedAt: "x", timezone: "America/Toronto", quotes: [QUOTE], bookings: [BOOKING] });
    expect(plan.quotes).toHaveLength(1);
    expect(plan.bookings).toHaveLength(1);
    expect(() => planImport({ source: "somewhere-else", exportedAt: "x", quotes: [], bookings: [] })).toThrow();
    expect(() => planImport({ source: "a1marinecare", exportedAt: "x", quotes: [], bookings: [{ ...BOOKING, date: "Nov 2" }] })).toThrow();
  });
});
