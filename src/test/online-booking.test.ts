import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "./fake-supabase";

let db: FakeDb;
const invoicesCreated: Array<Record<string, unknown>> = [];
const voided: string[] = [];
const statusChanges: Array<{ bookingId: string; status: string }> = [];
const pushes: Array<{ title: string; body: string }> = [];
const tasks: Array<{ title: string }> = [];
let invoiceFails = false;

vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => db.client }));
vi.mock("@/server/services/invoices/service", () => ({
  createInvoice: vi.fn(async (_c: unknown, input: Record<string, unknown>) => {
    if (invoiceFails) throw new Error("stripe down");
    invoicesCreated.push(input);
    const row = { id: `inv-${invoicesCreated.length}`, organization_id: "org-1", public_token: "t".repeat(32), status: "draft", amount_paid_cents: 0, pending_payment_cents: 0 };
    db.tables.invoices.push(row);
    return row;
  }),
  sendInvoice: vi.fn(async (_c: unknown, id: string) => {
    const row = db.tables.invoices.find((r) => r.id === id)!;
    row.status = "sent";
    return { invoice: row, email: null, sms: null, publicUrl: `https://quotes.a1marinecare.ca/i/${row.public_token}` };
  }),
  voidInvoice: vi.fn(async (_c: unknown, id: string) => {
    voided.push(id);
    db.tables.invoices.find((r) => r.id === id)!.status = "void";
  }),
}));
vi.mock("@/server/services/bookings", () => ({
  updateBookingStatus: vi.fn(async (_c: unknown, i: { bookingId: string; status: string }) => {
    statusChanges.push(i);
    db.tables.bookings.find((b) => b.id === i.bookingId)!.status = i.status;
  }),
}));
vi.mock("@/server/services/push/notify", () => ({
  notifyOnlineBooking: vi.fn(async (i: { title: string; body: string }) => {
    pushes.push(i);
  }),
}));
vi.mock("@/server/services/tasks", () => ({
  createTask: vi.fn(async (_c: unknown, t: { title: string }) => {
    tasks.push(t);
  }),
}));
vi.mock("@/server/services/activity-events", () => ({ createActivityEvent: vi.fn(async () => ({})) }));

const rules = await import("@/server/services/scheduling/rules");
const { createPublicBooking, getPublicBookingPage } = await import("@/server/services/public-booking");
const { expireDepositHolds, onDepositInvoicePaid } = await import("@/server/services/scheduling/deposits");

const { DEFAULT_ONLINE_BOOKING_SETTINGS: D, bookableService, depositFor, flatPrice, openTimes, parseOnlineBookingSettings, presentOpenTimes } = rules;
const TZ = "America/Toronto";
const ORG = "org-1";
const CO = "11111111-1111-4111-8111-111111111111";
const SVC = "22222222-2222-4222-8222-222222222222";
// Monday Oct 5 2026, 10:00 EDT.
const NOW = new Date("2026-10-05T14:00:00Z");

const svc = (over: Partial<Record<string, unknown>> = {}) => ({
  id: SVC,
  label: "Shrink wrap",
  description: "Up to 24 ft",
  pricing_type: "flat",
  rate_cents: 45000,
  minimum_cents: 0,
  unit_label: null,
  ...over,
});

