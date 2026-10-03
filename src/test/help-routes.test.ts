/**
 * Help routes (docs/help-assistant.md): auth boundary, per-user / per-org rate limits,
 * org scoping of everything written, and the "Contact support" row + operator email.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/fake-supabase";

const ORG = "22222222-2222-2222-2222-222222222222";
const OTHER_ORG = "33333333-3333-3333-3333-333333333333";
const USER = "11111111-1111-1111-1111-111111111111";
const SESSION = "44444444-4444-4444-4444-444444444444";

const h = vi.hoisted(() => {
  const buckets = new Map<string, number>();
  const rpc = vi.fn((name: string, args: { p_key: string; p_limit: number }) => {
    if (name !== "consume_rate_limit") return Promise.resolve({ data: null, error: null });
    const hits = (buckets.get(args.p_key) ?? 0) + 1;
    buckets.set(args.p_key, hits);
    return Promise.resolve({ data: hits <= args.p_limit, error: null });
  });
  const usageUpsert = vi.fn(() => Promise.resolve({ data: null, error: null }));
  return {
    buckets,
    rpc,
    usageUpsert,
    state: { user: null as { id: string; email: string } | null, db: null as FakeDb | null },
    callHelpModel: vi.fn(),
    sendEmail: vi.fn(),
    emailConfigured: { value: true },
  };
});

vi.mock("@/server/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ rpc: h.rpc, from: () => ({ upsert: h.usageUpsert }) }),
}));

vi.mock("@/server/supabase/server", () => ({
  createSupabaseServerClient: () => ({
    auth: {
      async getUser() {
        return h.state.user
          ? { data: { user: h.state.user }, error: null }
          : { data: { user: null }, error: { message: "no session" } };
      },
    },
    from: (table: string) => (h.state.db as FakeDb).client.from(table),
  }),
}));

vi.mock("@/server/ai/help-assistant", async () => {
  const actual = await vi.importActual<typeof import("@/server/ai/help-assistant")>("@/server/ai/help-assistant");
  return { ...actual, callHelpModel: h.callHelpModel };
});

vi.mock("@/server/outbound/email", async () => {
  const actual = await vi.importActual<typeof import("@/server/outbound/email")>("@/server/outbound/email");
  return { ...actual, sendEmail: h.sendEmail, isEmailSendConfigured: () => h.emailConfigured.value };
});

import { POST as askPOST } from "@/app/api/organizations/[organizationId]/help/ask/route";
import { POST as escalatePOST } from "@/app/api/organizations/[organizationId]/help/escalate/route";

const ctx = (organizationId = ORG) => ({ params: { organizationId } });
const req = (body: unknown) =>
  new Request(`http://test/api/organizations/${ORG}/help/x`, { method: "POST", body: JSON.stringify(body) });

function seedDb(): FakeDb {
  return createFakeDb({
    organization_memberships: [{ id: "m1", organization_id: ORG, profile_id: USER, role: "owner" }],
    profiles: [{ id: USER, email: "owner@acme.test" }],
    organizations: [
      { id: ORG, name: "Acme Roofing", plan: "operate", subscription_status: "active", crankleads_tier: "catch" },
      { id: OTHER_ORG, name: "Secret Competitor Inc", plan: "front_desk", subscription_status: "active", crankleads_tier: null },
    ],
    companies: [
      { id: "co-a", organization_id: ORG, name: "Acme Roofing", created_at: "2026-10-01" },
      { id: "co-b", organization_id: OTHER_ORG, name: "Secret Competitor Inc", created_at: "2026-10-02" },
    ],
    onboarding_progress: [
      { organization_id: ORG, company_id: "co-a", step: "business", status: "complete" },
      { organization_id: OTHER_ORG, company_id: "co-b", step: "phone", status: "complete" },
    ],
  });
}

beforeEach(() => {
  h.buckets.clear();
  h.rpc.mockClear();
  h.callHelpModel.mockReset();
  h.sendEmail.mockReset();
  h.sendEmail.mockResolvedValue({ id: "email_1" });
  h.emailConfigured.value = true;
  h.state.db = seedDb();
  h.state.user = { id: USER, email: "owner@acme.test" };
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubEnv("OWNER_EMAIL", "marcus@example.test");
  vi.stubEnv("HELP_ASK_DAILY_LIMIT_PER_USER", "");
  vi.stubEnv("HELP_ASK_DAILY_LIMIT_PER_ORG", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("auth boundary", () => {
  const calls: Array<[string, (org?: string) => Promise<Response>]> = [
    ["ask", (org) => askPOST(req({ question: "how do I forward calls" }), ctx(org))],
    ["escalate", (org) => escalatePOST(req({ question: "help me" }), ctx(org))],
  ];

  it.each(calls)("%s → 401 when signed out", async (_label, call) => {
    h.state.user = null;
    const res = await call();
    expect(res.status).toBe(401);
    expect((await res.json()).data).toBeUndefined();
    expect(h.callHelpModel).not.toHaveBeenCalled();
  });

  it.each(calls)("%s → 403 for a user who isn't a member of the org in the URL", async (_label, call) => {
    const res = await call(OTHER_ORG);
    expect(res.status).toBe(403);
    expect((await res.json()).data).toBeUndefined();
    expect(h.callHelpModel).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(h.state.db?.tables.support_requests ?? []).toHaveLength(0);
  });
});

describe("POST /help/ask", () => {
  it("answers from the articles with the caller's own account context only", async () => {
    h.callHelpModel.mockResolvedValue({
      answer: { status: "answered", answer: "Dial ##004# from your business phone.", sourceArticleIds: ["call-forwarding"] },
      usage: { responseId: "msg_1", model: "m", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    });

    const res = await askPOST(req({ question: "how do I turn off call forwarding", sessionId: SESSION }), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      status: "answered",
      answer: "Dial ##004# from your business phone.",
      sources: [{ id: "call-forwarding", title: "Turn call forwarding on and off" }],
    });

    const prompt = String(h.callHelpModel.mock.calls[0][0]);
    expect(prompt).toContain("Plan: Operate");
    expect(prompt).toContain("Setup steps done: Business");
    expect(prompt).not.toContain("Secret Competitor");
    expect(prompt).not.toContain(OTHER_ORG);

    // AI usage metered (best-effort, service-role ledger).
    expect(h.usageUpsert).toHaveBeenCalled();

    const events = h.state.db?.tables.help_chat_events ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ organization_id: ORG, profile_id: USER, session_id: SESSION, event_type: "answered" });
  });

  it("rejects an empty or oversized question", async () => {
    expect((await askPOST(req({ question: "  " }), ctx())).status).toBe(400);
    expect((await askPOST(req({ question: "x".repeat(1001) }), ctx())).status).toBe(400);
  });

  it("logs not_sure without a model call when nothing matches", async () => {
    const res = await askPOST(req({ question: "what is the weather in naples tomorrow" }), ctx());
    expect((await res.json()).data.status).toBe("not_sure");
    expect(h.callHelpModel).not.toHaveBeenCalled();
    expect(h.state.db?.tables.help_chat_events?.[0]).toMatchObject({ event_type: "not_sure" });
  });

  it("rate-limits per user per minute", async () => {
    for (let i = 0; i < 6; i++) {
      expect((await askPOST(req({ question: "talk to a human" }), ctx())).status).toBe(200);
    }
    const blocked = await askPOST(req({ question: "talk to a human" }), ctx());
    expect(blocked.status).toBe(429);
    const keys = h.rpc.mock.calls.map((c) => (c[1] as { p_key: string }).p_key);
    expect(keys).toContain(`help_ask_user_min:${USER}`);
    expect(keys).toContain(`help_ask_user_day:${USER}`);
    expect(keys).toContain(`help_ask_org_day:${ORG}`);
  });

  it("enforces the per-org daily cap from env", async () => {
    vi.stubEnv("HELP_ASK_DAILY_LIMIT_PER_ORG", "2");
    expect((await askPOST(req({ question: "talk to a human" }), ctx())).status).toBe(200);
    expect((await askPOST(req({ question: "talk to a human" }), ctx())).status).toBe(200);
    expect((await askPOST(req({ question: "talk to a human" }), ctx())).status).toBe(429);
  });
});

describe("POST /help/escalate", () => {
  const transcript = [
    { role: "user", text: "how do I add my google review link?" },
    { role: "assistant", text: "I'm not sure — click Contact support." },
  ];

  it("saves an org-scoped support request and emails the operator with the transcript", async () => {
    const res = await escalatePOST(
      req({ question: "how do I add my google review link?", transcript, sessionId: SESSION, reason: "not_sure" }),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.message).toBe("We've got it — we'll reply by email.");

    const rows = h.state.db?.tables.support_requests ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organization_id: ORG,
      profile_id: USER,
      requester_email: "owner@acme.test",
      reason: "not_sure",
      session_id: SESSION,
    });
    expect(rows[0].transcript).toEqual(transcript);
    expect(rows[0].context).toMatchObject({ plan: "operate", crankleadsTier: "catch", organizationName: "Acme Roofing" });

    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    const mail = h.sendEmail.mock.calls[0][0];
    expect(mail.to).toBe("marcus@example.test");
    expect(mail.replyTo).toBe("owner@acme.test");
    expect(mail.subject).toContain("Acme Roofing");
    expect(mail.body).toContain("From: owner@acme.test");
    expect(mail.body).toContain("Plan: Operate");
    expect(mail.body).toContain("Bought through: CrankLeads Catch");
    expect(mail.body).toContain("Customer: how do I add my google review link?");
    expect(mail.body).toContain("Assistant: I'm not sure");
    expect(mail.body).not.toContain("Secret Competitor");

    const events = h.state.db?.tables.help_chat_events ?? [];
    expect(events[0]).toMatchObject({ event_type: "escalated", organization_id: ORG, support_request_id: rows[0].id });
    expect(events[0].metadata).toMatchObject({ email: "sent" });
  });

  it("keeps the request (and still confirms) when the email can't be sent", async () => {
    h.sendEmail.mockRejectedValue(new Error("Resend down"));
    const res = await escalatePOST(req({ question: "my form is broken" }), ctx());
    expect(res.status).toBe(200);
    expect(h.state.db?.tables.support_requests).toHaveLength(1);
    expect(h.state.db?.tables.help_chat_events?.[0].metadata).toMatchObject({ email: "failed" });
  });

  it("doesn't email when OWNER_EMAIL is unset, but saves the row", async () => {
    vi.stubEnv("OWNER_EMAIL", "");
    const res = await escalatePOST(req({ question: "my form is broken" }), ctx());
    expect(res.status).toBe(200);
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(h.state.db?.tables.help_chat_events?.[0].metadata).toMatchObject({ email: "not_configured" });
  });

  it("fails loudly (500, no email) when the row can't be saved", async () => {
    h.state.db?.failNext("support_requests", { message: "rls denied" }, "insert");
    const res = await escalatePOST(req({ question: "my form is broken" }), ctx());
    expect(res.status).toBe(500);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it("strips newlines from the subject and caps the transcript", async () => {
    const long = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `t${i}` }));
    await escalatePOST(req({ question: "line one\nBcc: evil@example.com", transcript: long }), ctx());
    const mail = h.sendEmail.mock.calls[0][0];
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(h.state.db?.tables.support_requests?.[0].transcript).toHaveLength(10);
  });

  it("rate-limits escalations per user per day", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await escalatePOST(req({ question: `q${i}` }), ctx())).status).toBe(200);
    }
    expect((await escalatePOST(req({ question: "q6" }), ctx())).status).toBe(429);
    expect(h.state.db?.tables.support_requests).toHaveLength(5);
  });
});
