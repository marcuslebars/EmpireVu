import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

// "Y 12 delivery" / "Y 12 no nails" (Purchasing's materials_order) through the real owner-channel
// entry: words after a Y only mean something when a materials_order waits on this phone. Everywhere
// else — house orgs, other kinds, nothing pending — the text takes exactly the path it took before.
const deliverMessage = vi.fn((..._a: unknown[]) => Promise.resolve({ status: "sent", body: "" }));
const executeApprovedAction = vi.fn((..._a: unknown[]) => Promise.resolve({ ok: true, message: "Sent." }));
const sendEmail = vi.fn((..._a: unknown[]) => Promise.resolve({ id: "re_1" }));

let db: FakeDb;

vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => db.client }));
vi.mock("@/server/services/workflow-engine/messaging", () => ({
  STOP_FOOTER: "Reply STOP to opt out",
  deliverMessage: (...a: unknown[]) => deliverMessage(...a),
  orgOwnerEmail: vi.fn(async () => null),
  resolveCompanySmsFrom: vi.fn(async () => null),
}));
vi.mock("@/server/outbound/email", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));
vi.mock("@/server/services/sms-agent/approved", () => ({ executeApprovedAction: (...a: unknown[]) => executeApprovedAction(...a) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: vi.fn(), recordAiUsageSafe: vi.fn() }));
vi.mock("@/server/services/bookings", () => ({ rescheduleBooking: vi.fn(), updateBookingStatus: vi.fn() }));

import { looksLikeApprovalAttempt, parseApprovalReply, parseTextNoteReply } from "@/server/services/owner-channel/approvals";
import { handleOwnerInboundSms } from "@/server/services/owner-channel/entry";

const OWNER = "+17055559999";
const NOW = Date.parse("2026-10-12T14:00:00Z");
const LINES = [
  { label: "shingles", qty: 22, unit: "bundles", estUnitCostCents: 3850, source: "recipe" },
  { label: "underlay", qty: 3, unit: "rolls", estUnitCostCents: 9000, source: "recipe" },
  { label: "nails", qty: 1, unit: "box", estUnitCostCents: 4500, source: "recipe" },
];

function approval(over: Record<string, unknown>) {
  return {
    organization_id: "org-1", company_id: "co-1", contact_id: null, conversation_id: null, kind: "send_quote", summary: "Quote for Dana: $650.", payload: {},
    status: "pending", short_code: 3, requested_by: "sms_agent", notified_at: "2026-10-12T13:00:00Z", notified_to: OWNER, decided_at: null, decided_via: null,
    decided_by: null, result: null, expires_at: "2026-10-13T13:00:00Z", created_at: "2026-10-12T13:00:00Z", updated_at: "2026-10-12T13:00:00Z", ...over,
  };
}

const materials = (over: Record<string, unknown> = {}) =>
  approval({ id: "m-1", kind: "materials_order", short_code: 4, requested_by: "purchasing", summary: "Materials for Jones - Roof replacement Thu Oct 15 (PO-1): …", payload: { poId: "po-1", fulfilment: "pickup", exampleItem: "nails" }, ...over });

function seed(brand: string, approvals: Array<Record<string, unknown>>) {
  db = createFakeDb(
    {
      companies: [{ id: "co-1", organization_id: "org-1", name: "Northshore Roofing", timezone: "America/Toronto", owner_phone_e164: OWNER, owner_phone_verified_at: "2026-10-01T00:00:00Z", owner_email: "dana@northshore.test", ai_settings: {}, stage: "active" }],
      organizations: [{ id: "org-1", platform_brand: brand }],
      owner_approvals: approvals,
      owner_command_log: [],
      platform_sms_opt_outs: [],
      bookings: [{ id: "b-1", organization_id: "org-1", company_id: "co-1", title: "Roof replacement", description: null, location: "12 Bay St", scheduled_for: "2026-10-15T12:00:00Z", status: "confirmed", quote_id: null, contact_id: "ct-1" }],
      contacts: [{ id: "ct-1", organization_id: "org-1", company_id: "co-1", first_name: "Sam", last_name: "Jones" }],
      suppliers: [{ id: "s-1", organization_id: "org-1", company_id: "co-1", name: "Home Depot Pro", branch: "Barrie", email: "orders@hdpro.test", phone: null, account_number: "12345", preferred: true, active: true }],
      purchase_orders: [
        { id: "po-1", organization_id: "org-1", company_id: "co-1", booking_id: "b-1", supplier_id: "s-1", supplier_name: "Home Depot Pro (Barrie)", status: "draft", po_seq: 1, po_number: "PO-1", needed_by: "2026-10-14", fulfilment: "pickup", lines: LINES, est_total_cents: 116_200, basis: "recipe", source: "auto", approval_id: "m-1" },
      ],
    },
    { owner_command_log: [["provider_ref"]], owner_approvals: [["company_id", "short_code"]] },
  );
}

