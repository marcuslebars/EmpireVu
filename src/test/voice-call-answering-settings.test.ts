import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "./fake-supabase";

// Call-answering settings (reader + route), monthly minute accounting, the tenant token.
const h = vi.hoisted(() => ({ db: null as FakeDb | null, role: "owner" }));
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.db?.client }));
vi.mock("@/server/supabase/server", () => ({ createSupabaseServerClient: () => h.db?.client }));
vi.mock("@/server/organizations/context", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/organizations/context")>();
  return {
    ...original,
    requireOrganizationContext: async (_s: unknown, organizationId: string) => ({ organizationId, user: { id: "user-1" }, membership: { role: h.role } }),
  };
});

import { GET, PATCH } from "@/app/api/organizations/[organizationId]/companies/[companyId]/ai-settings/call-answering/route";
import {
  nextCivilTime,
  readAnswerMetadata,
  buildAnswerMetadata,
  signAnswerToken,
  verifyAnswerToken,
} from "@/server/services/voice/ai-answer";
import { mergeCallAnsweringSettings, readCallAnsweringSettings } from "@/server/services/voice/answering-settings";
import { aiCallTimeLimitSeconds, loadMinuteAllowance, monthName } from "@/server/services/voice/minutes";

const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const COMPANY_2 = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2026-10-09T16:00:00Z");

const env = { ...process.env };
afterAll(() => {
  process.env = env;
});

function seed(o: { tier?: string; plan?: string; aiSettings?: Record<string, unknown>; usage?: Array<Record<string, unknown>>; flags?: Array<Record<string, unknown>> } = {}): FakeDb {
  return createFakeDb({
    companies: [
      {
        id: COMPANY,
        organization_id: ORG,
        name: "Northshore Plumbing",
        ai_settings: o.aiSettings ?? { sms_agent: { autonomy: "ask_first" }, weekly_report: { enabled: false } },
        hours: null,
        service_area: null,
        quote_public_base_url: null,
        industry_pack: null,
        timezone: "America/Toronto",
        online_booking_settings: {},
      },
    ],
    organizations: [{ id: ORG, plan: o.plan ?? "operate", subscription_status: "active", trial_ends_at: null, platform_brand: "crankleads", crankleads_tier: o.tier ?? "close" }],
    subscriptions: [],
    feature_flags: o.flags ?? [],
    usage_monthly_v: o.usage ?? [],
  });
}

beforeEach(() => {
  h.db = seed();
  h.role = "owner";
  process.env.RETELL_INTAKE_ENABLED = "1";
  process.env.RETELL_API_KEY = "k";
  process.env.RETELL_MESSAGE_AGENT_ID = "agent_message";
  process.env.RETELL_FUNCTION_SECRET = "s";
});

describe("readCallAnsweringSettings", () => {
  it("defaults: AI for CrankLeads, voicemail for house orgs, 100 minutes", () => {
    expect(readCallAnsweringSettings({}, { crankleads: true })).toEqual({ mode: "ai", includedMinutes: 100, modeExplicit: false });
    expect(readCallAnsweringSettings(null, { crankleads: false })).toEqual({ mode: "voicemail", includedMinutes: 100, modeExplicit: false });
    expect(readCallAnsweringSettings({ call_answering: { mode: "ai", included_minutes: 250 } }, { crankleads: false })).toEqual({
      mode: "ai",
      includedMinutes: 250,
      modeExplicit: true,
    });
    expect(readCallAnsweringSettings({ call_answering: { mode: "robot", included_minutes: -5 } }, { crankleads: true }).mode).toBe("ai");
  });

  it("merge touches ONLY call_answering", () => {
    const before = { sms_agent: { enabled: false }, weekly_report: { channels: ["sms"] }, call_answering: { included_minutes: 150 } };
    expect(mergeCallAnsweringSettings(before, { mode: "voicemail" })).toEqual({
      sms_agent: { enabled: false },
      weekly_report: { channels: ["sms"] },
      call_answering: { included_minutes: 150, mode: "voicemail" },
    });
  });
});

