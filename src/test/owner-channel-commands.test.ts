import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

// Owner commands by text: a fake model issues tool calls; the tools run against a fake DB.
const deliverMessage = vi.fn((..._a: unknown[]) => Promise.resolve({ status: "sent", body: "sent body" }));
const executeApprovedAction = vi.fn((..._a: unknown[]) => Promise.resolve({ ok: true, message: "ok" }));
const rescheduleBooking = vi.fn((..._a: unknown[]) => Promise.resolve({}));
const updateBookingStatus = vi.fn((..._a: unknown[]) => Promise.resolve({}));
const recordAiUsageSafe = vi.fn((..._a: unknown[]) => Promise.resolve());
const anthropicCreate = vi.fn();

let db: FakeDb;

vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => db.client }));
vi.mock("@/server/services/workflow-engine/messaging", () => ({
  STOP_FOOTER: "Reply STOP to opt out",
  deliverMessage: (...a: unknown[]) => deliverMessage(...a),
}));
vi.mock("@/server/services/sms-agent/approved", () => ({ executeApprovedAction: (...a: unknown[]) => executeApprovedAction(...a) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: vi.fn(), recordAiUsageSafe: (...a: unknown[]) => recordAiUsageSafe(...a) }));
vi.mock("@/server/services/bookings", () => ({
  rescheduleBooking: (...a: unknown[]) => rescheduleBooking(...a),
  updateBookingStatus: (...a: unknown[]) => updateBookingStatus(...a),
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: (...a: unknown[]) => anthropicCreate(...a) };
  },
}));

import { handleOwnerInboundSms } from "@/server/services/owner-channel/entry";

const OWNER = "+17055559999";
const PLATFORM = "+16475550000";
const NOW = Date.parse("2026-10-07T14:00:00Z"); // Wed 10:00 Toronto
const DANA = "11111111-1111-4111-8111-111111111111";
const OTHER_CONTACT = "22222222-2222-4222-8222-222222222222";
const B_DANA = "33333333-3333-4333-8333-333333333333";
const B_OTHER = "44444444-4444-4444-8444-444444444444";
const B_FRI = "55555555-5555-4555-8555-555555555555";

function seed() {
  db = createFakeDb(
    {
      companies: [
        { id: "co-1", organization_id: "org-1", name: "Northshore Lawn", timezone: "America/Toronto", owner_phone_e164: OWNER, owner_phone_verified_at: "2026-10-01T00:00:00Z", ai_settings: {}, booking_policy: null, online_booking_settings: {} },
        { id: "co-9", organization_id: "org-9", name: "Someone Else Plumbing", timezone: "America/Toronto", owner_phone_e164: "+14165551234", owner_phone_verified_at: "2026-10-01T00:00:00Z", ai_settings: {} },
      ],
      organizations: [
        { id: "org-1", platform_brand: "crankleads" },
        { id: "org-9", platform_brand: "empirevu" },
      ],
      contacts: [
        { id: DANA, organization_id: "org-1", company_id: "co-1", first_name: "Dana", last_name: "Jones", phone: "+17055550123", search_text: "dana jones +17055550123", sms_opt_out_at: null, sms_consent_at: "2026-10-01T00:00:00Z", consent_source: "inbound_sms" },
        { id: OTHER_CONTACT, organization_id: "org-9", company_id: "co-9", first_name: "Dana", last_name: "Secret", phone: "+14165550000", search_text: "dana secret", sms_opt_out_at: null },
      ],
      bookings: [
        { id: B_DANA, organization_id: "org-1", company_id: "co-1", contact_id: DANA, title: "Spring cleanup", scheduled_for: "2026-10-08T13:00:00.000Z", duration_minutes: 60, status: "confirmed", location: null },
        { id: B_FRI, organization_id: "org-1", company_id: "co-1", contact_id: null, title: "Gutter job", scheduled_for: "2026-10-09T14:00:00.000Z", duration_minutes: 60, status: "confirmed", location: null },
        { id: B_OTHER, organization_id: "org-9", company_id: "co-9", contact_id: OTHER_CONTACT, title: "Secret job", scheduled_for: "2026-10-08T15:00:00.000Z", duration_minutes: 60, status: "confirmed", location: null },
      ],
      owner_approvals: [],
      owner_command_log: [],
      platform_sms_opt_outs: [],
      sms_conversations: [],
      ui_inbox_v: [],
      workflows: [],
    },
    { owner_command_log: [["provider_ref"]], sms_conversations: [["company_id", "contact_id"]] },
  );
}

