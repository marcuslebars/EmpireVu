import { describe, expect, it, vi } from "vitest";

import golden from "@/server/services/__fixtures__/a1-care-booking-windows-golden.json";
import {
  checkWindow,
  DEFAULT_BOOKING_POLICY,
  findOpenWindows,
  parseBookingPolicy,
  parseWindowKey,
  windowLoad,
  zonedInstant,
  type BusyBooking,
} from "@/server/services/booking-windows";
import { parseRetellFunctionBody } from "@/server/services/retell/functions";
import {
  runAvailability,
  runBook,
  bookForTenant,
  availabilityForTenant,
  runDepositLink,
  type BookingDeps,
  type BookingTenant,
  type ContactForMessage,
  type QuoteForBooking,
} from "@/server/services/retell/tools/booking";
import type { Tables } from "@/server/db/database.types";

const TZ = "America/Toronto";
const MORNING_SLOTS = ["08:00", "09:00", "10:00", "11:00"];

/** The Care site's slot counts → EmpireVu bookings booked into windows. */
function busyFromCounts(counts: Array<{ date: string; timeSlot: string; count: number }>): BusyBooking[] {
  return counts.flatMap((c) => {
    const windowKey = MORNING_SLOTS.includes(c.timeSlot) ? "morning" : "afternoon";
    const at = zonedInstant(c.date, windowKey === "morning" ? "09:00" : "13:00", TZ).toISOString();
    return Array.from({ length: c.count }, () => ({ scheduledFor: at, durationMinutes: 180, windowKey }));
  });
}

describe("booking windows — parity with the Care site's availability", () => {
  it.each(golden.cases.map((c, i) => [i, c] as const))("case %i offers the same windows", (_i, c) => {
    const slots = findOpenWindows({
      now: new Date(c.now),
      timeZone: TZ,
      policy: DEFAULT_BOOKING_POLICY,
      bookings: busyFromCounts(c.counts),
      preferredDate: c.preferredDate,
      preferredWindow: c.preferredWindow,
      limit: 3,
    });
    expect(slots.map((s) => ({ date: s.date, window: s.windowKey, label: s.label, remaining: s.remaining }))).toEqual(c.slots);
  });
});

