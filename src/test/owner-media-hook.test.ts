import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

// The owner channel's photo/PDF hook for AI staff (staff/types.ts ownerMedia): which texts reach a
// role's handler, and that with no handler a picture gets exactly the old reply.
const deliverMessage = vi.fn((..._a: unknown[]) => Promise.resolve({ status: "sent", body: "sent body" }));
const runOwnerCommandAgent = vi.fn((..._a: unknown[]) => Promise.resolve({ reply: "agent reply", actions: [], rounds: 1, confirmationId: null }));
const handlerRun = vi.fn();
let handlers: Array<{ role: string; handler: { run: (...a: unknown[]) => unknown } }> = [];

let db: FakeDb;

vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => db.client }));
vi.mock("@/server/services/workflow-engine/messaging", () => ({
  STOP_FOOTER: "Reply STOP to opt out",
  deliverMessage: (...a: unknown[]) => deliverMessage(...a),
}));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: vi.fn(), recordAiUsageSafe: vi.fn() }));
vi.mock("@/server/services/sms-agent/approved", () => ({ executeApprovedAction: vi.fn(() => Promise.resolve({ ok: true, message: "ok" })) }));
vi.mock("@/server/services/bookings", () => ({ rescheduleBooking: vi.fn(), updateBookingStatus: vi.fn() }));
vi.mock("@/server/services/owner-channel/agent", () => ({ runOwnerCommandAgent: (...a: unknown[]) => runOwnerCommandAgent(...a) }));
vi.mock("@/server/services/staff/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/services/staff/registry")>()),
  ownerMediaHandlersFor: vi.fn(() => Promise.resolve(handlers)),
}));

import { handleOwnerInboundSms } from "@/server/services/owner-channel/entry";
import { ownerMediaHandlersFor } from "@/server/services/staff/registry";

const OWNER = "+17055559999";
const PLATFORM = "+16475550000";
const PHOTO = [{ url: "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1", contentType: "image/jpeg" }];

function seed() {
  db = createFakeDb(
    {
      companies: [{ id: "co-1", organization_id: "org-1", name: "Northshore Lawn", timezone: "America/Toronto", owner_phone_e164: OWNER, owner_phone_verified_at: "2026-10-01T00:00:00Z", ai_settings: {} }],
      organizations: [{ id: "org-1", platform_brand: "crankleads" }],
      owner_approvals: [],
      owner_command_log: [],
      platform_sms_opt_outs: [],
    },
    { owner_command_log: [["provider_ref"]] },
  );
}

let sid = 0;
function text(body: string, media = PHOTO) {
  return handleOwnerInboundSms(db.client, { from: OWNER, to: PLATFORM, body, media, providerRef: `SM${++sid}`, viaPlatformNumber: true, companyId: null });
}
const replies = () => deliverMessage.mock.calls.map((c) => (c[0] as { body: string }).body);
const lastLog = () => db.tables.owner_command_log.at(-1) as Record<string, unknown>;

beforeEach(() => {
  process.env.PLATFORM_SMS_NUMBER = PLATFORM;
  deliverMessage.mockClear();
  runOwnerCommandAgent.mockClear();
  handlerRun.mockReset();
  vi.mocked(ownerMediaHandlersFor).mockClear();
  handlers = [];
  seed();
});

describe("owner media hook", () => {
  it("no handler: a bare picture gets the old reply, a picture with words goes to the agent as before", async () => {
    await text("");
    expect(replies().at(-1)).toContain("Got the picture");
    expect(lastLog().intent).toBe("media_only");
    await text("what's on tomorrow");
    expect(runOwnerCommandAgent).toHaveBeenCalledTimes(1);
    expect((runOwnerCommandAgent.mock.calls[0][0] as { body: string }).body).toBe("what's on tomorrow");
  });

  it("a role's handler gets the media, the company and the text; its reply goes back and the agent never runs", async () => {
    handlers = [{ role: "tax_clerk", handler: { run: handlerRun } }];
    handlerRun.mockResolvedValue({ reply: "Got it: Home Depot $84.20 (HST $9.69), filed under Materials." });
    await text("for the Jones job");
    expect(handlerRun).toHaveBeenCalledTimes(1);
    const input = handlerRun.mock.calls[0][1] as Record<string, unknown>;
    expect(input).toMatchObject({ body: "for the Jones job", ownerPhone: OWNER, media: PHOTO, scope: { organizationId: "org-1", companyId: "co-1", companyName: "Northshore Lawn", timeZone: "America/Toronto" } });
    expect(typeof input.logId).toBe("string");
    expect(replies().at(-1)).toContain("Home Depot $84.20");
    expect(lastLog().intent).toBe("media:tax_clerk");
    expect(runOwnerCommandAgent).not.toHaveBeenCalled();
  });

  it("handlers are asked in order; null passes; a throwing handler is skipped", async () => {
    const second = vi.fn(() => Promise.resolve({ reply: "second took it", intent: "compliance_doc" }));
    handlers = [
      { role: "tax_clerk", handler: { run: () => Promise.reject(new Error("boom")) } },
      { role: "purchasing", handler: { run: () => Promise.resolve(null) } },
      { role: "compliance", handler: { run: second } },
    ];
    await text("");
    expect(second).toHaveBeenCalledTimes(1);
    expect(replies().at(-1)).toContain("second took it");
    expect(lastLog().intent).toBe("compliance_doc");
  });

  it("every handler passes: a bare picture gets the old reply; with words it reaches the agent", async () => {
    handlers = [{ role: "tax_clerk", handler: { run: handlerRun } }];
    handlerRun.mockResolvedValue(null);
    await text("");
    expect(replies().at(-1)).toContain("Got the picture");
    await text("move Dana to Friday");
    expect(runOwnerCommandAgent).toHaveBeenCalledTimes(1);
  });

  it("an approval reply sent with a photo stays an approval; no handler is asked", async () => {
    handlers = [{ role: "tax_clerk", handler: { run: handlerRun } }];
    await text("Y 12");
    expect(handlerRun).not.toHaveBeenCalled();
    expect(String(lastLog().intent)).not.toMatch(/^media/);
  });

  it("texts without media never look for handlers", async () => {
    await text("what's on tomorrow", []);
    expect(ownerMediaHandlersFor).not.toHaveBeenCalled();
  });
});