describe("rules", () => {
  it("defaults settings and repairs impossible hours", () => {
    expect(parseOnlineBookingSettings(null)).toEqual(D);
    expect(parseOnlineBookingSettings({ startHour: 17, endHour: 9 })).toMatchObject({ startHour: 9, endHour: 17 });
    expect(parseOnlineBookingSettings({ slotMinutes: 5, depositMode: "always" })).toMatchObject({ slotMinutes: 60, depositMode: "none" });
  });

  it("prices and deposits only fixed-price services, never above the price", () => {
    expect(flatPrice(svc() as never)).toBe(45000);
    expect(flatPrice(svc({ rate_cents: 10000, minimum_cents: 20000 }) as never)).toBe(20000);
    expect(flatPrice(svc({ pricing_type: "per_unit", unit_label: "foot", rate_cents: 1200 }) as never)).toBeNull();
    const fixed = { ...D, depositMode: "fixed" as const, depositFixedCents: 5000 };
    expect(depositFor(45000, fixed, true)).toBe(5000);
    expect(depositFor(3000, fixed, true)).toBe(3000);
    expect(depositFor(45000, { ...D, depositMode: "percent", depositPercent: 25 }, true)).toBe(11250);
    expect(depositFor(45000, fixed, false)).toBeNull(); // no Stripe
    expect(depositFor(null, fixed, true)).toBeNull();
    expect(depositFor(45000, D, true)).toBeNull();
    expect(depositFor(50, { ...D, depositMode: "percent", depositPercent: 10 }, true)).toBeNull(); // under $1
  });

  it("labels prices the way customers read them", () => {
    expect(bookableService(svc() as never, D, true)).toMatchObject({ priceCents: 45000, priceLabel: "$450", depositCents: null });
    expect(bookableService(svc({ pricing_type: "per_unit", unit_label: "foot", rate_cents: 1250 }) as never, D, true).priceLabel).toBe("$12.50 per foot");
    expect(bookableService(svc({ pricing_type: "per_measure", rate_cents: 0, minimum_cents: 20000 }) as never, D, true).priceLabel).toBe("From $200");
  });

  it("offers hourly times inside the brand's hours and days, after notice, around busy jobs", () => {
    const settings = { ...D, startHour: 9, endHour: 12, slotMinutes: 60, minNoticeHours: 24, horizonDays: 3, workingDays: [1, 2, 3] };
    const busy = [{ scheduledFor: "2026-10-06T14:30:00Z", durationMinutes: 30 }]; // Tue 10:30–11:00
    const times = openTimes({ now: NOW, timeZone: TZ, policy: null, settings, busy });
    expect(times.map((t) => t.startsAt)).toEqual([
      "2026-10-06T15:00:00.000Z", // Tue 11:00 (10:00 is inside 24h notice, 10:30 job blocks 10–11)
      "2026-10-07T13:00:00.000Z",
      "2026-10-07T14:00:00.000Z",
      "2026-10-07T15:00:00.000Z",
    ]);
    expect(times.every((t) => t.durationMinutes === 60 && t.windowKey === null)).toBe(true);
  });

  it("labels windows and times", () => {
    const policy = { mode: "windows" as const, windows: [{ key: "morning", start: "09:00", durationMinutes: 180, spoken: "in the morning" }], capacityPerWindow: 1, leadTimeHours: 24, horizonDays: 3, workingDays: [1, 2, 3, 4, 5] };
    const times = openTimes({ now: NOW, timeZone: TZ, policy, settings: D, busy: [] });
    expect(times[0]).toMatchObject({ day: "2026-10-06", windowKey: "morning", durationMinutes: 180 });
    expect(presentOpenTimes(times, policy, TZ)[0]).toMatchObject({ dayLabel: "Tuesday, October 6", label: "Morning" });
    expect(presentOpenTimes([{ startsAt: "2026-10-06T17:30:00Z", day: "2026-10-06", windowKey: null, durationMinutes: 60 }], null, TZ)[0].label).toBe("1:30 p.m.");
  });
});

function seed(over: { settings?: Record<string, unknown>; stripe?: boolean; bookings?: Array<Record<string, unknown>>; services?: Array<Record<string, unknown>> } = {}) {
  db = createFakeDb({
    companies: [
      {
        id: CO,
        organization_id: ORG,
        name: "A1 Marine Care",
        timezone: TZ,
        brand_reply_phone: "705-555-0100",
        quote_public_base_url: "https://quotes.a1marinecare.ca",
        stripe_connected_account_id: over.stripe === false ? null : "acct_1",
        stripe_charges_enabled: over.stripe !== false,
        online_booking_settings: { minNoticeHours: 2, ...over.settings },
        booking_policy: null,
      },
    ],
    service_catalog_items: over.services ?? [{ ...svc(), organization_id: ORG, company_id: CO, active: true, sort_order: 1 }],
    contacts: [{ id: "c-old", organization_id: ORG, company_id: CO, first_name: "Pat", email: "PAT@example.com", phone: null }],
    bookings: over.bookings ?? [],
    invoices: [],
    activity_events: [],
    workflow_event_jobs: [],
  });
}

beforeEach(() => {
  invoicesCreated.length = 0;
  voided.length = 0;
  statusChanges.length = 0;
  pushes.length = 0;
  tasks.length = 0;
  invoiceFails = false;
});