describe("monthly minutes", () => {
  it("Catch / Close: per COMPANY, against included_minutes", async () => {
    h.db = seed({
      usage: [
        { organization_id: ORG, company_id: COMPANY, month: "2026-10-01", kind: "voice_minutes", quantity: 42.26 },
        { organization_id: ORG, company_id: COMPANY_2, month: "2026-10-01", kind: "voice_minutes", quantity: 50 },
        { organization_id: ORG, company_id: COMPANY, month: "2026-09-01", kind: "voice_minutes", quantity: 99 },
        { organization_id: ORG, company_id: COMPANY, month: "2026-10-01", kind: "sms_sent", quantity: 500 },
      ],
    });
    const a = await loadMinuteAllowance(h.db.client as never, { organizationId: ORG, companyId: COMPANY, tier: "close", plan: "operate", includedMinutes: 100 }, NOW);
    expect(a).toEqual({ scope: "company", source: "call_answering", includedMinutes: 100, usedMinutes: 42.3, remainingMinutes: 57.7, month: "2026-10-01" });
  });

  it("Front Desk: the plan's org-wide 500 (same count requireFeature uses), a feature_flags override wins", async () => {
    h.db = seed({
      tier: "front_desk",
      plan: "front_desk",
      usage: [
        { organization_id: ORG, company_id: COMPANY, month: "2026-10-01", kind: "voice_minutes", quantity: 300 },
        { organization_id: ORG, company_id: COMPANY_2, month: "2026-10-01", kind: "voice_minutes", quantity: 150 },
      ],
    });
    const a = await loadMinuteAllowance(h.db.client as never, { organizationId: ORG, companyId: COMPANY, tier: "front_desk", plan: "front_desk", includedMinutes: 100 }, NOW);
    expect(a).toMatchObject({ scope: "organization", source: "marina_reception", includedMinutes: 500, usedMinutes: 450, remainingMinutes: 50 });

    h.db.tables.feature_flags.push({ organization_id: ORG, feature: "marina_reception", enabled: true, limit_value: 1000 });
    const b = await loadMinuteAllowance(h.db.client as never, { organizationId: ORG, companyId: COMPANY, tier: "front_desk", plan: "front_desk", includedMinutes: 100 }, NOW);
    expect(b.remainingMinutes).toBe(550);
  });

  it("call time limit follows what's left (1–15 min)", () => {
    expect(aiCallTimeLimitSeconds(null)).toBe(900);
    expect(aiCallTimeLimitSeconds(57.7)).toBe(900);
    expect(aiCallTimeLimitSeconds(3)).toBe(180);
    expect(aiCallTimeLimitSeconds(0.2)).toBe(60);
    expect(monthName("2026-10-01")).toBe("October");
  });
});