let sid = 0;
function text(body: string) {
  return handleOwnerInboundSms(db.client, { from: OWNER, to: PLATFORM, body, media: [], providerRef: `SM${++sid}`, viaPlatformNumber: true, companyId: null });
}

/** The model: call these tools (one round each), then say `final`. */
function scriptModel(steps: Array<{ name: string; input: Record<string, unknown> }>, final: string) {
  let i = 0;
  anthropicCreate.mockImplementation(() => {
    const step = steps[i++];
    if (step) {
      return Promise.resolve({
        id: `msg_${i}`,
        model: "claude-sonnet-5-5",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: `tu_${i}`, name: step.name, input: step.input }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    }
    return Promise.resolve({ id: `msg_${i++}`, model: "claude-sonnet-5-5", stop_reason: "end_turn", content: [{ type: "text", text: final }], usage: { input_tokens: 10, output_tokens: 5 } });
  });
}

/** The confirmation code in the last owner text ("… Reply 4821 to confirm"). */
function lastCode(): string {
  const m = /Reply (\d{4}) to confirm/.exec(ownerReplies().at(-1) ?? "");
  if (!m) throw new Error(`no code in: ${ownerReplies().at(-1)}`);
  return m[1];
}

function ownerReplies(): string[] {
  return deliverMessage.mock.calls.map((c) => c[0] as { smsFrom?: string; body: string }).filter((m) => m.smsFrom === "platform").map((m) => m.body);
}

/** The tool_result the model was given for its `n`th tool call (1-based). */
function toolResult(n: number): string {
  const call = anthropicCreate.mock.calls.at(-1) as [{ messages: Array<{ role: string; content: unknown }> }];
  for (const message of call[0].messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Array<{ type: string; tool_use_id?: string; content?: string }>) {
      if (block.type === "tool_result" && block.tool_use_id === `tu_${n}`) return block.content ?? "";
    }
  }
  return "";
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.ANTHROPIC_API_KEY = "test-key";
  for (const fn of [deliverMessage, executeApprovedAction, rescheduleBooking, updateBookingStatus, recordAiUsageSafe, anthropicCreate]) fn.mockReset();
  deliverMessage.mockImplementation(() => Promise.resolve({ status: "sent", body: "sent body" }));
  seed();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.ANTHROPIC_API_KEY;
});