describe("the booking page", () => {
  it("shows the brand, its services and its open times", async () => {
    seed({ settings: { depositMode: "fixed", depositFixedCents: 5000 } });
    const page = await getPublicBookingPage(CO, NOW);
    expect(page).toMatchObject({ company: { name: "A1 Marine Care" }, mode: "hourly", timezone: TZ, requireService: false });
    expect(page!.brand.replyPhone).toBe("705-555-0100");
    expect(page!.services).toEqual([{ id: SVC, label: "Shrink wrap", description: "Up to 24 ft", priceCents: 45000, priceLabel: "$450", depositCents: 5000 }]);
    expect(page!.times[0]).toMatchObject({ startsAt: "2026-10-05T16:00:00.000Z", label: "12:00 p.m." }); // 2h notice from 10am
  });

  it("is off when the brand switches online booking off, or the id is junk", async () => {
    seed({ settings: { enabled: false } });
    expect(await getPublicBookingPage(CO, NOW)).toBeNull();
    expect(await getPublicBookingPage("not-a-uuid", NOW)).toBeNull();
  });
});

describe("booking", () => {
  const base = { name: "Sam Lee", email: "sam@example.com", phone: "705-555-0199", location: "Dock 4", startsAt: "2026-10-06T14:00:00.000Z" };

  it("books a service with no deposit, pending by default, and tells the owner", async () => {
    seed();
    const r = await createPublicBooking(CO, { ...base, serviceId: SVC }, NOW);
    expect(r).toMatchObject({ ok: true, status: "pending", dayLabel: "Tuesday, October 6", label: "10:00 a.m.", deposit: null });
    const b = db.tables.bookings[0];
    expect(b).toMatchObject({ title: "Shrink wrap — Sam Lee", status: "pending", location: "Dock 4", service_item_id: SVC, price_cents: 45000, deposit_cents: null, hold_expires_at: null, source: "public_booking", duration_minutes: 60 });
    expect(db.tables.contacts.find((c) => c.email === "sam@example.com")).toMatchObject({ first_name: "Sam", last_name: "Lee", consent_source: "implied_inquiry" });
    expect(db.tables.activity_events[0]).toMatchObject({ event_type: "booking.created" });
    expect(pushes[0]).toMatchObject({ title: "New online booking: Sam Lee" });
  });

  it("confirms straight away when the brand auto-confirms, and reuses an existing contact", async () => {
    seed({ settings: { autoConfirm: true } });
    const r = await createPublicBooking(CO, { ...base, email: "pat@example.com" }, NOW);
    expect(r.status).toBe("confirmed");
    expect(db.tables.bookings[0]).toMatchObject({ contact_id: "c-old", title: "Booking — Sam Lee", price_cents: null });
    expect(db.tables.contacts.find((c) => c.id === "c-old")!.phone).toBe("705-555-0199"); // filled in, not overwritten
  });

  it("holds the slot and sends a tax-free deposit invoice", async () => {
    seed({ settings: { depositMode: "percent", depositPercent: 20, holdMinutes: 30, autoConfirm: true } });
    const r = await createPublicBooking(CO, { ...base, serviceId: SVC }, NOW);
    expect(r.deposit).toEqual({ cents: 9000, payUrl: `https://quotes.a1marinecare.ca/i/${"t".repeat(32)}`, holdUntil: "2026-10-05T14:30:00.000Z" });
    expect(r.status).toBe("pending"); // a deposit booking waits for the money
    expect(invoicesCreated[0]).toMatchObject({ companyId: CO, taxRateBps: 0, customerAccountId: null, lines: [{ unitPriceCents: 9000, quantity: 1 }] });
    expect(invoicesCreated[0]).not.toHaveProperty("bookingId"); // so the job can still be invoiced
    expect(db.tables.bookings[0]).toMatchObject({ deposit_cents: 9000, deposit_invoice_id: "inv-1", hold_expires_at: "2026-10-05T14:30:00.000Z" });
    expect(pushes[0].body).toMatch(/waiting for a \$90\.00 deposit/);
  });

  it("releases the slot if the deposit can't be set up", async () => {
    seed({ settings: { depositMode: "fixed" } });
    invoiceFails = true;
    await expect(createPublicBooking(CO, { ...base, serviceId: SVC }, NOW)).rejects.toThrow(/deposit payment/);
    expect(db.tables.bookings[0].status).toBe("cancelled");
  });

  it("refuses times it didn't offer, services that aren't the brand's, and a missing required service", async () => {
    seed({ bookings: [{ id: "b0", organization_id: ORG, company_id: CO, status: "confirmed", scheduled_for: "2026-10-06T14:00:00.000Z", duration_minutes: 60 }] });
    await expect(createPublicBooking(CO, base, NOW)).rejects.toThrow(/no longer available/); // taken
    await expect(createPublicBooking(CO, { ...base, startsAt: "2026-10-05T15:00:00.000Z" }, NOW)).rejects.toThrow(/no longer available/); // inside notice
    await expect(createPublicBooking(CO, { ...base, startsAt: "2026-10-11T14:00:00.000Z" }, NOW)).rejects.toThrow(/no longer available/); // Sunday
    await expect(createPublicBooking(CO, { ...base, startsAt: "2026-10-06T15:00:00.000Z", serviceId: "33333333-3333-4333-8333-333333333333" }, NOW)).rejects.toThrow(/services listed/);
    seed({ settings: { requireService: true } });
    await expect(createPublicBooking(CO, base, NOW)).rejects.toThrow(/choose a service/);
    expect(db.tables.bookings).toHaveLength(0);
  });
});

