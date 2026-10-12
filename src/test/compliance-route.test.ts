import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

// Compliance routes: Settings (GET members → counts only / owners+admins → documents; PATCH merges
// ONLY ai_settings.compliance; POST actions owners/admins), a sub's public upload link, and the
// revocable certificate link (redirect while live, 410 after).
const h = vi.hoisted(() => ({ db: null as FakeDb | null, role: "owner", limited: false }));
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.db?.client }));
vi.mock("@/server/supabase/server", () => ({ createSupabaseServerClient: () => h.db?.client }));
vi.mock("@/server/outbound/sms", () => ({ sendSms: vi.fn(() => Promise.resolve({ sid: "SM1" })) }));
vi.mock("@/server/outbound/email", () => ({ sendEmail: vi.fn(() => Promise.resolve({ id: "re_1" })) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: vi.fn(), recordAiUsageSafe: vi.fn() }));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({ emitActivityEventAndDispatch: vi.fn(() => Promise.resolve({})) }));
vi.mock("@/server/organizations/context", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/organizations/context")>();
  return {
    ...original,
    requireOrganizationContext: async (_s: unknown, organizationId: string) => ({ organizationId, user: { id: "user-1" }, membership: { role: h.role } }),
  };
});

import { GET, PATCH, POST } from "@/app/api/organizations/[organizationId]/companies/[companyId]/ai-settings/compliance/route";
import { GET as DOC } from "@/app/api/public/compliance/doc/[token]/route";
import { GET as UPLOAD_VIEW, POST as UPLOAD } from "@/app/api/public/compliance/upload/[token]/route";
import { resetComplianceDeps, setComplianceDeps } from "@/server/services/staff/compliance/deps";

const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const OTHER = "66666666-6666-4666-8666-666666666666";
const SUB = "5b000000-0000-4000-8000-000000000001";
const TOKEN = "tok_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LINK = "lnk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ctx = { params: { organizationId: ORG, companyId: COMPANY } };
const files = new Set<string>();