describe("owner commands", () => {
  it("what's on tomorrow → list_bookings for this company only", async () => {
    scriptModel([{ name: "list_bookings", input: { when: "tomorrow" } }], "Tomorrow: Thu 9am Dana Jones — Spring cleanup.");
    await text("what's on tomorrow?");

    const seen = toolResult(1);
    expect(seen).toContain("Dana Jones");
    expect(seen).toContain(B_DANA);
    expect(seen).not.toContain("Secret");
    expect(seen).not.toContain("Gutter job"); // Friday isn't tomorrow
    expect(seen).toMatch(/^<tool_data/); // fenced as data
    expect(ownerReplies()).toEqual(["CrankLeads: Tomorrow: Thu 9am Dana Jones — Spring cleanup."]);
    const firstCall = anthropicCreate.mock.calls[0][0] as { model: string; system: Array<{ text: string }> };
    expect(firstCall.model).toBe("claude-sonnet-5-5");
    expect(firstCall.system[0].text).toContain("Northshore Lawn");
    expect(recordAiUsageSafe).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org-1", companyId: "co-1" }));
    expect(db.tables.owner_command_log[0]).toMatchObject({ intent: "command", company_id: "co-1" });
  });

  it("reschedule: asks to confirm the exact change with a 4-digit code; a bare Y doesn't do it", async () => {
    scriptModel([{ name: "propose_reschedule", input: { booking_id: B_DANA, date: "2026-10-09", time: "09:00" } }], "unused");
    await text("move Dana to Friday 9am");

    expect(rescheduleBooking).not.toHaveBeenCalled();
    const ask = ownerReplies().at(-1) ?? "";
    expect(ask).toMatch(/^CrankLeads: Move Dana Jones \(Thu.*Oct.*8.*9:00.*\) to Fri.*Oct.*9.*9:00.*\? Reply \d{4} to confirm/);
    expect(db.tables.owner_approvals).toHaveLength(1);
    expect(db.tables.owner_approvals[0]).toMatchObject({ kind: "owner_command", status: "pending", requested_by: "owner_command", notified_to: OWNER });
    expect(db.tables.owner_approvals[0].notified_at).toBeTruthy();
    expect(JSON.stringify(db.tables.owner_approvals[0].payload)).not.toContain(lastCode()); // stored hashed

    const code = lastCode();
    await text("Y");
    expect(rescheduleBooking).not.toHaveBeenCalled();
    expect(ownerReplies().at(-1)).toMatch(/reply with the 4-digit code/);

    await text(code);
    expect(rescheduleBooking).toHaveBeenCalledTimes(1);
    expect(rescheduleBooking.mock.calls[0][1]).toMatchObject({ bookingId: B_DANA, scheduledFor: "2026-10-09T13:00:00.000Z" });
    expect((rescheduleBooking.mock.calls[0][0] as { organizationId: string }).organizationId).toBe("org-1");
    expect(executeApprovedAction).not.toHaveBeenCalled(); // owner commands are run by the owner channel
    expect(ownerReplies().at(-1)).toMatch(/Moved Dana Jones to Fri, Oct 9, 9:00 a\.m\. Want me/);
    expect(db.tables.owner_approvals[0].status).toBe("executed");
  });

  it("reschedule to a taken time is refused with open alternatives (nothing proposed)", async () => {
    scriptModel([{ name: "propose_reschedule", input: { booking_id: B_DANA, date: "2026-10-09", time: "10:00" } }], "Fri 10am is taken — 9am or 11am are open.");
    await text("move Dana to Fri 10am");
    expect(toolResult(1)).toContain("isn't open");
    expect(db.tables.owner_approvals).toHaveLength(0);
  });

  it("cancel always confirms with a code; N leaves it", async () => {
    scriptModel([{ name: "propose_cancel", input: { booking_id: B_DANA } }], "unused");
    await text("cancel Dana tomorrow");
    expect(updateBookingStatus).not.toHaveBeenCalled();
    expect(ownerReplies().at(-1)).toMatch(/Cancel Dana Jones .*Spring cleanup.*\? Reply \d{4} to confirm, or N to leave it/);

    await text("N");
    expect(updateBookingStatus).not.toHaveBeenCalled();
    expect(db.tables.owner_approvals[0].status).toBe("rejected");

    scriptModel([{ name: "propose_cancel", input: { booking_id: B_DANA } }], "unused");
    await text("cancel Dana tomorrow");
    await text(lastCode());
    expect(updateBookingStatus).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org-1" }), { bookingId: B_DANA, status: "cancelled" });
  });

  it("a blind spoofer can't confirm: Y doesn't, wrong codes don't, and three wrong codes cancel it", async () => {
    scriptModel([{ name: "propose_cancel", input: { booking_id: B_DANA } }], "unused");
    await text("cancel Dana");
    const code = lastCode();
    const wrong = code === "1234" ? "4321" : "1234";
    await text("Y");
    await text(wrong);
    expect(ownerReplies().at(-1)).toMatch(/doesn't match/);
    await text(wrong);
    await text(wrong);
    expect(ownerReplies().at(-1)).toMatch(/last try/);
    expect(db.tables.owner_approvals[0].status).toBe("rejected");
    await text(code);
    expect(updateBookingStatus).not.toHaveBeenCalled();
  });

  it("with an AI approval also waiting, a bare Y goes to the AI approval, the code to the confirmation", async () => {
    db.tables.owner_approvals.push({
      id: "a-ai", organization_id: "org-1", company_id: "co-1", kind: "send_quote", summary: "Quote for Sam: $650.", payload: {},
      status: "pending", short_code: 1, requested_by: "sms_agent", notified_at: "2026-10-07T13:00:00Z", notified_to: OWNER,
      expires_at: "2026-10-08T13:00:00Z", created_at: "2026-10-07T13:00:00Z",
    });
    scriptModel([{ name: "propose_cancel", input: { booking_id: B_DANA } }], "unused");
    await text("cancel Dana");
    const code = lastCode();
    await text(code);
    expect(updateBookingStatus).toHaveBeenCalledTimes(1);
    expect(executeApprovedAction).not.toHaveBeenCalled();
    expect(db.tables.owner_approvals.find((a) => a.id === "a-ai")?.status).toBe("pending");
    await text("Y");
    expect(executeApprovedAction).toHaveBeenCalledTimes(1);
  });

  it("text a customer: echoes the exact message for a code, then sends from the company number and marks the owner takeover", async () => {
    scriptModel([{ name: "text_customer", input: { contact_id: DANA, message: "We'll be there at 3." } }], "unused");
    await text("tell Dana we'll be there at 3");
    expect(deliverMessage.mock.calls.some((c) => (c[0] as Record<string, unknown>).contactId === DANA)).toBe(false);
    expect(ownerReplies().at(-1)).toMatch(/^CrankLeads: Send to Dana Jones: "We'll be there at 3\."\? Reply \d{4} to confirm/);
    await text(lastCode());

    const customer = deliverMessage.mock.calls.map((c) => c[0] as Record<string, unknown>).find((m) => m.contactId === DANA);
    expect(customer).toMatchObject({ to: "+17055550123", companyId: "co-1", body: "We'll be there at 3." });
    expect(customer?.smsFrom).toBeUndefined(); // company number, not the platform number
    expect(customer?.consentContact).toBeTruthy(); // consent still checked
    expect(db.tables.sms_conversations[0]).toMatchObject({ organization_id: "org-1", company_id: "co-1", contact_id: DANA, state: "owner" });
    expect(db.tables.sms_conversations[0].owner_takeover_at).toBeTruthy();
    expect(ownerReplies().at(-1)).toBe("CrankLeads: Sent to Dana Jones. The assistant will stay out of that conversation for now.");
  });

  it("another company's booking or customer is 'not found' — no change, no text, no leak", async () => {
    scriptModel(
      [
        { name: "propose_cancel", input: { booking_id: B_OTHER } },
        { name: "text_customer", input: { contact_id: OTHER_CONTACT, message: "hi" } },
        { name: "find_customer", input: { query: "Secret" } },
      ],
      "I can't find that one.",
    );
    await text("cancel the Secret job and text them");
    expect(toolResult(1)).toContain("No such booking");
    expect(toolResult(2)).toContain("No such customer");
    expect(toolResult(3)).not.toContain("Secret job");
    expect(toolResult(3)).toContain('"customers":[]');
    expect(db.tables.owner_approvals).toHaveLength(0);
    expect(deliverMessage.mock.calls.some((c) => (c[0] as { to: string }).to === "+14165550000")).toBe(false);
    expect(db.tables.bookings.find((b) => b.id === B_OTHER)?.status).toBe("confirmed");
  });

  it("AI off for a customer and for the business", async () => {
    scriptModel(
      [
        { name: "set_ai_for_customer", input: { contact_id: DANA, on: false } },
        { name: "set_ai_for_business", input: { on: false } },
      ],
      "AI is off.",
    );
    await text("turn the AI off for Dana and everyone");
    expect(db.tables.sms_conversations[0]).toMatchObject({ contact_id: DANA, state: "paused" });
    expect(db.tables.companies[0].ai_settings).toEqual({ sms_agent: { enabled: false } });
    expect((db.tables.companies[1].ai_settings as Record<string, unknown>).sms_agent).toBeUndefined();
  });

  it("pause all texts pauses texting automations and resume restores exactly those", async () => {
    db.tables.workflows.push(
      { id: "w-1", organization_id: "org-1", company_id: "co-1", status: "active", definition: { actions: [{ type: "send_sms", to: "contact" }] } },
      { id: "w-2", organization_id: "org-1", company_id: "co-1", status: "active", definition: { actions: [{ type: "create_task" }] } },
      { id: "w-3", organization_id: "org-1", company_id: "co-1", status: "paused", definition: { actions: [{ type: "send_sms" }] } },
    );
    scriptModel([{ name: "pause_all_texts", input: {} }], "Paused.");
    await text("pause all texts");
    expect(db.tables.workflows.map((w) => w.status)).toEqual(["paused", "active", "paused"]);
    expect((db.tables.companies[0].ai_settings as { sms_agent: unknown }).sms_agent).toEqual({ enabled: false });

    scriptModel([{ name: "resume_all_texts", input: {} }], "Back on.");
    await text("resume texts");
    expect(db.tables.workflows.map((w) => w.status)).toEqual(["active", "active", "paused"]);
    expect(db.tables.companies[0].ai_settings).toEqual({ sms_agent: {} });
  });

  it("an owner of two businesses is asked which one, and the answer runs the original command there", async () => {
    db.tables.companies.push({ id: "co-2", organization_id: "org-1", name: "Bayview Snow", timezone: "America/Toronto", owner_phone_e164: OWNER, owner_phone_verified_at: "2026-10-01T00:00:00Z", ai_settings: {} });
    scriptModel([], "Nothing on tomorrow at Bayview.");
    await text("what's on tomorrow?");
    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(ownerReplies().at(-1)).toMatch(/Which business — 1\) Northshore Lawn 2\) Bayview Snow\?/);

    await text("2");
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    const call = anthropicCreate.mock.calls[0][0] as { system: Array<{ text: string }>; messages: Array<{ content: string }> };
    expect(call.system[0].text).toContain("Bayview Snow");
    expect(call.messages[0].content).toBe("what's on tomorrow?");

    // The next command without a name stays with the business we were just talking about.
    await text("and the day after?");
    const next = anthropicCreate.mock.calls[1][0] as { system: Array<{ text: string }> };
    expect(next.system[0].text).toContain("Bayview Snow");
  });

  it("naming the business picks it", async () => {
    db.tables.companies.push({ id: "co-2", organization_id: "org-1", name: "Bayview Snow", timezone: "America/Toronto", owner_phone_e164: OWNER, owner_phone_verified_at: "2026-10-01T00:00:00Z", ai_settings: {} });
    scriptModel([], "ok");
    await text("what's on tomorrow for northshore");
    expect((anthropicCreate.mock.calls[0][0] as { system: Array<{ text: string }> }).system[0].text).toContain("Northshore Lawn");
  });

  it("commands are rate-limited per phone", async () => {
    db.onRpc((_n, args) => ({ data: !String(args.p_key).startsWith("owner_ai:"), error: null }));
    scriptModel([], "ok");
    await text("what's on today");
    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(ownerReplies().at(-1)).toMatch(/a lot at once/);
  });
});
