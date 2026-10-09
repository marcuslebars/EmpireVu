import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

// Owner approvals by text: "Y", "N 2", "Y but $700", expiry, quiet hours, notify idempotency.
const deliverMessage = vi.fn((..._a: unknown[]) => Promise.resolve({ status: "sent", body: "" }));
const executeApprovedAction = vi.fn((..._a: unknown[]) => Promise.resolve({ ok: true, message: "Sent the $650 quote to Dana." }));
const anthropicCreate = vi.fn();

let db: FakeDb;

vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => db.client }));
vi.mock("@/server/services/workflow-engine/messaging", () => ({
  STOP_FOOTER: "Reply STOP to opt out",
  deliverMessage: (...a: unknown[]) => deliverMessage(...a),
}));
vi.mock("@/server/services/sms-agent/approved", () => ({ executeApprovedAction: (...a: unknown[]) => executeApprovedAction(...a) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: vi.fn(), recordAiUsageSafe: vi.fn() }));
vi.mock("@/server/services/bookings", () => ({ rescheduleBooking: vi.fn(), updateBookingStatus: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: (...a: unknown[]) => anthropicCreate(...a) };
  },
}));

import { decideApproval, parseApprovalReply } from "@/server/services/owner-channel/approvals";
import { decideApprovalFromApp } from "@/server/services/owner-channel/app";
import { handleOwnerInboundSms } from "@/server/services/owner-channel/entry";
import { notifyOwnerOfApproval, sweepOwnerApprovals } from "@/server/services/owner-channel/notify";

const OWNER = "+17055559999";
const PLATFORM = "+16475550000";
// Wed Oct 7 2026, 10:00 in Toronto (EDT, UTC-4).
const NOW = Date.parse("2026-10-07T14:00:00Z");
const HOUR = 3_600_000;

function approval(over: Record<string, unknown>) {
  return {
    organization_id: "org-1",
    company_id: "co-1",
    contact_id: "c-1",
    conversation_id: null,
    kind: "send_quote",
    summary: "Quote for Dana: $650 seasonal contract.",
    payload: {},
    status: "pending",
    short_code: null,
    requested_by: "sms_agent",
    notified_at: "2026-10-07T13:00:00Z",
    decided_at: null,
    decided_via: null,
    decided_by: null,
    result: null,
    expires_at: new Date(NOW + 20 * HOUR).toISOString(),
    created_at: "2026-10-07T13:00:00Z",
    updated_at: "2026-10-07T13:00:00Z",
    ...over,
  };
}

function seed(extra: Record<string, Array<Record<string, unknown>>> = {}) {
  db = createFakeDb(
    {
      companies: [{ id: "co-1", organization_id: "org-1", name: "Northshore Lawn", timezone: "America/Toronto", owner_phone_e164: OWNER, ai_settings: {} }],
      organizations: [{ id: "org-1", platform_brand: "crankleads" }],
      owner_approvals: [],
      owner_command_log: [],
      platform_sms_opt_outs: [],
      ...extra,
    },
    { owner_command_log: [["provider_ref"]] },
  );
}

let sid = 0;
function text(body: string, over: Record<string, unknown> = {}) {
  return handleOwnerInboundSms(db.client, {
    from: OWNER,
    to: PLATFORM,
    body,
    media: [],
    providerRef: `SM${++sid}`,
    viaPlatformNumber: true,
    companyId: null,
    ...over,
  });
}