let sid = 0;
const text = (body: string) => handleOwnerInboundSms(db.client, { from: OWNER, to: "+16475550000", body, media: [], providerRef: `SM${++sid}`, viaPlatformNumber: true, companyId: null });
const intents = () => db.tables.owner_command_log.map((l) => l.intent);
const lastReply = () => (deliverMessage.mock.calls.at(-1)?.[0] as { body: string } | undefined)?.body ?? "";
const emails = () => sendEmail.mock.calls.map((c) => c[0] as { to: string; body: string; replyTo?: string });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  deliverMessage.mockClear();
  executeApprovedAction.mockClear();
  sendEmail.mockClear();
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("words after Y (materials_order)", () => {
  it("parsing: only a yes + words, never a question or a thank-you; price/anyway keep their own parse", () => {
    expect(parseTextNoteReply("Y 4 delivery")).toEqual({ approved: true, code: 4, note: "delivery" });
    expect(parseTextNoteReply("yes 4, no nails")).toEqual({ approved: true, code: 4, note: "no nails" });
    expect(parseTextNoteReply("Y delivery")).toEqual({ approved: true, code: null, note: "delivery" });
    expect(parseTextNoteReply("Y 4")).toBeNull(); // a plain decision
    expect(parseTextNoteReply("Y 4 $700")).toBeNull(); // a price
    expect(parseTextNoteReply("ok thanks")).toBeNull();
    expect(parseTextNoteReply("ok what's on tomorrow")).toBeNull();
    expect(parseTextNoteReply("Y 4 delivery?")).toBeNull();
    expect(parseTextNoteReply("N 4 delivery")).toBeNull();
    // The shared parsers are unchanged.
    expect(parseApprovalReply("Y 4 delivery")).toBeNull();
    expect(looksLikeApprovalAttempt("Y 4 delivery")).toBe(true);
  });

  it('"Y 4 delivery no nails" decides the materials_order: emailed for delivery, without nails', async () => {
    seed("crankleads", [materials()]);
    await text("Y 4 delivery no nails");
    expect(intents()).toEqual(["approval_done"]);
    expect(db.tables.owner_approvals[0].status).toBe("executed");
    expect(lastReply()).toContain("Emailed PO-1 to Home Depot Pro (Barrie) for delivery by Wed Oct 14 (delivery; no nails).");
    const [email] = emails();
    expect(email).toMatchObject({ to: "orders@hdpro.test", replyTo: "dana@northshore.test" });
    expect(email.body).toContain("Deliver to: 12 Bay St");
    expect(email.body).not.toContain("nails");
    expect(db.tables.purchase_orders[0]).toMatchObject({ status: "sent", fulfilment: "delivery" });
  });

  it('"Y delivery" with only the materials_order waiting: decided; with something else waiting too, the old "which one" path', async () => {
    seed("crankleads", [materials()]);
    await text("Y delivery");
    expect(intents()).toEqual(["approval_done"]);
    sendEmail.mockClear();

    seed("crankleads", [approval({ id: "a-1" }), materials()]);
    await text("Y delivery");
    expect(intents()).toEqual(["approval_did_you_mean"]);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(db.tables.owner_approvals.every((a) => a.status === "pending")).toBe(true);
  });

  it('a note it can\'t read ("Y 4 make it friday"): nothing sent, asked again with a new code', async () => {
    seed("crankleads", [materials()]);
    await text("Y 4 make it friday");
    expect(sendEmail).not.toHaveBeenCalled();
    const fresh = db.tables.owner_approvals.find((a) => a.id !== "m-1")!;
    expect(fresh).toMatchObject({ kind: "materials_order", status: "pending", notified_to: OWNER });
    expect(lastReply()).toContain(`Nothing was sent: I'm not sure what "make it friday" means.`);
    expect(lastReply()).toContain(`Reply Y ${fresh.short_code} to order it`);
    expect(db.tables.purchase_orders[0]).toMatchObject({ status: "draft", approval_id: fresh.id });
  });

  it("other kinds and house orgs: exactly the old path", async () => {
    seed("empirevu", [approval({ id: "a-1" })]);
    await text("Y 3 delivery");
    await text("ok thanks");
    expect(intents()).toEqual(["approval_did_you_mean", "approval_did_you_mean"]);
    expect(executeApprovedAction).not.toHaveBeenCalled();
    expect(db.tables.owner_approvals[0].status).toBe("pending");

    // A materials_order waiting, but the code names the quote: old path for the quote.
    seed("crankleads", [approval({ id: "a-1" }), materials()]);
    await text("Y 3 delivery");
    expect(intents()).toEqual(["approval_did_you_mean"]);
    // A price on a materials_order is passed to its executor, which can't use it and asks again.
    await text("Y 4 $700");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(lastReply()).toContain("Nothing was sent");
  });
});
