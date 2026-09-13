import { beforeEach, describe, expect, it, vi } from "vitest";

import { deriveNeedsReply, deriveUnread, toChronological } from "@/lib/inbox-utils";

// ── Pure inbox semantics (mirror ui_inbox_v) + thread ordering ────────────────

describe("deriveNeedsReply", () => {
  const inbound = "2026-09-06T10:00:00.000Z";
  const earlier = "2026-09-06T09:00:00.000Z";
  const later = "2026-09-06T11:00:00.000Z";

  it("needs a reply when the newest inbound is after the newest outbound", () => {
    expect(deriveNeedsReply(inbound, earlier)).toBe(true);
  });
  it("does not need a reply when the newest outbound is after the newest inbound", () => {
    expect(deriveNeedsReply(inbound, later)).toBe(false);
  });
  it("needs a reply when there is an inbound but no outbound", () => {
    expect(deriveNeedsReply(inbound, null)).toBe(true);
  });
  it("never needs a reply when there is no inbound", () => {
    expect(deriveNeedsReply(null, earlier)).toBe(false);
    expect(deriveNeedsReply(null, null)).toBe(false);
  });
});

describe("deriveUnread", () => {
  const inbound = "2026-09-06T10:00:00.000Z";
  it("unread when inbound is newer than last read", () => {
    expect(deriveUnread(inbound, "2026-09-06T09:00:00.000Z")).toBe(true);
  });
  it("read when last read is at/after inbound", () => {
    expect(deriveUnread(inbound, "2026-09-06T10:00:00.000Z")).toBe(false);
    expect(deriveUnread(inbound, "2026-09-06T12:00:00.000Z")).toBe(false);
  });
  it("unread when there is an inbound but no read marker", () => {
    expect(deriveUnread(inbound, null)).toBe(true);
  });
  it("not unread when there is no inbound", () => {
    expect(deriveUnread(null, null)).toBe(false);
  });
});

describe("toChronological", () => {
  it("orders a mixed-source page oldest→newest without mutating the input", () => {
    const items = [
      { id: "call", kind: "call", occurred_at: "2026-09-06T10:00:00.000Z" },
      { id: "msg", kind: "message", occurred_at: "2026-09-06T08:00:00.000Z" },
      { id: "lead", kind: "lead", occurred_at: "2026-09-06T09:00:00.000Z" },
      { id: "event", kind: "event", occurred_at: "2026-09-06T11:00:00.000Z" },
    ];
    const ordered = toChronological(items);
    expect(ordered.map((i) => i.id)).toEqual(["msg", "lead", "call", "event"]);
    // original untouched (newest-first as the RPC returned it)
    expect(items[0].id).toBe("call");
  });
});

// ── Server service wiring ─────────────────────────────────────────────────────

type DeliverResult = { status: string; reason?: string; providerRef?: string | null; body: string };
const getContactById = vi.fn((..._a: unknown[]) => Promise.resolve(makeContact()));
const deliverMessage = vi.fn(
  (..._a: unknown[]): Promise<DeliverResult> => Promise.resolve({ status: "sent", providerRef: "SM1", body: "hi" }),
);

vi.mock("@/server/services/contacts", () => ({ getContactById: (...a: unknown[]) => getContactById(...a) }));
vi.mock("@/server/services/workflow-engine/messaging", () => ({
  deliverMessage: (...a: unknown[]) => deliverMessage(...a),
}));

import { getConversationThread, getInboxList, markContactRead, sendContactMessage } from "@/server/services/inbox";

function makeContact(over: Record<string, unknown> = {}) {
  return {
    id: "contact-1",
    company_id: "co-1",
    phone: "+17055550123",
    email: "jane@example.com",
    sms_opt_out_at: null,
    email_opt_out_at: null,
    sms_consent_at: "2026-09-01T00:00:00.000Z",
    consent_source: "inbound_sms",
    ...over,
  };
}

interface QueryCalls {
  eq: Array<[string, unknown]>;
  ilike: Array<[string, unknown]>;
  order: Array<[string, unknown]>;
  rpc: Array<[string, Record<string, unknown>]>;
  upsert: Array<[Record<string, unknown>, unknown]>;
}

