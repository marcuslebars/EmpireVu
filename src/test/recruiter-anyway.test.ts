import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

// "Y 12 anyway" (the Recruiter's payroll_period) through the real owner-channel entry: it only
// means something when a payroll_period waits on this phone. Everywhere else — house orgs, other
// kinds, nothing pending — the text takes exactly the path it took before the note existed.
const deliverMessage = vi.fn((..._a: unknown[]) => Promise.resolve({ status: "sent", body: "" }));
const executeApprovedAction = vi.fn((..._a: unknown[]) => Promise.resolve({ ok: true, message: "Sent." }));

let db: FakeDb;

vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => db.client }));
vi.mock("@/server/services/workflow-engine/messaging", () => ({
  STOP_FOOTER: "Reply STOP to opt out",
  deliverMessage: (...a: unknown[]) => deliverMessage(...a),
  orgOwnerEmail: vi.fn(async () => null),
  resolveCompanySmsFrom: vi.fn(async () => null),
}));
vi.mock("@/server/services/sms-agent/approved", () => ({ executeApprovedAction: (...a: unknown[]) => executeApprovedAction(...a) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: vi.fn(), recordAiUsageSafe: vi.fn() }));
vi.mock("@/server/services/bookings", () => ({ rescheduleBooking: vi.fn(), updateBookingStatus: vi.fn() }));

import { looksLikeApprovalAttempt } from "@/server/services/owner-channel/approvals";
import { handleOwnerInboundSms } from "@/server/services/owner-channel/entry";

const OWNER = "+17055559999";
const NOW = Date.parse("2026-10-12T14:00:00Z");

function approval(over: Record<string, unknown>) {
  return {
    organization_id: "org-1", company_id: "co-1", contact_id: null, conversation_id: null, kind: "send_quote", summary: "Quote for Dana: $650.", payload: {},
    status: "pending", short_code: 3, requested_by: "sms_agent", notified_at: "2026-10-12T13:00:00Z", notified_to: OWNER, decided_at: null, decided_via: null,
    decided_by: null, result: null, expires_at: "2026-10-13T13:00:00Z", created_at: "2026-10-12T13:00:00Z", updated_at: "2026-10-12T13:00:00Z", ...over,
  };
}

function seed(brand: string, approvals: Array<Record<string, unknown>>) {
  db = createFakeDb(
    {
      companies: [{ id: "co-1", organization_id: "org-1", name: "A1 Marine Care", timezone: "America/Toronto", owner_phone_e164: OWNER, owner_phone_verified_at: "2026-10-01T00:00:00Z", ai_settings: {} }],
      organizations: [{ id: "org-1", platform_brand: brand }],
      owner_approvals: approvals,
      owner_command_log: [],
      platform_sms_opt_outs: [],
      pay_periods: [],
    },
    { owner_command_log: [["provider_ref"]] },
  );
}

let sid = 0;
const text = (body: string) => handleOwnerInboundSms(db.client, { from: OWNER, to: "+16475550000", body, media: [], providerRef: `SM${++sid}`, viaPlatformNumber: true, companyId: null });
const intents = () => db.tables.owner_command_log.map((l) => l.intent);
const lastReply = () => (deliverMessage.mock.calls.at(-1)?.[0] as { body: string } | undefined)?.body ?? "";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  deliverMessage.mockClear();
  executeApprovedAction.mockClear();
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('"anyway" outside payroll', () => {
  it("a house org with a pending quote: 'ok anyway' / 'Y 3 anyway' are not decisions — they ask, exactly as before", async () => {
    seed("empirevu", [approval({ id: "a-1" })]);
    await text("ok anyway");
    await text("Y 3 anyway");
    expect(executeApprovedAction).not.toHaveBeenCalled();
    expect(db.tables.owner_approvals[0].status).toBe("pending");
    // The pre-change path: not a parsed decision, so the "did you mean" check decides.
    expect(intents()).toEqual(["approval_did_you_mean", "approval_did_you_mean"]);
    expect(looksLikeApprovalAttempt("ok anyway")).toBe(true);
    expect(lastReply()).not.toContain("anyway");
  });

  it("nothing pending: 'Y anyway' never becomes 'Nothing waiting on you'", async () => {
    seed("empirevu", []);
    await text("Y anyway");
    expect(intents()[0]).not.toMatch(/^approval_(none|done|already|unknown_code)/);
  });

  it("a pending payroll_period on this phone: 'Y 4 anyway' decides it with the note", async () => {
    seed("crankleads", [approval({ id: "a-1" }), approval({ id: "p-1", kind: "payroll_period", short_code: 4, summary: "Payroll Sep 28 - Oct 11 …", requested_by: "recruiter", payload: { periodId: "missing" } })]);
    await text("Y 4 anyway");
    expect(intents()).toEqual(["approval_done"]);
    expect(db.tables.owner_approvals[1].status).toBe("failed"); // decided; the period row is gone in this fixture
    expect(lastReply()).toContain("#4 isn't linked to a pay period any more");
    expect(db.tables.owner_approvals[0].status).toBe("pending");
    // "Y 3 anyway" for the quote (not a payroll kind) still takes the old path.
    await text("Y 3 anyway");
    expect(intents()[1]).toBe("approval_did_you_mean");
  });
});
