/**
 * The approvals seam between the SMS agent and the owner channel, without mocking either side:
 * one insert path (short codes), same-day bookings are urgent, and one owner per status
 * transition (decideApproval claims the decision; executeApprovedAction records the outcome).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

const sendSms = vi.fn((..._a: unknown[]) => Promise.resolve({ sid: `SM${Math.random().toString(36).slice(2, 8)}` }));
vi.mock("@/server/outbound/sms", () => ({ sendSms: (...a: unknown[]) => sendSms(...a) }));
vi.mock("@/server/outbound/email", () => ({ sendEmail: vi.fn(() => Promise.resolve({ id: "re_1" })) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: vi.fn(), recordAiUsageSafe: vi.fn() }));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({
  emitActivityEventAndDispatch: vi.fn(() => Promise.resolve({ activityEvent: {}, workflowEventJob: null })),
}));

import { createApproval as createOwnerApproval, decideApproval, expireApproval } from "@/server/services/owner-channel/approvals";
import { isUrgentApproval } from "@/server/services/owner-channel/notify";
import { createApproval as createAgentApproval, isSameDayBooking } from "@/server/services/sms-agent/approvals";

const ORG = "org-1";
const CO = "co-1";
const CONTACT = "c-1";
// Fri Oct 9 2026, 22:30 in Toronto (quiet hours) = Sat 02:30 UTC.
const NOW = new Date("2026-10-10T02:30:00Z");

let db: FakeDb;
const notified: string[] = [];
const agentDeps = { notify: async (_a: unknown, id: string) => (notified.push(id), { notified: true }), now: () => NOW };

beforeEach(() => {
  sendSms.mockClear();
  notified.length = 0;
  db = createFakeDb(
    {
      organizations: [{ id: ORG, platform_brand: "crankleads" }],
      companies: [
        {
          id: CO, organization_id: ORG, name: "Northshore Snow & Lawn", timezone: "America/Toronto", owner_phone_e164: "+17055550142", owner_phone_verified_at: "2026-10-01T00:00:00Z",
          ai_settings: {}, hours: null, service_area: "Midland", online_booking_settings: null, booking_policy: null, industry_pack: null,
          cancellation_policy_text: null, quote_terms_text: null,
        },
      ],
      organization_memberships: [{ organization_id: ORG, profile_id: "p-1", role: "owner" }],
      profiles: [{ id: "p-1", full_name: "Dana Whitfield", email: "dana@example.test" }],
      contacts: [
        {
          id: CONTACT, organization_id: ORG, company_id: CO, first_name: "Jamie", last_name: "Lee", phone: "+17055550123", email: null, notes: null,
          metadata: {}, sms_opt_out_at: null, email_opt_out_at: null, sms_consent_at: "2026-10-01T00:00:00Z", consent_source: "inbound_sms",
        },
      ],
      service_catalog_items: [],
      voice_numbers: [{ organization_id: ORG, company_id: CO, provider: "twilio", active: true, phone_e164: "+17055550111", mode: "missed_call_catcher" }],
      sms_conversations: [
        { id: "conv-1", organization_id: ORG, company_id: CO, contact_id: CONTACT, state: "ai", ai_turns: 2, collected: {}, summary: null, lock_until: "1970-01-01T00:00:00Z" },
      ],
      owner_approvals: [],
      message_log: [],
    },
    { owner_approvals: [["company_id", "short_code"]] },
  );
});

const rows = () => db.tables.owner_approvals as Array<Record<string, unknown>>;

describe("one way to create an approval", () => {
  it("the agent's and the owner channel's approvals share the short-code sequence; the agent's notify, the owner's confirmation doesn't", async () => {
    const a = await createAgentApproval(
      db.client,
      { organizationId: ORG, companyId: CO, contactId: CONTACT, conversationId: "conv-1", kind: "custom_price", summary: "Jamie Lee: asks $500 for the seasonal contract", payload: { proposedPriceCents: 50000 } },
      agentDeps,
    );
    const b = await createOwnerApproval(db.client, {
      organizationId: ORG, companyId: CO, contactId: CONTACT, kind: "owner_command", summary: "Move Jamie to Fri 9am?", payload: {}, requestedBy: "owner_channel", expiresInMinutes: 30, notifiedTo: "+17055550142",
    });
    expect(a.shortCode).toBe(1);
    expect(b.short_code).toBe(2);
    expect(rows()[0]).toMatchObject({ requested_by: "sms_agent", status: "pending", short_code: 1, notified_at: null });
    expect(rows()[1]).toMatchObject({ requested_by: "owner_channel", short_code: 2 });
    expect(rows()[1].notified_at).toBeTruthy();
    expect(rows()[1].notified_to).toBe("+17055550142");
    expect(notified).toEqual([a.id]);
    // 24h for a price; 30 min for the owner's own confirmation.
    expect(Date.parse(String(rows()[0].expires_at)) - NOW.getTime()).toBe(24 * 3_600_000);
  });

  it("a same-day booking approval is urgent (texted even at night); tomorrow's isn't", async () => {
    expect(isSameDayBooking("book_job", { startsAt: "2026-10-10T01:00:00Z" }, NOW, "America/Toronto")).toBe(true); // Fri 21:00 local
    expect(isSameDayBooking("book_job", { date: "2026-10-09" }, NOW, "America/Toronto")).toBe(true);
    expect(isSameDayBooking("book_job", { date: "2026-10-10" }, NOW, "America/Toronto")).toBe(false);
    expect(isSameDayBooking("custom_price", { date: "2026-10-09" }, NOW, "America/Toronto")).toBe(false);

    await createAgentApproval(
      db.client,
      { organizationId: ORG, companyId: CO, contactId: CONTACT, conversationId: "conv-1", kind: "book_job", summary: "Jamie: tonight 11pm?", payload: { date: "2026-10-09" }, timeZone: "America/Toronto" },
      agentDeps,
    );
    await createAgentApproval(
      db.client,
      { organizationId: ORG, companyId: CO, contactId: CONTACT, conversationId: "conv-1", kind: "book_job", summary: "Jamie: Monday?", payload: { date: "2026-10-12" }, timeZone: "America/Toronto" },
      agentDeps,
    );
    expect((rows()[0].payload as Record<string, unknown>).urgent).toBe(true);
    expect(isUrgentApproval(rows()[0] as never)).toBe(true);
    expect((rows()[1].payload as Record<string, unknown>).urgent).toBeUndefined();
    expect(isUrgentApproval(rows()[1] as never)).toBe(false);
  });
});

describe("one owner per status transition", () => {
  async function pendingCustomPrice() {
    return createAgentApproval(
      db.client,
      { organizationId: ORG, companyId: CO, contactId: CONTACT, conversationId: "conv-1", kind: "custom_price", summary: "Jamie Lee: asks $500", payload: {} },
      agentDeps,
    );
  }

  it("'Y about 700' → the executor asks to clarify and the row is back to pending with no decision; the decide path doesn't overwrite it", async () => {
    const created = await pendingCustomPrice();
    const out = await decideApproval(db.client, created.id, { approved: true, ownerNote: "about 700", decidedVia: "sms", decidedBy: "+17055550142" }, { nowMs: NOW.getTime() });
    expect(out.approval?.status).toBe("pending");
    expect(out.message).toMatch(/Reply like "Y 1 \$700"/);
    expect(rows()[0]).toMatchObject({ status: "pending", decided_at: null, decided_via: null, decided_by: null, execution_claimed_at: null });
    expect((rows()[0].result as Record<string, unknown>).needsClarification).toBe(true);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("'N' → the executor's outcome stands (rejected + its result), the decision was written once by the claim, and the owner's note never reaches the customer", async () => {
    const created = await pendingCustomPrice();
    const out = await decideApproval(
      db.client,
      created.id,
      { approved: false, ownerNote: "tell them we're booked solid, cheapskate", decidedVia: "sms", decidedBy: "+17055550142" },
      { nowMs: NOW.getTime() },
    );
    expect(out.outcome).toBe("done");
    expect(out.approval?.status).toBe("rejected");
    const row = rows()[0];
    expect(row).toMatchObject({ status: "rejected", decided_via: "sms", decided_by: "+17055550142", decided_at: NOW.toISOString() });
    // The executor's richer result (customerText) wasn't replaced by the decide path's.
    expect(row.result).toMatchObject({ customerText: expect.stringMatching(/thanks for your patience/i) });
    const customer = sendSms.mock.calls.map((c) => c[0] as { to: string; body: string }).filter((m) => m.to === "+17055550123");
    expect(customer).toHaveLength(1);
    expect(customer[0].body).not.toMatch(/booked solid|cheapskate/);
    expect((db.tables.sms_conversations as Array<Record<string, unknown>>)[0].state).toBe("owner");
    // A second "N" is "Already skipped", nothing re-runs.
    const again = await decideApproval(db.client, created.id, { approved: false, decidedVia: "app", decidedBy: "p-1" }, { nowMs: NOW.getTime() });
    expect(again.outcome).toBe("already");
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it("expiry: claimed as expired by the owner channel, outcome recorded by the executor, no customer text", async () => {
    const created = await pendingCustomPrice();
    const row = rows()[0];
    const later = Date.parse(String(row.expires_at)) + 60_000;
    const out = await expireApproval(db.client, row as never, later);
    expect(out.outcome).toBe("expired");
    expect(rows()[0]).toMatchObject({ id: created.id, status: "expired", decided_via: "expiry", decided_by: "system" });
    expect(rows()[0].result).toMatchObject({ message: expect.stringMatching(/No answer on #1/) });
    expect(sendSms).not.toHaveBeenCalled();
  });
});
