import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

// The owner's cell is the owner channel's identity: verified-only, changed with a texted code.
const deliverMessage = vi.fn((..._a: unknown[]) => Promise.resolve({ status: "sent", body: "" }));
let db: FakeDb;

vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => db.client }));
vi.mock("@/server/services/workflow-engine/messaging", () => ({
  STOP_FOOTER: "Reply STOP to opt out",
  deliverMessage: (...a: unknown[]) => deliverMessage(...a),
}));

import { findOwnerCompanies, sameOwnerPhone } from "@/server/services/owner-channel/common";
import {
  confirmOwnerPhoneVerification,
  getOwnerPhoneView,
  saveOwnerPhoneUnverified,
  setOwnerPhoneVerified,
  startOwnerPhoneVerification,
} from "@/server/services/owner-channel/owner-phone";
import { handleOwnerInboundSms } from "@/server/services/owner-channel/entry";

const OWNER = "+17055559999";
const NEW_CELL = "+17055551111";

function seed(company: Record<string, unknown> = {}) {
  db = createFakeDb(
    {
      companies: [{ id: "co-1", organization_id: "org-1", name: "Northshore Lawn", timezone: "America/Toronto", owner_phone_e164: OWNER, owner_phone_verified_at: "2026-10-01T00:00:00Z", ...company }],
      organizations: [{ id: "org-1", platform_brand: "crankleads" }],
      owner_phone_verifications: [],
      owner_command_log: [],
      owner_approvals: [],
      platform_sms_opt_outs: [],
    },
    { owner_command_log: [["provider_ref"]] },
  );
}

function sentCode(): string {
  const body = (deliverMessage.mock.calls.at(-1)?.[0] as { body: string }).body;
  return /code to use this phone for owner texts is (\d{6})/.exec(body)?.[1] ?? "";
}

beforeEach(() => {
  deliverMessage.mockClear();
  seed();
});