function lastReply(): string {
  const call = deliverMessage.mock.calls.at(-1)?.[0] as { body: string; to: string; smsFrom: string } | undefined;
  return call?.body ?? "";
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  deliverMessage.mockClear();
  executeApprovedAction.mockClear();
  anthropicCreate.mockReset();
  delete process.env.ANTHROPIC_API_KEY;
  seed();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("parseApprovalReply", () => {
  it.each([
    ["Y", { approved: true, code: null, note: null }],
    ["YES", { approved: true, code: null, note: null }],
    ["ok", { approved: true, code: null, note: null }],
    ["N", { approved: false, code: null, note: null }],
    ["no", { approved: false, code: null, note: null }],
    ["Y 2", { approved: true, code: 2, note: null }],
    ["N2", { approved: false, code: 2, note: null }],
    ["Y but $700", { approved: true, code: null, note: "but $700" }],
    ["N tell them next week", { approved: false, code: null, note: "tell them next week" }],
    ["y 3, but $700", { approved: true, code: 3, note: "but $700" }],
  ])("%s", (body, expected) => {
    expect(parseApprovalReply(body)).toEqual(expected);
  });

  it("ignores commands", () => {
    for (const body of ["what's on tomorrow", "Yesterday's jobs?", "Nothing on today?", "move Jones to Thursday"]) {
      expect(parseApprovalReply(body)).toBeNull();
    }
  });
});

describe("approvals by text", () => {
  it("one pending: Y approves it, runs it, stores the result, and replies with the result line", async () => {
    seed({ owner_approvals: [approval({ id: "a-1" })] });
    await text("Y");
    expect(executeApprovedAction).toHaveBeenCalledTimes(1);
    const [, row, decision] = executeApprovedAction.mock.calls[0] as [unknown, { id: string }, Record<string, unknown>];
    expect(row.id).toBe("a-1");
    expect(decision).toMatchObject({ approved: true, ownerNote: null, decidedVia: "sms", decidedBy: OWNER });
    expect(db.tables.owner_approvals[0]).toMatchObject({ status: "executed", decided_via: "sms" });
    expect(db.tables.owner_approvals[0].result).toMatchObject({ ok: true, message: "Sent the $650 quote to Dana." });
    expect(lastReply()).toBe("CrankLeads: Sent the $650 quote to Dana.");
    expect((deliverMessage.mock.calls[0][0] as { smsFrom: string; to: string }).smsFrom).toBe("platform");
    expect(db.tables.owner_command_log[0]).toMatchObject({ intent: "approval_done", company_id: "co-1", organization_id: "org-1" });
  });

  it("note passthrough: 'Y but $700' and 'N tell them next week'", async () => {
    seed({ owner_approvals: [approval({ id: "a-1" })] });
    await text("Y but $700");
    expect(executeApprovedAction.mock.calls[0][2]).toMatchObject({ approved: true, ownerNote: "but $700" });

    seed({ owner_approvals: [approval({ id: "a-2" })] });
    executeApprovedAction.mockResolvedValueOnce({ ok: true, message: "Told Dana you'll be in touch next week." });
    await text("N tell them next week");
    expect(executeApprovedAction.mock.calls[1][2]).toMatchObject({ approved: false, ownerNote: "tell them next week" });
    expect(db.tables.owner_approvals[0].status).toBe("rejected");
  });

  it("several pending: a bare Y asks for the code; 'Y 2' runs that one", async () => {
    seed({
      owner_approvals: [
        approval({ id: "a-1", summary: "Quote for Dana: $650." }),
        approval({ id: "a-2", summary: "Book Sam Fri 9am.", kind: "book_job", created_at: "2026-10-07T13:30:00Z" }),
      ],
    });
    await text("Y");
    expect(executeApprovedAction).not.toHaveBeenCalled();
    expect(lastReply()).toMatch(/2 waiting/);
    expect(lastReply()).toMatch(/1\) Quote for Dana/);
    expect(lastReply()).toMatch(/2\) Book Sam/);

    await text("Y 2");
    expect(executeApprovedAction).toHaveBeenCalledTimes(1);
    expect((executeApprovedAction.mock.calls[0][1] as { id: string }).id).toBe("a-2");
    expect(db.tables.owner_approvals.find((r) => r.id === "a-1")?.status).toBe("pending");
  });

  it("an unknown code says so", async () => {
    seed({ owner_approvals: [approval({ id: "a-1", short_code: 1 })] });
    await text("N 7");
    expect(executeApprovedAction).not.toHaveBeenCalled();
    expect(lastReply()).toMatch(/No #7 waiting/);
  });

  it("double replies don't double-run (and a replayed MessageSid is a no-op)", async () => {
    seed({ owner_approvals: [approval({ id: "a-1" })] });
    await text("Y", { providerRef: "SMdup" });
    await text("Y", { providerRef: "SMdup" });
    await text("Y");
    expect(executeApprovedAction).toHaveBeenCalledTimes(1);
    expect(lastReply()).toMatch(/Nothing waiting/);

    // The decide path itself: a second claim on the same row is "already".
    const again = await decideApproval(db.client, "a-1", { approved: true, decidedVia: "app", decidedBy: "p-1" });
    expect(again.outcome).toBe("already");
    expect(executeApprovedAction).toHaveBeenCalledTimes(1);
  });

  it("an expired approval: says so, closes it as expired and tells the executor 'not approved'", async () => {
    seed({ owner_approvals: [approval({ id: "a-1", expires_at: new Date(NOW - HOUR).toISOString() })] });
    await text("Y");
    expect(lastReply()).toMatch(/expired/i);
    expect(db.tables.owner_approvals[0]).toMatchObject({ status: "expired", decided_via: "expiry" });
    expect(executeApprovedAction.mock.calls[0][2]).toMatchObject({ approved: false, decidedVia: "expiry" });
  });

  it("the app decide path is the same claim, scoped to the caller's organization", async () => {
    seed({ owner_approvals: [approval({ id: "a-1" })] });
    const ctx = { organizationId: "org-other", actorProfileId: "p-9", supabase: db.client };
    expect((await decideApprovalFromApp(ctx, "a-1", { decision: "approve" })).outcome).toBe("not_found");
    expect(executeApprovedAction).not.toHaveBeenCalled();

    const mine = await decideApprovalFromApp({ ...ctx, organizationId: "org-1" }, "a-1", { decision: "skip" });
    expect(mine.outcome).toBe("done");
    expect(executeApprovedAction.mock.calls[0][2]).toMatchObject({ approved: false, decidedVia: "app", decidedBy: "p-9" });
    // A text racing the click finds nothing left to run.
    await text("Y");
    expect(executeApprovedAction).toHaveBeenCalledTimes(1);
  });

  it("an owner with two businesses: codes that collide ask which business, then the answer resolves it", async () => {
    seed({
      companies: [
        { id: "co-1", organization_id: "org-1", name: "Northshore Lawn", timezone: "America/Toronto", owner_phone_e164: OWNER },
        { id: "co-2", organization_id: "org-1", name: "Bayview Snow", timezone: "America/Toronto", owner_phone_e164: OWNER },
      ],
      owner_approvals: [
        approval({ id: "a-1", company_id: "co-1", short_code: 1, summary: "Quote for Dana." }),
        approval({ id: "a-2", company_id: "co-2", short_code: 1, summary: "Book Sam." }),
      ],
    });
    await text("Y 1");
    expect(executeApprovedAction).not.toHaveBeenCalled();
    expect(lastReply()).toMatch(/Which business — 1\) Northshore Lawn 2\) Bayview Snow/);
    await text("2");
    expect(executeApprovedAction).toHaveBeenCalledTimes(1);
    expect((executeApprovedAction.mock.calls[0][1] as { id: string }).id).toBe("a-2");
  });

  it("a stranger's phone is not handled", async () => {
    const res = await handleOwnerInboundSms(db.client, { from: "+14165550000", to: PLATFORM, body: "Y", media: [], providerRef: "SMx", viaPlatformNumber: true, companyId: null });
    expect(res.handled).toBe(false);
    expect(deliverMessage).not.toHaveBeenCalled();
  });
});