function makeContext(opts: { inboxData?: unknown[]; threadData?: unknown[] } = {}) {
  const calls: QueryCalls = { eq: [], ilike: [], order: [], rpc: [], upsert: [] };
  const builder = {
    select: () => builder,
    eq: (col: string, val: unknown) => { calls.eq.push([col, val]); return builder; },
    ilike: (col: string, val: unknown) => { calls.ilike.push([col, val]); return builder; },
    order: (col: string, val: unknown) => { calls.order.push([col, val]); return builder; },
    limit: () => Promise.resolve({ data: opts.inboxData ?? [], error: null }),
    upsert: (row: Record<string, unknown>, o: unknown) => { calls.upsert.push([row, o]); return Promise.resolve({ error: null }); },
  };
  const supabase = {
    from: () => builder,
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.rpc.push([name, args]);
      return Promise.resolve({ data: opts.threadData ?? [], error: null });
    },
  };
  return { context: { organizationId: "org-1", actorProfileId: "user-1", supabase } as never, calls };
}

beforeEach(() => {
  getContactById.mockClear().mockResolvedValue(makeContact());
  deliverMessage.mockClear().mockResolvedValue({ status: "sent", providerRef: "SM1", body: "hi" });
});

describe("getConversationThread", () => {
  it("passes the keyset cursor + limit through to the RPC", async () => {
    const { context, calls } = makeContext({ threadData: [{ id: "1", kind: "message" }] });
    const data = await getConversationThread(context, "contact-1", { beforeTs: "2026-09-06T10:00:00.000Z", limit: 25 });
    expect(calls.rpc[0][0]).toBe("ui_conversation_thread");
    expect(calls.rpc[0][1]).toMatchObject({
      p_org_id: "org-1",
      p_contact_id: "contact-1",
      p_before_ts: "2026-09-06T10:00:00.000Z",
      p_limit: 25,
    });
    expect(data).toHaveLength(1);
  });
});

describe("getInboxList", () => {
  it("applies needs-reply, company, and search filters and sorts by needs_reply then recency", async () => {
    const { context, calls } = makeContext({ inboxData: [] });
    await getInboxList(context, { companyId: "co-1", needsReply: true, search: "Jane" });
    expect(calls.eq).toContainEqual(["organization_id", "org-1"]);
    expect(calls.eq).toContainEqual(["company_id", "co-1"]);
    expect(calls.eq).toContainEqual(["needs_reply", true]);
    expect(calls.ilike[0][0]).toBe("search_text");
    expect(calls.order.map((o) => o[0])).toEqual(["needs_reply", "last_activity_at"]);
  });
});

describe("markContactRead", () => {
  it("upserts the caller's read marker keyed on (contact, profile)", async () => {
    const { context, calls } = makeContext();
    const result = await markContactRead(context, "contact-1");
    expect(calls.upsert[0][0]).toMatchObject({ organization_id: "org-1", contact_id: "contact-1", profile_id: "user-1" });
    expect(calls.upsert[0][1]).toMatchObject({ onConflict: "contact_id,profile_id" });
    expect(result.lastReadAt).toBeTruthy();
  });

  it("refuses without an authenticated user", async () => {
    const supabase = { from: () => ({ upsert: () => Promise.resolve({ error: null }) }) };
    const context = { organizationId: "org-1", actorProfileId: null, supabase } as never;
    await expect(markContactRead(context, "contact-1")).rejects.toThrow(/authenticated/);
  });
});

describe("sendContactMessage", () => {
  it("passes the contact as consentContact so an opted-out contact is refused (blocked)", async () => {
    getContactById.mockResolvedValue(makeContact({ sms_opt_out_at: "2026-09-05T00:00:00.000Z" }));
    deliverMessage.mockResolvedValue({ status: "blocked", reason: "opted_out", body: "hi" });
    const { context } = makeContext();

    const result = await sendContactMessage(context, "contact-1", { channel: "sms", body: "Hi there" });

    expect(deliverMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "sms",
        to: "+17055550123",
        contactId: "contact-1",
        companyId: "co-1",
        consentContact: expect.objectContaining({ sms_opt_out_at: "2026-09-05T00:00:00.000Z" }),
      }),
    );
    expect(result.status).toBe("blocked");
  });

  it("routes email to the contact's email address", async () => {
    const { context } = makeContext();
    await sendContactMessage(context, "contact-1", { channel: "email", body: "Hello", subject: "Hi" });
    expect(deliverMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "email", to: "jane@example.com", subject: "Hi" }),
    );
  });
});