describe("deposits", () => {
  function held(over: Record<string, unknown> = {}, invoice: Record<string, unknown> = {}) {
    seed({
      bookings: [
        { id: "b1", organization_id: ORG, company_id: CO, contact_id: "c-old", title: "Shrink wrap — Pat", status: "pending", deposit_cents: 5000, deposit_invoice_id: "inv-9", deposit_paid_at: null, hold_expires_at: "2026-10-05T13:00:00Z", ...over },
      ],
    });
    db.tables.invoices.push({ id: "inv-9", organization_id: ORG, status: "sent", amount_paid_cents: 0, pending_payment_cents: 0, ...invoice });
  }

  it("a paid deposit confirms the booking and clears the hold", async () => {
    held();
    expect(await onDepositInvoicePaid(db.client, { id: "inv-9", organization_id: ORG })).toBe("confirmed");
    expect(db.tables.bookings[0]).toMatchObject({ status: "confirmed", hold_expires_at: null });
    expect(db.tables.bookings[0].deposit_paid_at).toBeTruthy();
    expect(pushes[0].title).toBe("Deposit paid — booking confirmed");
    expect(await onDepositInvoicePaid(db.client, { id: "inv-9", organization_id: ORG })).toBe("none"); // once
  });

  it("a deposit paid after the slot was released becomes a task for a person", async () => {
    held({ status: "cancelled" });
    expect(await onDepositInvoicePaid(db.client, { id: "inv-9", organization_id: ORG })).toBe("late");
    expect(tasks[0].title).toMatch(/after the hold expired/);
  });

  it("an unpaid hold that ran out is released and its invoice voided", async () => {
    held();
    expect(await expireDepositHolds(NOW, db.client)).toEqual({ expired: 1, extended: 0 });
    expect(statusChanges).toEqual([{ bookingId: "b1", status: "cancelled" }]);
    expect(voided).toEqual(["inv-9"]);
    expect(db.tables.bookings[0].hold_expires_at).toBeNull();
  });

  it("a deposit still clearing (bank debit) keeps the slot another day", async () => {
    held({}, { pending_payment_cents: 5000 });
    expect(await expireDepositHolds(NOW, db.client)).toEqual({ expired: 0, extended: 1 });
    expect(db.tables.bookings[0].hold_expires_at).toBe("2026-10-06T14:00:00.000Z");
    expect(voided).toHaveLength(0);
  });

  it("leaves holds that haven't run out, and bookings without one", async () => {
    held({ hold_expires_at: "2026-10-05T15:00:00Z" });
    db.tables.bookings.push({ id: "b2", organization_id: ORG, company_id: CO, status: "pending", hold_expires_at: null, deposit_paid_at: null });
    expect(await expireDepositHolds(NOW, db.client)).toEqual({ expired: 0, extended: 0 });
  });
});