describe("notifyOwnerOfApproval + sweep", () => {
  it("texts the owner once (idempotent via notified_at) from the platform number", async () => {
    seed({ owner_approvals: [approval({ id: "a-1", notified_at: null })] });
    expect(await notifyOwnerOfApproval(db.client, "a-1", { nowMs: NOW })).toEqual({ notified: true });
    expect(await notifyOwnerOfApproval(db.client, "a-1", { nowMs: NOW })).toEqual({ notified: false });
    expect(deliverMessage).toHaveBeenCalledTimes(1);
    const sent = deliverMessage.mock.calls[0][0] as { body: string; smsFrom: string; to: string };
    expect(sent).toMatchObject({ smsFrom: "platform", to: OWNER });
    expect(sent.body).toBe("CrankLeads: Quote for Dana: $650 seasonal contract. Reply Y to approve, N to skip.");
    expect(db.tables.owner_approvals[0].notified_at).toBeTruthy();
  });

  it("adds the code when more than one is pending", async () => {
    seed({ owner_approvals: [approval({ id: "a-0", short_code: 1 }), approval({ id: "a-1", notified_at: null, summary: "Book Sam Fri 9am." })] });
    await notifyOwnerOfApproval(db.client, "a-1", { nowMs: NOW });
    expect(lastReply()).toBe("CrankLeads: Book Sam Fri 9am. Reply Y 2 to approve, N 2 to skip.");
  });

  it("a failed send releases the claim so the sweep retries", async () => {
    seed({ owner_approvals: [approval({ id: "a-1", notified_at: null })] });
    deliverMessage.mockResolvedValueOnce({ status: "failed", body: "" });
    expect((await notifyOwnerOfApproval(db.client, "a-1", { nowMs: NOW })).notified).toBe(false);
    expect(db.tables.owner_approvals[0].notified_at).toBeNull();
  });

  it("quiet hours: waits overnight (urgent kinds go now), the sweep sends it after 08:00", async () => {
    const night = Date.parse("2026-10-08T03:00:00Z"); // 23:00 Toronto
    seed({
      owner_approvals: [
        approval({ id: "a-1", notified_at: null, expires_at: new Date(night + 20 * HOUR).toISOString() }),
        approval({ id: "a-2", notified_at: null, kind: "same_day_booking", summary: "Same-day: book Lee 8am?", expires_at: new Date(night + 4 * HOUR).toISOString() }),
      ],
    });
    expect((await notifyOwnerOfApproval(db.client, "a-1", { nowMs: night })).notified).toBe(false);
    expect((await notifyOwnerOfApproval(db.client, "a-2", { nowMs: night })).notified).toBe(true);
    expect(deliverMessage).toHaveBeenCalledTimes(1);

    const stillNight = await sweepOwnerApprovals(db.client, night + HOUR);
    expect(stillNight.notified).toBe(0);
    const morning = await sweepOwnerApprovals(db.client, Date.parse("2026-10-08T12:30:00Z")); // 08:30
    expect(morning.notified).toBe(1);
    expect(lastReply()).toMatch(/Quote for Dana/);
  });

  it("the sweep expires approvals past expires_at and tells the executor 'not approved'", async () => {
    seed({
      owner_approvals: [
        approval({ id: "a-1", expires_at: new Date(NOW - 60_000).toISOString() }),
        approval({ id: "a-2", expires_at: new Date(NOW + HOUR).toISOString() }),
      ],
    });
    const res = await sweepOwnerApprovals(db.client, NOW);
    expect(res.expired).toBe(1);
    expect(db.tables.owner_approvals.find((r) => r.id === "a-1")).toMatchObject({ status: "expired", decided_via: "expiry", decided_by: "system" });
    expect(db.tables.owner_approvals.find((r) => r.id === "a-2")?.status).toBe("pending");
    expect(executeApprovedAction).toHaveBeenCalledTimes(1);
    expect(executeApprovedAction.mock.calls[0][2]).toMatchObject({ approved: false, decidedVia: "expiry" });
    // Running it again changes nothing.
    await sweepOwnerApprovals(db.client, NOW);
    expect(executeApprovedAction).toHaveBeenCalledTimes(1);
  });

  it("an owner who texted STOP to the platform number isn't texted", async () => {
    seed({ owner_approvals: [approval({ id: "a-1", notified_at: null })], platform_sms_opt_outs: [{ phone_e164: OWNER, opted_out_at: "2026-10-01T00:00:00Z" }] });
    expect((await notifyOwnerOfApproval(db.client, "a-1", { nowMs: NOW })).notified).toBe(false);
    expect(deliverMessage).not.toHaveBeenCalled();
  });
});