describe("owner phone identity", () => {
  it("only VERIFIED numbers are owners", async () => {
    expect(await findOwnerCompanies(db.client, OWNER)).toHaveLength(1);
    seed({ owner_phone_verified_at: null });
    expect(await findOwnerCompanies(db.client, OWNER)).toHaveLength(0);
    const res = await handleOwnerInboundSms(db.client, { from: OWNER, to: "+16475550000", body: "Y", media: [], providerRef: "SM1", viaPlatformNumber: true, companyId: null });
    expect(res.handled).toBe(false);
  });

  it("exact E.164; last-10 only for NANP numbers", () => {
    expect(sameOwnerPhone("+17055559999", "+17055559999")).toBe(true);
    expect(sameOwnerPhone("705-555-9999", "+17055559999")).toBe(true);
    expect(sameOwnerPhone("+442079460958", "+12079460958")).toBe(false);
    expect(sameOwnerPhone("+442079460958", "2079460958")).toBe(false);
    expect(sameOwnerPhone("+442079460958", "+44 20 7946 0958")).toBe(true);
  });

  it("a typed number is saved unverified; the code texted to it verifies it", async () => {
    await saveOwnerPhoneUnverified(db.client, { organizationId: "org-1", companyId: "co-1", phone: "(705) 555-1111" });
    expect(db.tables.companies[0]).toMatchObject({ owner_phone_e164: NEW_CELL, owner_phone_verified_at: null });

    const start = await startOwnerPhoneVerification(db.client, { organizationId: "org-1", companyId: "co-1", phone: "705 555 1111", requestedBy: "p-1", platformBrand: "crankleads" });
    expect(start.ok).toBe(true);
    const sent = deliverMessage.mock.calls[0][0] as { to: string; smsFrom: string; body: string };
    expect(sent).toMatchObject({ to: NEW_CELL, smsFrom: "platform" });
    expect(sent.body).toMatch(/^CrankLeads: Your code/);
    expect(JSON.stringify(db.tables.owner_phone_verifications)).not.toContain(sentCode());
    expect((await getOwnerPhoneView(db.client, "org-1", "co-1")).pendingPhone).toBe(NEW_CELL);

    const wrong = await confirmOwnerPhoneVerification(db.client, { organizationId: "org-1", companyId: "co-1", code: "000000" === sentCode() ? "111111" : "000000" });
    expect(wrong).toMatchObject({ ok: false, reason: "wrong_code" });
    const ok = await confirmOwnerPhoneVerification(db.client, { organizationId: "org-1", companyId: "co-1", code: sentCode() });
    expect(ok).toEqual({ ok: true, phone: NEW_CELL });
    expect(db.tables.companies[0].owner_phone_e164).toBe(NEW_CELL);
    expect(db.tables.companies[0].owner_phone_verified_at).toBeTruthy();
    expect(await findOwnerCompanies(db.client, NEW_CELL)).toHaveLength(1);
  });

  it("five wrong codes and the code is dead; an expired code doesn't work", async () => {
    await startOwnerPhoneVerification(db.client, { organizationId: "org-1", companyId: "co-1", phone: NEW_CELL, requestedBy: null, platformBrand: null });
    const right = sentCode();
    const bad = right === "999999" ? "888888" : "999999";
    for (let i = 0; i < 5; i++) await confirmOwnerPhoneVerification(db.client, { organizationId: "org-1", companyId: "co-1", code: bad });
    expect(await confirmOwnerPhoneVerification(db.client, { organizationId: "org-1", companyId: "co-1", code: right })).toMatchObject({ ok: false, reason: "too_many_attempts" });
    expect(db.tables.companies[0].owner_phone_e164).toBe(OWNER);

    const t0 = Date.now();
    await startOwnerPhoneVerification(db.client, { organizationId: "org-1", companyId: "co-1", phone: NEW_CELL, requestedBy: null, platformBrand: null, nowMs: t0 });
    expect(await confirmOwnerPhoneVerification(db.client, { organizationId: "org-1", companyId: "co-1", code: sentCode(), nowMs: t0 + 11 * 60_000 })).toMatchObject({ ok: false, reason: "expired" });
  });

  it("provisioning sets the number verified in one update", async () => {
    seed({ owner_phone_e164: null, owner_phone_verified_at: null });
    await setOwnerPhoneVerified(db.client, { organizationId: "org-1", companyId: "co-1", phone: "705-555-1111" });
    expect(db.tables.companies[0].owner_phone_e164).toBe(NEW_CELL);
    expect(db.tables.companies[0].owner_phone_verified_at).toBeTruthy();
  });

  it("an unverified owner phone gets no approval texts", async () => {
    const { notifyOwnerOfApproval } = await import("@/server/services/owner-channel/notify");
    seed({ owner_phone_verified_at: null });
    db.tables.owner_approvals.push({ id: "a-1", organization_id: "org-1", company_id: "co-1", kind: "callback", summary: "Sam wants a call back.", payload: {}, status: "pending", short_code: 1, notified_at: null, expires_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: new Date().toISOString() });
    const noon = Date.parse("2026-10-07T16:00:00Z");
    db.tables.owner_approvals[0].expires_at = new Date(noon + 3_600_000).toISOString();
    expect((await notifyOwnerOfApproval(db.client, "a-1", { nowMs: noon })).notified).toBe(false);
    expect(deliverMessage).not.toHaveBeenCalled();
  });
});

describe("strangers' texts to the platform number", () => {
  it("keep only 200 characters, and are pruned after 30 days", async () => {
    const { pruneUnknownSenderLog } = await import("@/server/services/owner-channel/notify");
    const res = await handleOwnerInboundSms(db.client, { from: "+14165550000", to: "+16475550000", body: "x".repeat(500), media: [], providerRef: "SMs1", viaPlatformNumber: true, companyId: null });
    expect(res.handled).toBe(false);
    expect(String(db.tables.owner_command_log[0].body)).toHaveLength(200);
    const now = Date.parse("2026-10-09T12:00:00Z");
    db.tables.owner_command_log.push(
      { id: "old-stranger", organization_id: null, from_phone: "+1416", created_at: new Date(now - 31 * 86_400_000).toISOString() },
      { id: "old-owner", organization_id: "org-1", from_phone: OWNER, created_at: new Date(now - 31 * 86_400_000).toISOString() },
    );
    db.tables.owner_command_log[0].created_at = new Date(now - 86_400_000).toISOString();
    await pruneUnknownSenderLog(db.client, now, { force: true });
    expect(db.tables.owner_command_log.map((r) => r.id)).not.toContain("old-stranger");
    expect(db.tables.owner_command_log.map((r) => r.id)).toContain("old-owner");
    expect(db.tables.owner_command_log).toHaveLength(2);
  });
});