describe("tenant token", () => {
  const claims = { organizationId: ORG, companyId: COMPANY, callSid: "CA1" };
  it("verifies only the exact tenant + call it was signed for", () => {
    const token = signAnswerToken(claims, "secret");
    expect(verifyAnswerToken(claims, token, "secret")).toBe(true);
    expect(verifyAnswerToken({ ...claims, companyId: COMPANY_2 }, token, "secret")).toBe(false);
    expect(verifyAnswerToken({ ...claims, callSid: "CA2" }, token, "secret")).toBe(false);
    expect(verifyAnswerToken(claims, token, "other")).toBe(false);
    expect(verifyAnswerToken(claims, token, null)).toBe(false);
    expect(verifyAnswerToken(claims, undefined, "secret")).toBe(false);
  });

  it("readAnswerMetadata: not ours → null; claims-but-forged → invalid; good → tenant", () => {
    expect(readAnswerMetadata({ contactId: "x" }, "secret")).toBeNull();
    expect(readAnswerMetadata({ ...buildAnswerMetadata(claims, "message", "secret"), company_id: COMPANY_2 }, "secret")).toEqual({ valid: false });
    expect(readAnswerMetadata(buildAnswerMetadata(claims, "receptionist", "secret"), "secret")).toEqual({ ...claims, agentKind: "receptionist" });
  });

  it("tokens expire, and the issue time is signed (can't be bumped)", () => {
    const issued = new Date("2026-10-09T12:00:00Z");
    const meta = buildAnswerMetadata(claims, "message", "secret", issued);
    expect(readAnswerMetadata(meta, "secret", issued.getTime() + 60_000)).toEqual({ ...claims, agentKind: "message" });
    expect(readAnswerMetadata(meta, "secret", issued.getTime() + 25 * 3_600_000)).toEqual({ valid: false });
    expect(readAnswerMetadata({ ...meta, issued_at: String(Math.floor(issued.getTime() / 1000) + 86_400) }, "secret", issued.getTime() + 25 * 3_600_000)).toEqual({ valid: false });
    const { issued_at: _drop, ...noIat } = meta;
    expect(readAnswerMetadata(noIat, "secret", issued.getTime())).toEqual({ valid: false });
  });

  it("owner notices wait for 08:00–21:00 local", () => {
    expect(nextCivilTime(new Date("2026-10-09T16:00:00Z"), "America/Toronto").toISOString()).toBe("2026-10-09T16:00:00.000Z"); // 12:00 EDT
    expect(nextCivilTime(new Date("2026-10-10T02:30:00Z"), "America/Toronto").toISOString()).toBe("2026-10-10T12:00:00.000Z"); // 22:30 → 08:00
    expect(nextCivilTime(new Date("2026-10-09T09:15:00Z"), "America/Toronto").toISOString()).toBe("2026-10-09T12:00:00.000Z"); // 05:15 → 08:00
  });
});

const ctx = { params: { organizationId: ORG, companyId: COMPANY } };
const patch = (body: unknown) =>
  PATCH(new Request("http://x/api", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), ctx);

describe("/ai-settings/call-answering route", () => {
  it("GET: mode, this month's minutes and the preview", async () => {
    const res = await GET(new Request("http://x/api"), ctx);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({ mode: "ai", includedMinutes: 100, agentKind: "message", available: true, allowance: { includedMinutes: 100, usedMinutes: 0 } });
    expect(data.preview.greeting).toBe("Hi, thanks for calling Northshore Plumbing. You've reached their automated assistant, and this call may be recorded. How can I help you today?");
    expect(data.preview.never).toContain("Give prices or estimates");
  });

  it("PATCH (owner/admin): merges ONLY ai_settings.call_answering", async () => {
    const res = await patch({ mode: "voicemail" });
    expect(res.status).toBe(200);
    expect((await res.json()).data.mode).toBe("voicemail");
    expect(h.db!.tables.companies[0].ai_settings).toEqual({
      sms_agent: { autonomy: "ask_first" },
      weekly_report: { enabled: false },
      call_answering: { mode: "voicemail" },
    });
  });

  it("PATCH refuses members and owner-set minutes", async () => {
    h.role = "member";
    expect((await patch({ mode: "voicemail" })).status).toBe(403);
    h.role = "owner";
    expect((await patch({ mode: "ai", included_minutes: 5000 })).status).toBe(400);
    expect((await patch({ mode: "shout" })).status).toBe(400);
    expect(h.db!.tables.companies[0].ai_settings).not.toHaveProperty("call_answering");
  });

  it("a company outside the org → 4xx, nothing written", async () => {
    const res = await PATCH(
      new Request("http://x/api", { method: "PATCH", body: JSON.stringify({ mode: "voicemail" }) }),
      { params: { organizationId: ORG, companyId: COMPANY_2 } },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(h.db!.tables.companies[0].ai_settings).not.toHaveProperty("call_answering");
  });
});