describe("booking windows — the policy", () => {
  it("is off unless the company sets one", () => {
    expect(parseBookingPolicy(null)).toBeNull();
  });

  it("fills a partial policy from the defaults", () => {
    const p = parseBookingPolicy({ mode: "windows", capacityPerWindow: 3, workingDays: [5, 1, 1] });
    expect(p).toMatchObject({ capacityPerWindow: 3, workingDays: [1, 5], leadTimeHours: 24, windows: DEFAULT_BOOKING_POLICY.windows });
  });

  it("falls back to the defaults rather than refusing on a malformed policy", () => {
    expect(parseBookingPolicy({ mode: "windows", capacityPerWindow: -4 })).toEqual(DEFAULT_BOOKING_POLICY);
  });

  it("understands how callers say a window", () => {
    expect(parseWindowKey("Morning please", DEFAULT_BOOKING_POLICY)).toBe("morning");
    expect(parseWindowKey("PM", DEFAULT_BOOKING_POLICY)).toBe("afternoon");
    expect(parseWindowKey("evening", DEFAULT_BOOKING_POLICY)).toBeNull();
  });

  it("puts a window at the right instant across the November DST change", () => {
    expect(zonedInstant("2026-10-30", "09:00", TZ).toISOString()).toBe("2026-10-30T13:00:00.000Z");
    expect(zonedInstant("2026-11-02", "09:00", TZ).toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });

  it("counts a job added by hand in the app against the window it overlaps", () => {
    const manual: BusyBooking = { scheduledFor: "2026-09-29T14:30:00Z", durationMinutes: 60 }; // 10:30 local
    const w = DEFAULT_BOOKING_POLICY.windows[0];
    expect(windowLoad([manual], "2026-09-29", w, TZ)).toBe(1);
    expect(windowLoad([manual], "2026-09-29", DEFAULT_BOOKING_POLICY.windows[1], TZ)).toBe(0);
  });

  it("refuses a Sunday, a full window, and anything inside the lead time", () => {
    const now = new Date("2026-09-27T14:00:00Z"); // Sunday 10:00 Toronto
    const base = { now, timeZone: TZ, policy: DEFAULT_BOOKING_POLICY };
    expect(checkWindow({ ...base, bookings: [], date: "2026-10-04", windowKey: "morning" })).toEqual({ ok: false, reason: "not_bookable" });
    expect(checkWindow({ ...base, bookings: [], date: "2026-09-27", windowKey: "afternoon" })).toEqual({ ok: false, reason: "not_bookable" });
    const full = busyFromCounts([{ date: "2026-09-29", timeSlot: "09:00", count: 2 }]);
    expect(checkWindow({ ...base, bookings: full, date: "2026-09-29", windowKey: "morning" })).toEqual({ ok: false, reason: "full" });
    expect(checkWindow({ ...base, bookings: full, date: "2026-09-29", windowKey: "afternoon" })).toMatchObject({
      ok: true,
      window: { label: "Tuesday, September 29th in the afternoon", startsAt: "2026-09-29T17:00:00.000Z", remaining: 2 },
    });
  });
});

// ── The tools, with the database swapped out ───────────────────────────────────

const TENANT: BookingTenant = {
  organizationId: "org_1",
  companyId: "co_care",
  companyName: "A1 Marine Care",
  agentName: "Marina",
  timeZone: TZ,
  policy: DEFAULT_BOOKING_POLICY,
};
const QUOTE_ID = "11111111-2222-3333-4444-555555555555";
const QUOTE: QuoteForBooking = {
  id: QUOTE_ID,
  organization_id: "org_1",
  company_id: "co_care",
  contact_id: "contact_1",
  public_token: "tok123",
  quote_number: "Q-1042",
  title: "Mobile shrink wrap — 24 ft bowrider",
  status: "sent",
  subtotal_cents: 67200,
  deposit_cents: 25000,
  deposit_flat_cents: 25000,
  deposit_paid_at: null,
  input_snapshot: {},
};
const CONTACT: ContactForMessage = {
  id: "contact_1",
  first_name: "Dana",
  last_name: "Lee",
  phone: "+17055551234",
  email: null,
  sms_opt_out_at: null,
  email_opt_out_at: null,
  sms_consent_at: "2026-09-27T13:00:00Z",
  consent_source: "implied_inquiry",
};

function fakeDeps(overrides: Partial<BookingDeps> = {}) {
  const inserted: unknown[] = [];
  const texts: Array<{ to: string; body: string }> = [];
  const events: Array<{ type: string; meta: unknown }> = [];
  const deps: BookingDeps = {
    resolveBookingTenant: vi.fn(async () => TENANT),
    loadBusy: vi.fn(async () => []),
    loadQuote: vi.fn(async (_t, id: string) => (id === QUOTE_ID ? QUOTE : null)),
    loadContact: vi.fn(async () => CONTACT),
    findBookingForCall: vi.fn(async () => null),
    nextBookingForQuote: vi.fn(async () => null),
    insertBooking: vi.fn(async (_t, row) => {
      inserted.push(row);
      return {
        booking: { id: "booking_1", scheduled_for: row.window.startsAt, window_key: row.window.windowKey } as Tables<"bookings">,
        duplicate: false,
      };
    }),
    sendText: vi.fn(async (_t, to, body) => {
      texts.push({ to: to.phone, body });
      return { status: "sent" };
    }),
    sendEmail: vi.fn(async () => ({ status: "sent" })),
    recordQuoteEvent: vi.fn(async (_t, _q, type, meta) => {
      events.push({ type, meta });
    }),
    quoteUrl: (t) => `https://quotes.example.com/q/${t}`,
    now: () => new Date("2026-09-27T14:00:00Z"),
    ...overrides,
  };
  return { deps, inserted, texts, events };
}

const req = <T,>(args: T, call: Record<string, unknown> = { call_id: "call_9", from_number: "+17055551234", to_number: "+17059961010" }) =>
  parseRetellFunctionBody<T>({ args, call });

describe("check_availability", () => {
  it("offers the next three openings with labels to read", async () => {
    const { deps } = fakeDeps();
    const res = await runAvailability(req({}), deps);
    expect(res).toMatchObject({
      ok: true,
      slots: [
        { date: "2026-09-28", window: "morning", label: "Monday, September 28th in the morning" },
        { date: "2026-09-28", window: "afternoon" },
        { date: "2026-09-29", window: "morning" },
      ],
      say: "The next openings are Monday, September 28th in the morning, or Monday, September 28th in the afternoon, or Tuesday, September 29th in the morning.",
    });
  });

  it("confirms a preferred window that's open", async () => {
    const { deps } = fakeDeps();
    const res = await runAvailability(req({ preferred_date: "2026-10-02", preferred_window: "afternoon" }), deps);
    expect(res).toMatchObject({ ok: true, preferred_open: true, say: "Friday, October 2nd in the afternoon is open." });
  });

  it("hands off when the company doesn't book by window", async () => {
    const { deps } = fakeDeps({ resolveBookingTenant: vi.fn(async () => null) });
    expect(await runAvailability(req({}), deps)).toMatchObject({ ok: false, reason: "unsupported" });
  });

  it("promises a callback if the calendar can't be read", async () => {
    const { deps } = fakeDeps({ loadBusy: vi.fn(async () => { throw new Error("db"); }) });
    expect(await runAvailability(req({}), deps)).toMatchObject({ ok: false, reason: "error", say: expect.stringMatching(/within the hour/) });
  });
});

describe("book_wrap_date", () => {
  it("books the window against the quote, tagged with the call", async () => {
    const { deps, inserted } = fakeDeps();
    const res = await runBook(req({ quote_id: QUOTE_ID, date: "2026-09-29", window: "morning" }), deps);
    expect(res).toMatchObject({
      ok: true,
      booking_id: "booking_1",
      label: "Tuesday, September 29th in the morning",
      say: "You're booked for Tuesday, September 29th in the morning. We'll text to confirm the arrival time the day before.",
    });
    expect(inserted[0]).toMatchObject({
      quoteId: QUOTE_ID,
      contactId: "contact_1",
      callId: "call_9",
      title: "Mobile shrink wrap — Dana Lee (24 ft bowrider)",
      window: { windowKey: "morning", startsAt: "2026-09-29T13:00:00.000Z", durationMinutes: 180 },
    });
  });

  it("returns the existing booking when the same call books the same quote again", async () => {
    const { deps } = fakeDeps({
      findBookingForCall: vi.fn(async () => ({ id: "booking_0", scheduled_for: "2026-09-29T17:00:00Z", window_key: "afternoon" }) as Tables<"bookings">),
    });
    const res = await runBook(req({ quote_id: QUOTE_ID, date: "2026-09-30", window: "morning" }), deps);
    expect(res).toMatchObject({ ok: true, booking_id: "booking_0", duplicate: true, say: "You're already booked for Tuesday, September 29th in the afternoon." });
    expect(deps.insertBooking).not.toHaveBeenCalled();
  });

  it("offers the closest alternatives when the window is full", async () => {
    const full = busyFromCounts([{ date: "2026-09-29", timeSlot: "09:00", count: 2 }]);
    const { deps } = fakeDeps({ loadBusy: vi.fn(async () => full) });
    const res = await runBook(req({ quote_id: QUOTE_ID, date: "2026-09-29", window: "morning" }), deps);
    expect(res).toMatchObject({ ok: false, reason: "slot_taken" });
    if (!("alternatives" in res)) throw new Error("expected alternatives");
    expect(res.alternatives?.[0]).toMatchObject({ date: "2026-09-29", window: "afternoon" });
    expect(res.say).toMatch(/^That window just filled up\. Closest openings are Tuesday, September 29th in the afternoon/);
    expect(deps.insertBooking).not.toHaveBeenCalled();
  });

  it("won't book today when the crew needs a day's notice", async () => {
    const { deps } = fakeDeps();
    const res = await runBook(req({ quote_id: QUOTE_ID, date: "2026-09-27", window: "afternoon" }), deps);
    expect(res).toMatchObject({ ok: false, reason: "not_bookable", say: expect.stringMatching(/^That's too soon/) });
  });

  it("won't book against a quote from another company", async () => {
    const { deps } = fakeDeps();
    const res = await runBook(req({ quote_id: "99999999-2222-3333-4444-555555555555", date: "2026-09-29", window: "morning" }), deps);
    expect(res).toMatchObject({ ok: false, reason: "quote_not_found" });
    expect(deps.insertBooking).not.toHaveBeenCalled();
  });

  it("asks for what's missing", async () => {
    const { deps } = fakeDeps();
    expect(await runBook(req({ quote_id: QUOTE_ID, window: "noonish" }), deps)).toMatchObject({
      ok: false,
      reason: "missing_info",
      missing: ["date", "window"],
    });
  });
});

describe("tenant-taking cores (shared with the text-message agent)", () => {
  it("availabilityForTenant answers the same as the phone tool, without a call", async () => {
    const { deps } = fakeDeps();
    const viaCall = await runAvailability(req({ preferred_date: "2026-10-02", preferred_window: "afternoon" }), deps);
    const direct = await availabilityForTenant(TENANT, { preferred_date: "2026-10-02", preferred_window: "afternoon" }, deps);
    expect(direct).toEqual(viaCall);
    expect(deps.resolveBookingTenant).toHaveBeenCalledTimes(1);
  });

  it("bookForTenant books off the phone with its own source and no call id", async () => {
    const { deps, inserted } = fakeDeps();
    const res = await bookForTenant(TENANT, { quote_id: QUOTE_ID, date: "2026-09-29", window: "morning" }, deps, {
      callId: null,
      source: "sms_agent",
      bookedBy: "Booked by the text-message assistant.",
    });
    expect(res).toMatchObject({ ok: true, booking_id: "booking_1" });
    expect(deps.findBookingForCall).not.toHaveBeenCalled();
    expect(inserted[0]).toMatchObject({ callId: null, source: "sms_agent", description: expect.stringMatching(/^Booked by the text-message assistant\./) });
  });
});

describe("send_deposit_link", () => {
  it("texts the hosted quote page and records that it went out", async () => {
    const { deps, texts, events } = fakeDeps({
      nextBookingForQuote: vi.fn(async () => ({ scheduled_for: "2026-09-29T13:00:00Z", window_key: "morning" }) as Tables<"bookings">),
    });
    const res = await runDepositLink(req({ quote_id: QUOTE_ID }), deps);
    expect(res).toMatchObject({
      ok: true,
      sent_by: ["sms"],
      amount_dollars: 250,
      say: "I've just texted you the link. Tap it to approve the quote and pay the $250 deposit — it comes straight off your final invoice.",
    });
    expect(texts[0]).toEqual({
      to: "+17055551234",
      body:
        "Hi Dana, it's Marina from A1 Marine Care. Here's your quote — $672 + HST. Tap to approve it and pay the $250 deposit " +
        "that holds Tuesday, September 29 in the morning (it comes off your final invoice): https://quotes.example.com/q/tok123",
    });
    expect(events).toEqual([{ type: "deposit_link_sent", meta: { channels: ["sms"], by: "marina", callId: "call_9" } }]);
  });

  it("texts the better number when the caller gives one", async () => {
    const { deps, texts } = fakeDeps();
    await runDepositLink(req({ quote_id: QUOTE_ID, phone: "705-555-0000" }), deps);
    expect(texts[0].to).toBe("+17055550000");
  });

  it("says so when the deposit is already paid, and sends nothing", async () => {
    const { deps } = fakeDeps({ loadQuote: vi.fn(async () => ({ ...QUOTE, deposit_paid_at: "2026-09-26T00:00:00Z" })) });
    expect(await runDepositLink(req({ quote_id: QUOTE_ID }), deps)).toMatchObject({ ok: false, reason: "already_paid" });
    expect(deps.sendText).not.toHaveBeenCalled();
  });

  it("falls back to email when the text is blocked (opted out)", async () => {
    const { deps } = fakeDeps({
      loadContact: vi.fn(async () => ({ ...CONTACT, email: "dana@example.com" })),
      sendText: vi.fn(async () => ({ status: "blocked", reason: "opted_out" })),
    });
    const res = await runDepositLink(req({ quote_id: QUOTE_ID }), deps);
    expect(res).toMatchObject({ ok: true, sent_by: ["email"], say: expect.stringMatching(/^I've just emailed you the link/) });
  });

  it("keeps the caller calm when nothing could be sent", async () => {
    const { deps, events } = fakeDeps({ sendText: vi.fn(async () => ({ status: "failed", reason: "twilio 500" })) });
    const res = await runDepositLink(req({ quote_id: QUOTE_ID }), deps);
    expect(res).toMatchObject({ ok: false, reason: "send_failed", say: expect.stringMatching(/noted the spot as held/) });
    expect(events).toEqual([]);
  });

  it("won't send a link for a draft or cancelled quote", async () => {
    const { deps } = fakeDeps({ loadQuote: vi.fn(async () => ({ ...QUOTE, status: "cancelled" })) });
    expect(await runDepositLink(req({ quote_id: QUOTE_ID }), deps)).toMatchObject({ ok: false, reason: "not_payable" });
  });

  it("tells the owner when the caller was promised a link that didn't go out", async () => {
    const reportLinkFailure = vi.fn(async () => {});
    const { deps } = fakeDeps({ sendText: vi.fn(async () => ({ status: "failed", reason: "twilio 500" })), reportLinkFailure });
    await runDepositLink(req({ quote_id: QUOTE_ID }), deps);
    expect(reportLinkFailure).toHaveBeenCalledWith(expect.anything(), {
      quoteId: QUOTE_ID,
      contactId: QUOTE.contact_id,
      why: "the text failed",
    });
  });

  it("tells the owner when the quote isn't payable, but not when it's already paid or sent fine", async () => {
    const reportLinkFailure = vi.fn(async () => {});
    const notPayable = fakeDeps({ loadQuote: vi.fn(async () => ({ ...QUOTE, status: "cancelled" })), reportLinkFailure });
    await runDepositLink(req({ quote_id: QUOTE_ID }), notPayable.deps);
    expect(reportLinkFailure).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ why: "the quote isn't ready to pay" }));

    reportLinkFailure.mockClear();
    const paid = fakeDeps({ loadQuote: vi.fn(async () => ({ ...QUOTE, deposit_paid_at: "2026-09-26T00:00:00Z" })), reportLinkFailure });
    await runDepositLink(req({ quote_id: QUOTE_ID }), paid.deps);
    const ok = fakeDeps({ reportLinkFailure });
    await runDepositLink(req({ quote_id: QUOTE_ID }), ok.deps);
    expect(reportLinkFailure).not.toHaveBeenCalled();
  });

  it("never lets a failing owner alert break the call", async () => {
    const { deps } = fakeDeps({
      sendText: vi.fn(async () => ({ status: "failed", reason: "twilio 500" })),
      reportLinkFailure: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    expect(await runDepositLink(req({ quote_id: QUOTE_ID }), deps)).toMatchObject({ ok: false, reason: "send_failed" });
  });
});