function seed(): FakeDb {
  const db = createFakeDb({
    companies: [{ id: COMPANY, organization_id: ORG, name: "Northshore Roofing", timezone: "America/Toronto", stage: "active", ai_settings: { sms_agent: { autonomy: "ask_first" } }, owner_phone_e164: "+17055559999", owner_phone_verified_at: "2026-10-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }],
    organizations: [{ id: ORG, platform_brand: "crankleads" }],
    organization_memberships: [{ organization_id: ORG, profile_id: "user-1", role: "owner" }],
    profiles: [{ id: "user-1", full_name: "Dana Whitfield", email: "dana@x.test" }],
    subcontractors: [{ id: SUB, organization_id: ORG, company_id: COMPANY, name: "Mike Rossi", business_name: "Mike's Electric", phone_e164: "+17055550142", email: null, active: true, created_at: "2026-05-01T00:00:00Z" }],
    compliance_documents: [
      { id: "d0000000-0000-4000-8000-0000000000d1", organization_id: ORG, company_id: COMPANY, kind: "liability_insurance", holder_type: "company", issuer: "Intact", number: "CGL-554821", expires_on: "2027-03-31", file_path: `${ORG}/${COMPANY}/doc-1.pdf`, file_content_type: "application/pdf", status: "current", uploaded_via: "sms", created_at: "2026-09-01T00:00:00Z" },
    ],
    compliance_upload_requests: [{ id: "r1", organization_id: ORG, company_id: COMPANY, subcontractor_id: SUB, token: TOKEN, kinds: ["wsib_clearance"], channel: "sms", status: "sent", uploads: 0, expires_at: "2026-10-26T00:00:00Z", created_at: "2026-10-12T00:00:00Z" }],
    compliance_shares: [{ id: "s1", organization_id: ORG, company_id: COMPANY, document_id: "d0000000-0000-4000-8000-0000000000d1", contact_id: null, token: LINK, status: "sent", open_count: 0, expires_at: "2026-10-19T00:00:00Z", created_at: "2026-10-12T00:00:00Z" }],
    compliance_events: [],
    contacts: [],
    message_log: [],
    owner_approvals: [],
    platform_sms_opt_outs: [],
  });
  db.onRpc(() => ({ data: !h.limited, error: null }));
  return db;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-10-12T14:00:00Z"));
  h.db = seed();
  h.role = "owner";
  h.limited = false;
  files.clear();
  files.add(`${ORG}/${COMPANY}/doc-1.pdf`);
  setComplianceDeps({
    read: async () => null,
    storage: () => ({
      upload: async (p) => void files.add(p),
      download: async () => new Uint8Array([1]),
      createUploadUrl: async (p) => ({ path: p, token: "up" }),
      exists: async (p) => files.has(p),
      signedUrl: async (p, ttl) => `https://storage.test/${p}?ttl=${ttl}`,
      remove: async () => undefined,
    }),
  });
});

afterEach(() => {
  vi.useRealTimers();
  resetComplianceDeps();
});

const json = async (res: Response) => (await res.json()) as { data?: Record<string, unknown>; error?: string };
const post = (body: unknown) => POST(new Request("http://x/api", { method: "POST", body: JSON.stringify(body) }), ctx);

describe("Settings route", () => {
  it("members see counts only; owners see the documents", async () => {
    h.role = "member";
    const member = (await json(await GET(new Request("http://x/api"), ctx))).data!;
    expect(member.documents).toBeNull();
    expect(member.counts).toMatchObject({ documents: 1 });
    h.role = "owner";
    const owner = (await json(await GET(new Request("http://x/api"), ctx))).data!;
    expect((owner.documents as unknown[]).length).toBe(1);
  });

  it("PATCH: owners/admins only, strict, merges only ai_settings.compliance", async () => {
    h.role = "member";
    expect((await PATCH(new Request("http://x/api", { method: "PATCH", body: JSON.stringify({ reminders: false }) }), ctx)).status).toBe(403);
    h.role = "admin";
    expect((await PATCH(new Request("http://x/api", { method: "PATCH", body: JSON.stringify({ reminders: false, extra: 1 }) }), ctx)).status).toBe(400);
    const res = await PATCH(new Request("http://x/api", { method: "PATCH", body: JSON.stringify({ reminders: false }) }), ctx);
    expect(res.status).toBe(200);
    expect(h.db!.tables.companies[0].ai_settings).toEqual({ sms_agent: { autonomy: "ask_first" }, compliance: { reminders: false } });
  });

  it("POST actions: owner only; another company is refused; upload URL, sub save, link off, file URL", async () => {
    h.role = "member";
    expect((await post({ action: "revoke_share", id: "5b000000-0000-4000-8000-0000000000aa" })).status).toBe(403);
    h.role = "owner";
    const other = await POST(new Request("http://x/api", { method: "POST", body: JSON.stringify({ action: "upload_url", contentType: "image/jpeg" }) }), { params: { organizationId: ORG, companyId: OTHER } });
    expect(other.status).toBeGreaterThanOrEqual(400);
    const up = (await json(await post({ action: "upload_url", contentType: "image/jpeg" }))).data!;
    expect(String(up.path)).toMatch(new RegExp(`^${ORG}/${COMPANY}/doc-`));
    const saved = (await json(await post({ action: "save_sub", businessName: "Lakeside Drywall", phone: "705-555-0177" }))).data!;
    expect((saved.subs as Array<{ name: string }>).map((s) => s.name)).toContain("Lakeside Drywall");
    expect((await post({ action: "save_sub", businessName: "X", phone: "12" })).status).toBe(400);
    const url = (await json(await post({ action: "file_url", id: "d0000000-0000-4000-8000-0000000000d1" }))).data!;
    expect(url.url).toBe(`https://storage.test/${ORG}/${COMPANY}/doc-1.pdf?ttl=120`);
  });
});

describe("public routes", () => {
  it("the sub's upload link: view, 404 for junk, rate limited", async () => {
    const view = await UPLOAD_VIEW(new Request("http://x/api"), { params: { token: TOKEN } });
    expect(view.status).toBe(200);
    expect((await json(view)).data).toMatchObject({ businessName: "Northshore Roofing", subName: "Mike's Electric" });
    expect((await UPLOAD_VIEW(new Request("http://x/api"), { params: { token: "short" } })).status).toBe(404);
    const up = await UPLOAD(new Request("http://x/api", { method: "POST", body: JSON.stringify({ action: "upload_url", contentType: "application/pdf" }) }), { params: { token: TOKEN } });
    expect(String((await json(up)).data?.path)).toMatch(new RegExp(`^${ORG}/${COMPANY}/sub-r1-`));
    h.limited = true;
    expect((await UPLOAD_VIEW(new Request("http://x/api"), { params: { token: TOKEN } })).status).toBe(429);
  });

  it("the certificate link: redirects to a short signed URL while live; 410 once turned off", async () => {
    const live = await DOC(new Request("http://x/api", { headers: { "x-forwarded-for": "198.51.100.4", "user-agent": "Chrome" } }), { params: { token: LINK } });
    expect(live.status).toBe(302);
    expect(live.headers.get("location")).toBe(`https://storage.test/${ORG}/${COMPANY}/doc-1.pdf?ttl=60`);
    expect(live.headers.get("cache-control")).toBe("no-store");
    expect(h.db!.tables.compliance_events.some((e) => e.event === "share_opened" && e.ip === "198.51.100.4")).toBe(true);
    h.db!.tables.compliance_shares[0].status = "revoked";
    const gone = await DOC(new Request("http://x/api"), { params: { token: LINK } });
    expect(gone.status).toBe(410);
    expect(await gone.text()).toContain("Ask Northshore Roofing for a new one.");
    expect((await DOC(new Request("http://x/api"), { params: { token: "x" } })).status).toBe(404);
  });
});
