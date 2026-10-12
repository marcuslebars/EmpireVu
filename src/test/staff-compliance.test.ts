/**
 * Compliance (docs/ai-staff.md → "Compliance") against the in-memory fake DB with real services
 * underneath (deliverMessage, sendOwnerSms, notifyOwnerOfApproval, the owner channel's
 * handleOwnerInboundSms / decideApproval, the registry). Only the outside world is faked: Twilio
 * (sendSms), Resend (sendEmail), the Twilio media fetch, the AI reader and the storage bucket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

const sendSms = vi.fn((..._a: unknown[]) => Promise.resolve({ sid: `SM${Math.random().toString(36).slice(2, 8)}` }));
const sendEmail = vi.fn((..._a: unknown[]) => Promise.resolve({ id: "re_1" }));
const runOwnerCommandAgent = vi.fn((..._a: unknown[]) => Promise.resolve({ reply: "agent reply", actions: [], rounds: 1, confirmationId: null }));
vi.mock("@/server/outbound/sms", () => ({ sendSms: (...a: unknown[]) => sendSms(...a) }));
vi.mock("@/server/outbound/email", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: vi.fn(), recordAiUsageSafe: vi.fn() }));
vi.mock("@/server/services/push/activity", () => ({ notifyActivityEvent: vi.fn() }));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({ emitActivityEventAndDispatch: vi.fn(() => Promise.resolve({ activityEvent: {}, workflowEventJob: null })) }));
vi.mock("@/server/services/owner-channel/agent", () => ({ runOwnerCommandAgent: (...a: unknown[]) => runOwnerCommandAgent(...a) }));

import { replyInstruction } from "@/server/services/front-desk/approval-text";
import { decideApproval, expireApproval } from "@/server/services/owner-channel/approvals";
import { handleOwnerInboundSms } from "@/server/services/owner-channel/entry";
import { runOwnerTool, type ToolRunState } from "@/server/services/owner-channel/tools";
import { newTurnEffects } from "@/server/services/sms-agent/tools";
import { activeRolesFor, ownerMediaHandlersFor, roleApprovalExecutor, roleOwnerTools, staffRoles } from "@/server/services/staff/registry";
import { complianceRole } from "@/server/services/staff/compliance";
import { briefingItems } from "@/server/services/staff/compliance/briefing-items";
import { resetComplianceDeps, setComplianceDeps } from "@/server/services/staff/compliance/deps";
import { describeDocument, savedLine } from "@/server/services/staff/compliance/documents";
import { pickHolder, whoseQuestion, type HolderContext } from "@/server/services/staff/compliance/holders";
import { handleComplianceMedia } from "@/server/services/staff/compliance/intake";
import { dueStage, kindFromWords, maskedNumber, mentionsCompliance, namesMatch, stagesCoveredAtSave, statusFor } from "@/server/services/staff/compliance/kinds";
import { fetchComplianceMedia } from "@/server/services/staff/compliance/media";
import { cleanReading, type ComplianceReading, type ReaderInput } from "@/server/services/staff/compliance/reader";
import { createSubUploadUrl, getUploadPageView, kindsToRequest, proposeSubDocsRequest, submitSubUpload, subRequestText } from "@/server/services/staff/compliance/requests";
import { complianceActiveFor, loadComplianceCompany, mergeComplianceSettings, readComplianceSettings } from "@/server/services/staff/compliance/settings";
import { openShare, revokeShares } from "@/server/services/staff/compliance/shares";
import type { ComplianceStorage } from "@/server/services/staff/compliance/storage";
import { sweepExpiry, sweepOrphanUploads, sweepOutbox } from "@/server/services/staff/compliance/sweeps";
import { deleteDocument, fileSettingsUpload, getComplianceView, updateDocument } from "@/server/services/staff/compliance/view";

const TZ = "America/Toronto";
const ORG = "11111111-1111-4111-8111-111111111111";
const CO = "22222222-2222-4222-8222-222222222222";
const HOUSE_ORG = "33333333-3333-4333-8333-333333333333";
const HOUSE_CO = "44444444-4444-4444-8444-444444444444";
const OWNER = "+17055559999";
const HOUSE_OWNER = "+17055558888";
const PLATFORM = "+16475550000";
const BUSINESS_NUMBER = "+17055550111";
const MIKE = "d0000000-0000-4000-8000-000000000001";
const SUB = "5b000000-0000-4000-8000-000000000001";
const SUB_EMAIL_ONLY = "5b000000-0000-4000-8000-000000000002";
const JONES = "c0000000-0000-4000-8000-000000000001";
const SUB_PHONE = "+17055550142";
const JONES_PHONE = "+17055550123";
const HOUR = 3_600_000;
const DAY = 86_400_000;

// Mon Oct 12 2026, 10:00 in Toronto (EDT, UTC-4).
const NOW = Date.parse("2026-10-12T14:00:00Z");
const PHOTO = [{ url: "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1", contentType: "image/jpeg" }];

let db: FakeDb;
let files: Map<string, Uint8Array>;
let reading: ComplianceReading | null;
const read = vi.fn((_input: ReaderInput) => Promise.resolve(reading));
const fetchMedia = vi.fn(() => Promise.resolve([{ bytes: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" }] as Array<{ bytes: Uint8Array; contentType: string }>));

function fakeStorage(): ComplianceStorage {
  return {
    async upload(path, bytes) {
      files.set(path, bytes);
    },
    async download(path) {
      return files.get(path) ?? null;
    },
    async createUploadUrl(path) {
      return { path, token: "upload-token" };
    },
    async exists(path) {
      return files.has(path);
    },
    async signedUrl(path, ttl) {
      return files.has(path) ? `https://storage.test/signed/${path}?ttl=${ttl}` : null;
    },
    async remove(paths) {
      for (const p of paths) files.delete(p);
    },
  };
}

function insurance(over: Partial<ComplianceReading> = {}): ComplianceReading {
  return { isComplianceDocument: true, kind: "liability_insurance", title: null, issuer: "Intact", number: "CGL-554821", holderName: "Northshore Roofing Ltd.", issuedOn: "2026-03-31", expiresOn: "2027-03-31", ...over };
}

function company(over: Record<string, unknown> = {}) {
  return {
    id: CO, organization_id: ORG, name: "Northshore Roofing", brand_from_name: null, timezone: TZ, ai_settings: {}, stage: "active",
    owner_phone_e164: OWNER, owner_phone_verified_at: "2026-10-01T00:00:00Z", owner_email: "dana@northshore.test", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    ...over,
  };
}

function seed(): FakeDb {
  return createFakeDb(
    {
      organizations: [
        { id: ORG, platform_brand: "crankleads", name: "Northshore" },
        { id: HOUSE_ORG, platform_brand: "empirevu", name: "A1 Group" },
      ],
      companies: [company(), company({ id: HOUSE_CO, organization_id: HOUSE_ORG, name: "A1 Marine Care", owner_phone_e164: HOUSE_OWNER })],
      organization_memberships: [
        { organization_id: ORG, profile_id: "p-owner", role: "owner" },
        { organization_id: ORG, profile_id: MIKE, role: "member" },
        { organization_id: HOUSE_ORG, profile_id: "p-house", role: "owner" },
      ],
      profiles: [
        { id: "p-owner", full_name: "Dana Whitfield", email: "dana@northshore.test" },
        { id: MIKE, full_name: "Mike Dunn", email: "mike@northshore.test" },
        { id: "p-house", full_name: "Al Marine", email: "al@a1.test" },
      ],
      subcontractors: [
        { id: SUB, organization_id: ORG, company_id: CO, name: "Mike Rossi", business_name: "Mike's Electric", trade: "electrician", phone_e164: SUB_PHONE, email: null, notes: null, active: true, created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-01T00:00:00Z" },
        { id: SUB_EMAIL_ONLY, organization_id: ORG, company_id: CO, name: null, business_name: "Bay Plumbing", trade: "plumber", phone_e164: null, email: "office@bayplumbing.test", notes: null, active: true, created_at: "2026-05-02T00:00:00Z", updated_at: "2026-05-02T00:00:00Z" },
      ],
      contacts: [{ id: JONES, organization_id: ORG, company_id: CO, first_name: "Dana", last_name: "Jones", phone: JONES_PHONE, email: null, sms_opt_out_at: null, email_opt_out_at: null, sms_consent_at: "2026-10-12T13:00:00Z", consent_source: "inquiry", notes: null, metadata: {} }],
      voice_numbers: [{ organization_id: ORG, company_id: CO, provider: "twilio", active: true, phone_e164: BUSINESS_NUMBER, mode: "missed_call_catcher" }],
      compliance_documents: [],
      compliance_upload_requests: [],
      compliance_shares: [],
      compliance_events: [],
      compliance_uploads: [],
      owner_approvals: [],
      owner_command_log: [],
      message_log: [],
      sms_conversations: [],
      platform_sms_opt_outs: [],
    },
    { owner_command_log: [["provider_ref"]], compliance_upload_requests: [["approval_id"]], compliance_shares: [["approval_id"]] },
  );
}

const rows = (table: string) => db.tables[table] as Array<Record<string, unknown>>;
const smsTo = (to: string) => sendSms.mock.calls.map((c) => c[0] as { to: string; body: string; from?: string }).filter((m) => m.to === to);
const ownerTexts = () => smsTo(OWNER).map((m) => m.body);
const scope = { organizationId: ORG, companyId: CO };

function mediaInput(body: string, logId = "log-1", over: Record<string, unknown> = {}) {
  return { scope: { organizationId: ORG, companyId: CO, companyName: "Northshore Roofing", timeZone: TZ }, ownerPhone: OWNER, body, media: PHOTO, logId, nowMs: Date.now(), ...over };
}

function ownerState(): ToolRunState {
  return { admin: db.client, scope: { organizationId: ORG, companyId: CO, companyName: "Northshore Roofing", timeZone: TZ }, ownerPhone: OWNER, nowMs: Date.now(), confirmation: null, actions: [] };
}

/** A filed document straight into the table. */
function doc(over: Record<string, unknown>) {
  const row = {
    id: `doc-${Math.random().toString(36).slice(2, 8)}`,
    organization_id: ORG,
    company_id: CO,
    kind: "liability_insurance",
    title: null,
    holder_type: "company",
    profile_id: null,
    subcontractor_id: null,
    holder_name: null,
    issuer: "Intact",
    number: null,
    issued_on: null,
    expires_on: "2027-03-31",
    file_path: `${ORG}/${CO}/doc-seed.jpg`,
    file_content_type: "image/jpeg",
    notes: null,
    uploaded_via: "sms",
    uploaded_by: null,
    status: "current",
    replaced_by: null,
    source_key: null,
    upload_request_id: null,
    ai_read: null,
    intake_reply: null,
    reminded_30_at: null,
    reminded_7_at: null,
    reminded_0_at: null,
    owner_notified_at: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...over,
  };
  rows("compliance_documents").push(row);
  files.set(String(row.file_path), new Uint8Array([9]));
  return row;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.PLATFORM_SMS_NUMBER = PLATFORM;
  process.env.CRANKLEADS_APP_BASE_URL = "https://app.crankleads.test";
  sendSms.mockClear();
  sendEmail.mockClear();
  runOwnerCommandAgent.mockClear();
  read.mockClear();
  fetchMedia.mockClear();
  files = new Map();
  reading = insurance();
  db = seed();
  setComplianceDeps({ read, fetchMedia, storage: () => fakeStorage() });
});

afterEach(() => {
  vi.useRealTimers();
  resetComplianceDeps();
});

// ── Pure parts ───────────────────────────────────────────────────────────────────────

describe("words, dates and lines", () => {
  it("knows compliance words (the ones the tax clerk passes on) and what they point to", () => {
    for (const w of ["our insurance", "COI for the Smith job", "WSIB clearance", "new licence", "license renewal", "permit", "working at heights ticket", "cert", "the policy"]) expect(mentionsCompliance(w)).toBe(true);
    for (const w of ["", "Home Depot for the Jones job", "fuel", "PO-12"]) expect(mentionsCompliance(w)).toBe(false);
    expect(kindFromWords("WSIB clearance for Mike's")).toBe("wsib_clearance");
    expect(kindFromWords("our WSIB account letter")).toBe("wsib_account");
    expect(kindFromWords("truck insurance")).toBe("vehicle_insurance");
    expect(kindFromWords("our liability insurance")).toBe("liability_insurance");
    expect(kindFromWords("Mike's 309A")).toBe("trade_licence");
    expect(kindFromWords("first aid ticket")).toBe("certification");
  });

  it("statuses, reminder stages and stages already covered at save", () => {
    expect(statusFor("2027-03-31", "2026-10-12")).toBe("current");
    expect(statusFor("2026-11-11", "2026-10-12")).toBe("expiring");
    expect(statusFor("2026-10-11", "2026-10-12")).toBe("expired");
    expect(statusFor(null, "2026-10-12")).toBe("current");
    expect(dueStage("2026-11-11", "2026-10-12")).toBe(30);
    expect(dueStage("2026-10-19", "2026-10-12")).toBe(7);
    expect(dueStage("2026-10-12", "2026-10-12")).toBe(0);
    expect(dueStage("2026-10-10", "2026-10-12")).toBe(0);
    expect(dueStage("2026-10-09", "2026-10-12")).toBeNull();
    expect(dueStage("2026-12-31", "2026-10-12")).toBeNull();
    expect(stagesCoveredAtSave("2026-10-30", "2026-10-12")).toEqual([30]);
    expect(stagesCoveredAtSave("2026-10-15", "2026-10-12")).toEqual([30, 7]);
    expect(stagesCoveredAtSave("2027-03-31", "2026-10-12")).toEqual([]);
  });

  it("the owner's saved line (the brief's wording) never shows the whole policy number", () => {
    expect(maskedNumber("liability_insurance", "CGL-554821")).toBe("policy ...4821");
    expect(maskedNumber("wsib_clearance", "C123456789")).toBe("#...6789");
    expect(savedLine({ kind: "liability_insurance", issuer: "Intact", number: "CGL-554821", expiresOn: "2027-03-31", holderLabel: "you", today: "2026-10-12", reminders: true })).toBe(
      "Saved: liability insurance (Intact, policy ...4821), expires Mar 31, 2027. I'll remind you 30 days before.",
    );
    expect(savedLine({ kind: "wsib_clearance", issuer: "WSIB", expiresOn: "2026-10-18", holderLabel: "Mike's Electric", today: "2026-10-12", reminders: true })).toBe(
      "Saved: Mike's Electric's WSIB clearance (WSIB), expires Oct 18, 2026. I'll remind you on the day.",
    );
    expect(savedLine({ kind: "liability_insurance", expiresOn: "2026-09-30", holderLabel: "you", today: "2026-10-12", reminders: true })).toContain("but it expired Sep 30, 2026");
    expect(savedLine({ kind: "bond", expiresOn: null, holderLabel: "you", today: "2026-10-12", reminders: true })).toContain("I couldn't see an expiry date");
    expect(describeDocument({ kind: "certification", title: "Working at Heights" }, "Mike")).toBe("Mike's Working at Heights");
  });

  it("the reader's answer is checked: kinds, real dates, plain strings; a non-document reads as nothing", () => {
    expect(cleanReading({ is_compliance_document: true, kind: "made_up", issuer: "<b>Intact</b>", number: "  ", holder_name: "Northshore", issued_on: "2026-02-30", expires_on: "2027-03-31" })).toEqual({
      isComplianceDocument: true, kind: "other", title: null, issuer: "b Intact /b", number: null, holderName: "Northshore", issuedOn: null, expiresOn: "2027-03-31",
    });
    expect(cleanReading({ is_compliance_document: false, kind: "liability_insurance", issuer: "Home Depot" })).toMatchObject({ isComplianceDocument: false, kind: null, issuer: null });
    expect(cleanReading("nope")).toBeNull();
  });

  it("whose is it: words first, then the printed name, then the kind; unclear → ask", () => {
    const ctx: HolderContext = {
      companyNames: ["Northshore Roofing"],
      crew: [
        { profileId: "p-owner", name: "Dana Whitfield", role: "owner" },
        { profileId: MIKE, name: "Mike Dunn", role: "member" },
      ],
      subs: [{ id: SUB, business_name: "Mike's Electric", name: "Mike Rossi", active: true } as never],
    };
    expect(pickHolder({ words: "Mike's Electric's clearance", holderName: null, kind: "wsib_clearance" }, ctx).holder).toMatchObject({ type: "subcontractor", subcontractorId: SUB });
    expect(pickHolder({ words: "Mike's first aid", holderName: null, kind: "certification" }, ctx).holder).toMatchObject({ type: "crew", profileId: MIKE, label: "Mike" });
    expect(pickHolder({ words: "our insurance", holderName: "Someone Else Inc", kind: "liability_insurance" }, ctx).holder).toMatchObject({ type: "company" });
    expect(pickHolder({ words: "", holderName: "NORTHSHORE ROOFING LTD.", kind: "liability_insurance" }, ctx).holder).toMatchObject({ type: "company" });
    expect(pickHolder({ words: "", holderName: null, kind: "vehicle_insurance" }, ctx).holder).toMatchObject({ type: "company" });
    expect(pickHolder({ words: "", holderName: "Jordan Tremblay", kind: "certification" }, ctx)).toMatchObject({ holder: null, reason: "unclear" });
    expect(pickHolder({ words: "for a sub", holderName: null, kind: "wsib_clearance" }, ctx)).toMatchObject({ holder: null, reason: "unknown_sub", candidates: ["Mike's Electric"] });
    expect(whoseQuestion(ctx, null)).toBe("Is this for you, Mike (crew) or a sub?");
    expect(namesMatch("Mike's Electric Ltd", "mikes electric")).toBe(false);
    expect(namesMatch("Mike's Electric Ltd", "Mike's Electric")).toBe(true);
  });

  it("what a sub is asked for, and the exact text", () => {
    expect(kindsToRequest("wsib_clearance", [{ kind: "liability_insurance", status: "current", expires_on: "2027-06-01" }], "2026-10-12")).toEqual(["wsib_clearance"]);
    expect(kindsToRequest("wsib_clearance", [], "2026-10-12")).toEqual(["wsib_clearance", "liability_insurance"]);
    expect(
      subRequestText({ businessName: "Northshore Roofing", sub: { name: "Mike Rossi", business_name: "Mike's Electric" }, kinds: ["wsib_clearance", "liability_insurance"], trigger: { kind: "wsib_clearance", title: null, expires_on: "2026-10-16" }, today: "2026-10-12", link: "LINK" }),
    ).toBe("Hi Mike, it's Northshore Roofing. Your WSIB clearance on file with us expires Fri. Please upload a new WSIB clearance and your liability insurance here: LINK (the link works for 14 days). Thanks!");
  });

  it("approval reply lines", () => {
    expect(replyInstruction("request_sub_docs", 12, { channel: "sms" })).toBe("Reply Y 12 to text them the link, N 12 to skip.");
    expect(replyInstruction("request_sub_docs", 12, { channel: "email" })).toBe("Reply Y 12 to email them the link, N 12 to skip.");
    expect(replyInstruction("share_compliance_doc", 3)).toBe("Reply Y 3 to send it, N 3 to skip.");
  });
});

// ── Settings + registry ──────────────────────────────────────────────────────────────

describe("settings and registry", () => {
  it("on for CrankLeads (passive until documents exist), off for house orgs unless switched on", async () => {
    expect(readComplianceSettings({}, { crankleads: true })).toMatchObject({ enabled: true, reminders: true, sharing: true, enabledIsDefault: true });
    expect(readComplianceSettings({}, { crankleads: false }).enabled).toBe(false);
    expect(readComplianceSettings({ compliance: { enabled: true, sharing: false } }, { crankleads: false })).toMatchObject({ enabled: true, sharing: false });
    expect(mergeComplianceSettings({ sms_agent: { enabled: true }, compliance: { reminders: false } }, { enabled: false })).toEqual({ sms_agent: { enabled: true }, compliance: { reminders: false, enabled: false } });
    expect(await complianceActiveFor(db.client, scope)).toBe(true);
    expect(await complianceActiveFor(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO })).toBe(false);
    expect(await complianceActiveFor(db.client, { organizationId: HOUSE_ORG, companyId: CO })).toBe(false);
  });

  it("is in the registry after purchasing's slot order (tax clerk first), with its kinds, tools and sweeps", async () => {
    const order = staffRoles().map((r) => r.role);
    expect(order.indexOf("tax_clerk")).toBeLessThan(order.indexOf("compliance"));
    expect(order.indexOf("compliance")).toBeLessThan(order.indexOf("purchasing"));
    expect(roleApprovalExecutor("request_sub_docs")).toBeTypeOf("function");
    expect(roleApprovalExecutor("share_compliance_doc")).toBeTypeOf("function");
    expect(roleOwnerTools().map((t) => t.tool.name)).toEqual(expect.arrayContaining(["compliance_status", "file_compliance_doc", "ask_sub_for_docs", "add_subcontractor", "stop_sharing"]));
    expect(complianceRole.agentTools.map((t) => t.name)).toEqual(["share_compliance_doc"]);
    expect(complianceRole.sweeps.map((s) => s.name)).toEqual(["compliance:expiry", "compliance:outbox", "compliance:orphans"]);
    expect((await activeRolesFor(db.client, scope)).map((r) => r.role)).toContain("compliance");
    expect((await activeRolesFor(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO })).map((r) => r.role)).not.toContain("compliance");
    expect((await ownerMediaHandlersFor(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO })).map((h) => h.role)).not.toContain("compliance");
    expect((await ownerMediaHandlersFor(db.client, scope)).map((h) => h.role)).toContain("compliance");
  });
});

// ── Intake (ownerMedia) ──────────────────────────────────────────────────────────────

describe("texted certificates (ownerMedia handler on its own)", () => {
  it("words + reading: saved under the business, file stored privately, the brief's reply", async () => {
    const out = await handleComplianceMedia(db.client, mediaInput("here's our insurance"));
    expect(out?.reply).toBe("Saved: liability insurance (Intact, policy ...4821), expires Mar 31, 2027. I'll remind you 30 days before.");
    expect(out?.intent).toBe("compliance_doc");
    const saved = rows("compliance_documents")[0];
    expect(saved).toMatchObject({ kind: "liability_insurance", holder_type: "company", issuer: "Intact", number: "CGL-554821", expires_on: "2027-03-31", status: "current", uploaded_via: "sms", source_key: "sms:log-1", uploaded_by: `owner_sms:${OWNER}` });
    expect(String(saved.file_path)).toMatch(new RegExp(`^${ORG}/${CO}/doc-[0-9a-f-]+\\.jpg$`));
    expect(files.has(String(saved.file_path))).toBe(true);
    expect(read.mock.calls[0][0]).toMatchObject({ contentType: "image/jpeg", today: "2026-10-12", scope: expect.objectContaining({ companyId: CO }) });
  });

  it("no words: claimed only when the reader says it's a compliance document", async () => {
    reading = { ...insurance(), isComplianceDocument: false, kind: null };
    expect(await handleComplianceMedia(db.client, mediaInput(""))).toBeNull();
    reading = null; // no model / unreadable
    expect(await handleComplianceMedia(db.client, mediaInput("", "log-2"))).toBeNull();
    reading = insurance();
    expect((await handleComplianceMedia(db.client, mediaInput("", "log-3")))?.reply).toContain("Saved: liability insurance");
    expect(rows("compliance_documents")).toHaveLength(1);
  });

  it("words but the reader clearly says it isn't one (a parking ticket): passes", async () => {
    reading = { ...insurance(), isComplianceDocument: false, kind: null };
    expect(await handleComplianceMedia(db.client, mediaInput("got a ticket downtown"))).toBeNull();
    expect(rows("compliance_documents")).toHaveLength(0);
  });

  it("words but no reading (no model): still saved from the words, asks for the expiry", async () => {
    reading = null;
    const out = await handleComplianceMedia(db.client, mediaInput("our WSIB clearance"));
    expect(out?.reply).toBe(`Saved: WSIB clearance. I couldn't see an expiry date - text me "expires" and the date if it has one.`);
    expect(rows("compliance_documents")[0]).toMatchObject({ kind: "wsib_clearance", holder_type: "company", expires_on: null, ai_read: null });
  });

  it("media that won't download: words → a plain reply; no words → pass", async () => {
    fetchMedia.mockResolvedValueOnce([]);
    expect((await handleComplianceMedia(db.client, mediaInput("insurance")))?.reply).toContain("couldn't open that file");
    fetchMedia.mockResolvedValueOnce([]);
    expect(await handleComplianceMedia(db.client, mediaInput("", "log-2"))).toBeNull();
  });

  it("unclear whose: kept pending and the owner is asked; file_compliance_doc takes the answer (a new sub)", async () => {
    reading = insurance({ kind: "certification", title: "Working at Heights", issuer: "IHSA", number: null, holderName: "Jordan Tremblay", expiresOn: "2028-03-03" });
    const out = await handleComplianceMedia(db.client, mediaInput(""));
    expect(out?.reply).toBe('Got it: Working at Heights (IHSA), expires Mar 3, 2028. Is this for you, Mike (crew) or a sub? It says "Jordan Tremblay".');
    expect(rows("compliance_documents")[0]).toMatchObject({ status: "pending", holder_type: null });
    // "it's my new sub, Tremblay Roofing" → the owner agent calls file_compliance_doc
    const missing = await runOwnerTool(ownerState(), "file_compliance_doc", { holder: "sub", name: "Tremblay Roofing" });
    expect(missing.error).toContain("No sub called Tremblay Roofing");
    const filed = await runOwnerTool(ownerState(), "file_compliance_doc", { holder: "sub", name: "Tremblay Roofing", new_sub: true });
    expect(filed.tell_owner).toBe("Saved: Tremblay Roofing's Working at Heights (IHSA), expires Mar 3, 2028. I'll remind you 30 days before.");
    const sub = rows("subcontractors").find((s) => s.business_name === "Tremblay Roofing");
    expect(rows("compliance_documents")[0]).toMatchObject({ status: "current", holder_type: "subcontractor", subcontractor_id: sub?.id });
  });

  it("crew answer, and a later fix to the expiry", async () => {
    reading = insurance({ kind: "certification", title: "First Aid", issuer: "Red Cross", number: null, holderName: null, expiresOn: null });
    await handleComplianceMedia(db.client, mediaInput(""));
    const out = await runOwnerTool(ownerState(), "file_compliance_doc", { holder: "crew", name: "Mike" });
    expect(out.tell_owner).toContain("Saved: Mike's First Aid (Red Cross).");
    const fixed = await runOwnerTool(ownerState(), "file_compliance_doc", { expires_on: "2029-05-01" });
    expect(fixed.tell_owner).toBe("Saved: Mike's First Aid (Red Cross), expires May 1, 2029. I'll remind you 30 days before.");
    expect(rows("compliance_documents")[0]).toMatchObject({ holder_type: "crew", profile_id: MIKE, expires_on: "2029-05-01", status: "current" });
  });

  it("a newer one replaces the old one of the same kind and holder; an older-dated one never knocks out a newer", async () => {
    const old = doc({ expires_on: "2026-11-01", status: "expiring" });
    const out = await handleComplianceMedia(db.client, mediaInput("new insurance"));
    expect(out?.reply).toContain("It replaces the old one.");
    expect(old).toMatchObject({ status: "replaced", replaced_by: rows("compliance_documents")[1].id });
    reading = insurance({ expiresOn: "2026-12-31" });
    await handleComplianceMedia(db.client, mediaInput("old insurance", "log-9"));
    expect(rows("compliance_documents")[1].status).toBe("current");
  });

  it("idempotent on the owner_command_log id: a redelivered text files nothing new", async () => {
    const first = await handleComplianceMedia(db.client, mediaInput("insurance"));
    const again = await handleComplianceMedia(db.client, mediaInput("insurance"));
    expect(again?.reply).toBe(first?.reply);
    expect(rows("compliance_documents")).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("house org / switched off: never claims", async () => {
    expect(await handleComplianceMedia(db.client, mediaInput("insurance", "log-1", { scope: { organizationId: HOUSE_ORG, companyId: HOUSE_CO, companyName: "A1 Marine Care", timeZone: TZ } }))).toBeNull();
    (rows("companies")[0] as Record<string, unknown>).ai_settings = { compliance: { enabled: false } };
    expect(await handleComplianceMedia(db.client, mediaInput("insurance"))).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("the handler never throws", async () => {
    read.mockRejectedValueOnce(new Error("boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await complianceRole.ownerMedia!.run(db.client, mediaInput("insurance"))).toBeNull();
    err.mockRestore();
  });
});

describe("texted certificates through handleOwnerInboundSms", () => {
  let sid = 0;
  const text = (from: string, body: string, media = PHOTO) => handleOwnerInboundSms(db.client, { from, to: PLATFORM, body, media, providerRef: `SMx${++sid}`, viaPlatformNumber: true, companyId: null });

  it("CrankLeads owner: the photo is filed and the reply goes back from the platform number", async () => {
    await text(OWNER, "our liability insurance");
    expect(ownerTexts().at(-1)).toContain("Saved: liability insurance (Intact, policy ...4821), expires Mar 31, 2027.");
    expect(smsTo(OWNER).at(-1)?.from).toBe(PLATFORM);
    expect(rows("owner_command_log").at(-1)).toMatchObject({ intent: "compliance_doc" });
    expect(rows("compliance_documents")).toHaveLength(1);
    expect(rows("compliance_documents")[0].source_key).toBe(`sms:${rows("owner_command_log").at(-1)?.id}`);
    expect(runOwnerCommandAgent).not.toHaveBeenCalled();
  });

  it("a bare photo the reader can't place still gets the old reply", async () => {
    reading = null;
    await text(OWNER, "");
    expect(ownerTexts().at(-1)).toContain("Got the picture");
    expect(rows("compliance_documents")).toHaveLength(0);
  });

  it("A1 Marine Care (house org): exactly as before — no reader, the old reply, words go to the agent", async () => {
    await text(HOUSE_OWNER, "");
    expect(smsTo(HOUSE_OWNER).at(-1)?.body).toContain("Got the picture");
    await text(HOUSE_OWNER, "here's our insurance");
    expect(runOwnerCommandAgent).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(rows("compliance_documents")).toHaveLength(0);
  });

  it("an approval reply with a photo stays an approval", async () => {
    await text(OWNER, "Y 12");
    expect(read).not.toHaveBeenCalled();
  });
});

// ── The expiry chase ─────────────────────────────────────────────────────────────────

describe("the expiry chase", () => {
  it("30 days, 7 days and the day: one text per document per stage, several share one text", async () => {
    doc({ id: "d30", expires_on: "2026-11-11" });
    doc({ id: "d7", kind: "vehicle_insurance", issuer: "Aviva", expires_on: "2026-10-19" });
    doc({ id: "dcrew", kind: "certification", title: "Working at Heights", holder_type: "crew", profile_id: MIKE, expires_on: "2026-10-12" });
    await sweepExpiry(db.client, NOW);
    expect(ownerTexts()).toEqual([
      "CrankLeads: Heads up: Mike's Working at Heights expires today; Vehicle insurance expires in 7 days; Liability insurance expires in 30 days. Text me a photo of the new one when you have it.",
    ]);
    const byId = (id: string) => rows("compliance_documents").find((d) => d.id === id)!;
    expect(byId("d30")).toMatchObject({ status: "expiring", reminded_30_at: expect.any(String) });
    expect(byId("d7").reminded_7_at).toBeTruthy();
    expect(byId("dcrew").reminded_0_at).toBeTruthy();
    await sweepExpiry(db.client, NOW + HOUR);
    expect(ownerTexts()).toHaveLength(1);
    // Three weeks later the 30-day one reaches its 7-day stage.
    await sweepExpiry(db.client, NOW + 23 * DAY);
    expect(ownerTexts().at(-1)).toContain("Liability insurance expires in 7 days");
    // The day after expiry: status expired, no second on-the-day text.
    await sweepExpiry(db.client, NOW + DAY);
    expect(byId("dcrew").status).toBe("expired");
  });

  it("outside 09:00-20:00, reminders off, no verified cell, house org: no text", async () => {
    doc({ expires_on: "2026-10-19" });
    await sweepExpiry(db.client, Date.parse("2026-10-12T11:00:00Z")); // 7am
    expect(ownerTexts()).toHaveLength(0);
    (rows("companies")[0] as Record<string, unknown>).ai_settings = { compliance: { reminders: false } };
    await sweepExpiry(db.client, NOW);
    expect(ownerTexts()).toHaveLength(0);
    expect(rows("compliance_documents")[0].reminded_7_at).toBeNull();
  });

  it("a failed text gives the stage back for the next pass", async () => {
    doc({ expires_on: "2026-10-19" });
    sendSms.mockRejectedValueOnce(new Error("twilio down"));
    await sweepExpiry(db.client, NOW);
    expect(rows("compliance_documents")[0].reminded_7_at).toBeNull();
    await sweepExpiry(db.client, NOW + 15 * 60_000);
    expect(ownerTexts().at(-1)).toContain("expires in 7 days");
  });

  it("a sub's clearance 7 days out becomes a request_sub_docs approval (the brief's text)", async () => {
    doc({ id: "dsub", kind: "wsib_clearance", issuer: "WSIB", holder_type: "subcontractor", subcontractor_id: SUB, expires_on: "2026-10-16" });
    await sweepExpiry(db.client, NOW);
    const approval = rows("owner_approvals")[0];
    expect(approval).toMatchObject({ kind: "request_sub_docs", requested_by: "compliance", status: "pending" });
    expect(approval.summary).toBe(
      `Mike's Electric's WSIB clearance expires Fri. Y texts Mike a link to upload a new clearance + insurance. They'd get: "Hi Mike, it's Northshore Roofing. Your WSIB clearance on file with us expires Fri. Please upload a new WSIB clearance and your liability insurance here: [upload link] (the link works for 14 days). Thanks!"`,
    );
    expect(ownerTexts().at(-1)).toContain("Reply Y");
    expect(ownerTexts().filter((t) => t.includes("Heads up"))).toHaveLength(0);
    await sweepExpiry(db.client, NOW + 3 * DAY);
    expect(rows("owner_approvals")).toHaveLength(1);
  });
});

// ── request_sub_docs end to end ──────────────────────────────────────────────────────

describe("request_sub_docs through decideApproval", () => {
  async function ask() {
    const c = (await loadComplianceCompany(db.client, scope))!;
    const trigger = doc({ id: "dsub", kind: "wsib_clearance", issuer: "WSIB", holder_type: "subcontractor", subcontractor_id: SUB, expires_on: "2026-10-16", status: "expiring" });
    const res = await proposeSubDocsRequest(db.client, c, SUB, { documentId: trigger.id, nowMs: Date.now() });
    expect(res.ok).toBe(true);
    return String(res.approvalId);
  }

  it("Y: a 14-day link texted from the business number; the sub uploads; the owner is told; idempotent", async () => {
    const id = await ask();
    const out = await decideApproval(db.client, id, { approved: true, decidedVia: "sms", decidedBy: OWNER }, { organizationId: ORG });
    expect(out.result?.message).toBe("Texted Mike (Mike's Electric) a link to upload a new clearance + insurance (works 14 days). I'll tell you when they send it.");
    const req = rows("compliance_upload_requests")[0];
    expect(req).toMatchObject({ status: "sent", channel: "sms", subcontractor_id: SUB, kinds: ["wsib_clearance", "liability_insurance"] });
    expect(Date.parse(String(req.expires_at)) - NOW).toBe(14 * DAY);
    const sent = smsTo(SUB_PHONE);
    expect(sent).toHaveLength(1);
    expect(sent[0].from).toBe(BUSINESS_NUMBER);
    expect(sent[0].body).toBe(`Hi Mike, it's Northshore Roofing. Your WSIB clearance on file with us expires Fri. Please upload a new WSIB clearance and your liability insurance here: https://app.crankleads.test/compliance/upload/${req.token} (the link works for 14 days). Thanks!`);
    expect(rows("message_log").some((m) => m.sent_by === "compliance" && m.to_addr === SUB_PHONE)).toBe(true);

    // Twice → "already", nothing sent again.
    const again = await decideApproval(db.client, id, { approved: true, decidedVia: "sms", decidedBy: OWNER });
    expect(again.outcome).toBe("already");
    expect(smsTo(SUB_PHONE)).toHaveLength(1);

    // The sub's page.
    const token = String(req.token);
    const view = await getUploadPageView(db.client, token);
    expect(view).toMatchObject({ businessName: "Northshore Roofing", subName: "Mike's Electric", asked: [{ kind: "wsib_clearance", label: "WSIB clearance" }, { kind: "liability_insurance", label: "Liability insurance" }], canUpload: true });
    const upload = await createSubUploadUrl(db.client, token, "image/jpeg");
    expect(upload?.path).toMatch(new RegExp(`^${ORG}/${CO}/sub-${req.id}-[0-9a-f-]+\\.jpg$`));
    files.set(upload!.path, new Uint8Array([7]));
    reading = insurance({ kind: "wsib_clearance", issuer: "WSIB", number: "C998877", holderName: "Mike's Electric", expiresOn: "2027-01-09" });
    const submitted = await submitSubUpload(db.client, token, { path: upload!.path, contentType: "image/jpeg", kind: "wsib_clearance" }, { ip: "203.0.113.9", userAgent: "Mobile Safari" });
    expect(submitted?.result).toEqual({ label: "WSIB clearance", expiresOn: "2027-01-09", read: true });
    const filed = rows("compliance_documents").find((d) => d.uploaded_via === "sub_link")!;
    expect(filed).toMatchObject({ holder_type: "subcontractor", subcontractor_id: SUB, kind: "wsib_clearance", upload_request_id: req.id, owner_notified_at: expect.any(String) });
    expect(rows("compliance_documents").find((d) => d.id === "dsub")).toMatchObject({ status: "replaced", replaced_by: filed.id });
    expect(ownerTexts().at(-1)).toBe("CrankLeads: Mike's Electric sent a new WSIB clearance (expires Jan 9, 2027).");
    expect(rows("compliance_events").some((e) => e.event === "sub_upload" && e.ip === "203.0.113.9")).toBe(true);
    expect(rows("compliance_upload_requests")[0].uploads).toBe(1);
  });

  it("the link: a path outside its folder is refused; it dies after 14 days", async () => {
    const id = await ask();
    await decideApproval(db.client, id, { approved: true, decidedVia: "sms", decidedBy: OWNER });
    const token = String(rows("compliance_upload_requests")[0].token);
    files.set(`${ORG}/${CO}/doc-x.jpg`, new Uint8Array([1]));
    await expect(submitSubUpload(db.client, token, { path: `${ORG}/${CO}/doc-x.jpg`, contentType: "image/jpeg" }, { ip: null, userAgent: null })).rejects.toThrow("Upload the file again");
    await expect(submitSubUpload(db.client, token, { path: `${ORG}/${CO}/sub-${rows("compliance_upload_requests")[0].id}-missing.jpg`, contentType: "image/jpeg" }, { ip: null, userAgent: null })).rejects.toThrow("didn't finish uploading");
    expect(await getUploadPageView(db.client, token, NOW + 14 * DAY + 1)).toBeNull();
    expect(await getUploadPageView(db.client, "not-a-real-token-but-long-enough-xxxxxxxx")).toBeNull();
  });

  it("an upload overnight: the owner hears in the morning (outbox sweep)", async () => {
    const id = await ask();
    await decideApproval(db.client, id, { approved: true, decidedVia: "sms", decidedBy: OWNER });
    const req = rows("compliance_upload_requests")[0];
    const night = Date.parse("2026-10-13T03:00:00Z"); // 11pm
    vi.setSystemTime(night);
    const upload = await createSubUploadUrl(db.client, String(req.token), "application/pdf", night);
    files.set(upload!.path, new Uint8Array([7]));
    reading = insurance({ kind: "wsib_clearance", issuer: "WSIB", holderName: "Somebody Else", expiresOn: "2027-01-09" });
    const before = ownerTexts().length;
    await submitSubUpload(db.client, String(req.token), { path: upload!.path, contentType: "application/pdf" }, { ip: null, userAgent: null }, night);
    expect(ownerTexts()).toHaveLength(before);
    await sweepOutbox(db.client, Date.parse("2026-10-13T12:30:00Z")); // 8:30am
    expect(ownerTexts().at(-1)).toBe(`CrankLeads: Mike's Electric sent a new WSIB clearance (expires Jan 9, 2027). The name on it is "Somebody Else" - check it's theirs.`);
  });

  it("decided late: queued, then the outbox sends it at 9am", async () => {
    const id = await ask();
    const late = Date.parse("2026-10-13T01:30:00Z"); // 9:30pm
    vi.setSystemTime(late);
    const out = await decideApproval(db.client, id, { approved: true, decidedVia: "sms", decidedBy: OWNER });
    expect(out.result?.message).toBe("It's late, so I'll text Mike (Mike's Electric) the upload link at 9am tomorrow.");
    expect(smsTo(SUB_PHONE)).toHaveLength(0);
    await sweepOutbox(db.client, Date.parse("2026-10-13T12:00:00Z")); // 8am
    expect(smsTo(SUB_PHONE)).toHaveLength(0);
    await sweepOutbox(db.client, Date.parse("2026-10-13T13:01:00Z")); // 9:01am
    expect(smsTo(SUB_PHONE)).toHaveLength(1);
    await sweepOutbox(db.client, Date.parse("2026-10-13T13:05:00Z"));
    expect(smsTo(SUB_PHONE)).toHaveLength(1);
  });

  it("the channel shown to the owner is locked: a sub who opts out after the ask gets nothing (no switch to email)", async () => {
    (rows("subcontractors")[0] as Record<string, unknown>).email = "mike@electric.test";
    const id = await ask();
    expect(rows("owner_approvals")[0].payload).toMatchObject({ channel: "sms" });
    rows("contacts").push({ id: "c-mike", organization_id: ORG, company_id: CO, first_name: "Mike", phone: SUB_PHONE, sms_opt_out_at: "2026-09-01T00:00:00Z" });
    const out = await decideApproval(db.client, id, { approved: true, decidedVia: "sms", decidedBy: OWNER });
    expect(out.result?.message).toBe(`Nothing sent: I was going to text Mike's Electric, but Mike's Electric has opted out of texts from you. Text me "ask Mike's Electric for documents" to try again.`);
    expect(smsTo(SUB_PHONE)).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(rows("compliance_upload_requests")).toHaveLength(0);
  });

  it("an opted-out sub with no email: nothing is asked; the owner is told why", async () => {
    rows("contacts").push({ id: "c-mike", organization_id: ORG, company_id: CO, first_name: "Mike", phone: SUB_PHONE, sms_opt_out_at: "2026-09-01T00:00:00Z" });
    const out = await runOwnerTool(ownerState(), "ask_sub_for_docs", { sub: "Mike's Electric" });
    expect(out.error).toBe("Mike's Electric has opted out of texts from you and there's no email for Mike's Electric, so I can't send them a link. Add their email (or cell) in Settings > AI front desk > Compliance.");
    expect(rows("owner_approvals")).toHaveLength(0);
  });

  it("N and expiry: nothing sent", async () => {
    const id = await ask();
    const no = await decideApproval(db.client, id, { approved: false, decidedVia: "sms", decidedBy: OWNER });
    expect(no.result?.message).toBe("OK - I won't ask Mike's Electric.");
    const c = (await loadComplianceCompany(db.client, scope))!;
    const second = await proposeSubDocsRequest(db.client, c, SUB, { nowMs: Date.now() });
    vi.setSystemTime(NOW + 4 * DAY);
    await expireApproval(db.client, rows("owner_approvals").find((a) => a.id === second.approvalId) as never, NOW + 4 * DAY);
    expect(rows("owner_approvals").find((a) => a.id === second.approvalId)?.status).toBe("expired");
    expect(smsTo(SUB_PHONE)).toHaveLength(0);
    expect(rows("compliance_upload_requests")).toHaveLength(0);
  });

  it("owner tool ask_sub_for_docs: inline question; an email-only sub gets an email link", async () => {
    const out = await runOwnerTool(ownerState(), "ask_sub_for_docs", { sub: "Bay Plumbing" });
    expect(out.tell_owner_exactly).toMatch(/^#\d+ Ask Bay Plumbing for WSIB clearance and liability insurance\? Y emails Bay Plumbing \(office@bayplumbing\.test\) a link/);
    expect(out.tell_owner_exactly).toMatch(/Reply Y \d+ to email them the link, N \d+ to skip\.$/);
    const approval = rows("owner_approvals")[0];
    expect(approval.notified_to).toBe(OWNER);
    await decideApproval(db.client, String(approval.id), { approved: true, decidedVia: "sms", decidedBy: OWNER });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ to: "office@bayplumbing.test", fromName: "Northshore Roofing", replyTo: "dana@northshore.test" });
    expect(await runOwnerTool(ownerState(), "ask_sub_for_docs", { sub: "Nobody" })).toMatchObject({ error: expect.stringContaining("No sub called Nobody") });
  });
});

// ── share_compliance_doc end to end ──────────────────────────────────────────────────

describe("share_compliance_doc", () => {
  function turnState(customerText = "can you send me your insurance certificate?") {
    return {
      admin: db.client,
      facts: { organizationId: ORG, companyId: CO, businessName: "Northshore Roofing", ownerFirstName: "Dana", timeZone: TZ, priceList: [] },
      settings: { enabled: true, autonomy: "standard", enabledIsDefault: true },
      contact: rows("contacts")[0],
      conversation: { id: "conv-1" },
      services: { now: () => new Date() },
      approvalDeps: {},
      effects: newTurnEffects(),
      customerText,
    } as never;
  }
  const tool = () => complianceRole.agentTools.find((t) => t.name === "share_compliance_doc")!;

  it("asks the owner with the exact text; Y texts a 7-day link; the link redirects, is logged, and can be turned off", async () => {
    doc({ id: "dins", number: "CGL-554821" });
    const state = turnState();
    const out = await tool().run(state, { document: "liability_insurance" } as never);
    expect(out).toMatchObject({ ok: true, approval_requested: true });
    expect(String(out.tell_customer)).toContain("checking with Dana");
    const approval = rows("owner_approvals")[0];
    expect(approval).toMatchObject({ kind: "share_compliance_doc", contact_id: JONES, conversation_id: "conv-1" });
    expect(approval.summary).toBe(
      `Dana Jones (705-555-0123) asked for your liability insurance certificate (Intact, expires Mar 31, 2027). Y texts Dana a link to it (expires in 7 days): "Hi Dana, it's Northshore Roofing. Here's our liability insurance certificate (valid to Mar 31, 2027): [link] The link works for 7 days." Their text: "can you send me your insurance certificate?"`,
    );
    // A second ask while one is pending.
    expect(await tool().run(turnState(), { document: "liability_insurance" } as never)).toMatchObject({ already_asked: true });

    const decided = await decideApproval(db.client, String(approval.id), { approved: true, decidedVia: "sms", decidedBy: OWNER });
    expect(decided.result?.message).toBe("Texted Dana Jones the link to your liability insurance certificate (works 7 days). You can turn it off in Settings > AI front desk > Compliance.");
    const share = rows("compliance_shares")[0];
    expect(share).toMatchObject({ status: "sent", document_id: "dins", contact_id: JONES });
    const sms = smsTo(JONES_PHONE);
    expect(sms).toHaveLength(1);
    expect(sms[0].from).toBe(BUSINESS_NUMBER);
    expect(sms[0].body).toContain(`Here's our liability insurance certificate (valid to Mar 31, 2027): https://app.crankleads.test/api/public/compliance/doc/${share.token} The link works for 7 days.`);

    const opened = await openShare(db.client, String(share.token), { ip: "198.51.100.4", userAgent: "Chrome" });
    expect(opened).toEqual({ ok: true, url: `https://storage.test/signed/${ORG}/${CO}/doc-seed.jpg?ttl=60` });
    expect(rows("compliance_shares")[0].open_count).toBe(1);
    expect(rows("compliance_events").find((e) => e.event === "share_opened")).toMatchObject({ share_id: share.id, ip: "198.51.100.4", user_agent: "Chrome" });

    expect(await revokeShares(db.client, scope, { shareId: String(share.id) }, "profile:p-owner", Date.now())).toBe(1);
    expect(await openShare(db.client, String(share.token), { ip: null, userAgent: null })).toEqual({ ok: false, status: 410, businessName: "Northshore Roofing" });
    expect(rows("compliance_events").some((e) => e.event === "share_revoked" && e.actor === "profile:p-owner")).toBe(true);
  });

  it("the link expires after 7 days, and dies when sharing is switched off", async () => {
    doc({ id: "dins" });
    await tool().run(turnState(), { document: "liability_insurance" } as never);
    await decideApproval(db.client, String(rows("owner_approvals")[0].id), { approved: true, decidedVia: "sms", decidedBy: OWNER });
    const token = String(rows("compliance_shares")[0].token);
    expect((await openShare(db.client, token, { ip: null, userAgent: null }, NOW + 7 * DAY + 1)).ok).toBe(false);
    (rows("companies")[0] as Record<string, unknown>).ai_settings = { compliance: { sharing: false } };
    expect((await openShare(db.client, token, { ip: null, userAgent: null })).ok).toBe(false);
    expect(await openShare(db.client, "nope", { ip: null, userAgent: null })).toMatchObject({ ok: false, status: 404 });
  });

  it("nothing on file (or only expired / someone else's): hand off, nothing asked", async () => {
    doc({ id: "dsubins", holder_type: "subcontractor", subcontractor_id: SUB });
    doc({ id: "dold", expires_on: "2026-09-01", status: "expired" });
    const out = await tool().run(turnState(), { document: "liability_insurance" } as never);
    expect(out).toMatchObject({ ok: false });
    expect(String(out.error)).toContain("hand_off_to_owner");
    expect(rows("owner_approvals")).toHaveLength(0);
  });

  it("N: nothing goes to the customer (the owner didn't approve any text); the conversation goes to the owner", async () => {
    doc({ id: "dins" });
    await tool().run(turnState(), { document: "liability_insurance" } as never);
    const out = await decideApproval(db.client, String(rows("owner_approvals")[0].id), { approved: false, decidedVia: "sms", decidedBy: OWNER });
    expect(out.result?.message).toBe("OK - nothing sent. Dana Jones is yours to answer now.");
    expect(smsTo(JONES_PHONE)).toHaveLength(0);
    expect(rows("sms_conversations")[0]).toMatchObject({ state: "owner" });
    expect(rows("compliance_shares")).toHaveLength(0);
  });

  it("sharing off / house org: the agent is told to hand off", async () => {
    (rows("companies")[0] as Record<string, unknown>).ai_settings = { compliance: { sharing: false } };
    doc({ id: "dins" });
    const out = await tool().run(turnState(), { document: "liability_insurance" } as never);
    expect(String(out.error)).toContain("hand_off_to_owner");
  });

  it("owner tool stop_sharing turns a customer's live links off", async () => {
    doc({ id: "dins" });
    await tool().run(turnState(), { document: "liability_insurance" } as never);
    await decideApproval(db.client, String(rows("owner_approvals")[0].id), { approved: true, decidedVia: "sms", decidedBy: OWNER });
    expect(await runOwnerTool(ownerState(), "stop_sharing", { customer: "Dana Jones" })).toEqual({ ok: true, turned_off: 1 });
    expect(rows("compliance_shares")[0].status).toBe("revoked");
  });
});

// ── Owner tools, briefing, Settings ──────────────────────────────────────────────────

describe("owner tools", () => {
  it("compliance_status: expired, expiring, missing, subs without a clearance, waiting for whose", async () => {
    doc({ kind: "vehicle_insurance", issuer: "Aviva", expires_on: "2026-10-01", status: "expired" });
    doc({ kind: "wsib_clearance", issuer: "WSIB", expires_on: "2026-10-30" });
    doc({ kind: "certification", title: "First Aid", holder_type: null, status: "pending", holder_name: "Jo" });
    const out = await runOwnerTool(ownerState(), "compliance_status", {});
    expect(out.expired).toEqual(['Vehicle insurance ("Aviva"): expired Oct 1']);
    expect(out.expiring_within_30_days).toEqual(['WSIB clearance ("WSIB"): expires Oct 30']);
    expect(out.missing_for_the_business).toEqual(["liability insurance"]);
    expect(out.subs_without_a_current_wsib_clearance).toEqual(["Mike's Electric", "Bay Plumbing"]);
    expect(out.waiting_for_whose_it_is).toEqual(['First Aid - name on it "Jo" (texted Sep 1)']);
  });

  it("add_subcontractor checks the cell and doesn't add twice", async () => {
    expect(await runOwnerTool(ownerState(), "add_subcontractor", { business_name: "Lakeside Drywall", name: "Sam", phone: "705 555 0177", trade: "drywall" })).toMatchObject({ ok: true, added: { name: "Lakeside Drywall", cell: "+17055550177" } });
    expect(await runOwnerTool(ownerState(), "add_subcontractor", { business_name: "Lakeside Drywall" })).toMatchObject({ already_on_file: true });
    expect(await runOwnerTool(ownerState(), "add_subcontractor", { business_name: "Bad Cell Co", phone: "12" })).toMatchObject({ error: expect.stringContaining("cell number") });
  });

  it("off for the business: tools say so", async () => {
    (rows("companies")[0] as Record<string, unknown>).ai_settings = { compliance: { enabled: false } };
    expect(await runOwnerTool(ownerState(), "compliance_status", {})).toMatchObject({ error: expect.stringContaining("Compliance is off") });
  });
});

describe("briefing items", () => {
  it("expiring in 7 days / expired in the last 7, most urgent first; waiting certificates; nothing when off", async () => {
    doc({ expires_on: "2026-10-19" });
    doc({ kind: "wsib_clearance", holder_type: "subcontractor", subcontractor_id: SUB, expires_on: "2026-10-10", status: "expired" });
    doc({ kind: "bond", expires_on: "2027-01-01" });
    doc({ kind: "other", holder_type: null, status: "pending" });
    expect(await briefingItems(db.client, scope, "2026-10-12")).toEqual(["Mike's Electric WSIB clearance expired", "Liability insurance expires in 7 days", "1 certificate waiting - text me whose it is"]);
    expect(await briefingItems(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO }, "2026-10-12")).toEqual([]);
  });
});

describe("Settings", () => {
  it("members see counts only; owners see documents (expired flagged), subs and links", async () => {
    doc({ id: "dexp", kind: "vehicle_insurance", expires_on: "2026-10-01", status: "expired" });
    const member = await getComplianceView(db.client, scope, { full: false });
    expect(member).toMatchObject({ documents: null, subs: null, counts: { documents: 1, expired: 1 } });
    const full = await getComplianceView(db.client, scope, { full: true });
    expect(full?.documents?.[0]).toMatchObject({ id: "dexp", status: "expired", label: "Vehicle insurance", holderLabel: "Your business", daysLeft: -11 });
    expect(full?.subs?.map((s) => [s.name, s.clearance])).toEqual([["Mike's Electric", "missing"], ["Bay Plumbing", "missing"]]);
  });

  it("upload from Settings (read + filed under the chosen holder), edit, delete brings the replaced one back", async () => {
    const old = doc({ id: "dold", expires_on: "2026-11-01", status: "expiring" });
    const path = `${ORG}/${CO}/doc-11111111-2222-4333-8444-555555555555.pdf`;
    files.set(path, new Uint8Array([5]));
    const filed = await fileSettingsUpload(db.client, scope, { path, contentType: "application/pdf", holder: { type: "company" } }, "profile:p-owner");
    expect(filed.message).toContain("Saved: liability insurance (Intact, policy ...4821), expires Mar 31, 2027.");
    expect(old.status).toBe("replaced");
    await updateDocument(db.client, scope, filed.documentId, { expiresOn: "2027-04-30", number: "NEW-1" });
    expect(rows("compliance_documents").find((d) => d.id === filed.documentId)).toMatchObject({ expires_on: "2027-04-30", number: "NEW-1", status: "current" });
    await updateDocument(db.client, scope, filed.documentId, { holder: { type: "crew", profileId: MIKE } });
    expect(rows("compliance_documents").find((d) => d.id === filed.documentId)).toMatchObject({ holder_type: "crew", profile_id: MIKE });
    await expect(updateDocument(db.client, scope, filed.documentId, { holder: { type: "subcontractor", subcontractorId: "5b000000-0000-4000-8000-0000000000ff" } })).rejects.toThrow("isn't on your list");
    await deleteDocument(db.client, scope, filed.documentId, "profile:p-owner");
    expect(rows("compliance_documents").find((d) => d.id === filed.documentId)).toBeUndefined();
    expect(files.has(path)).toBe(false);
    expect(old).toMatchObject({ status: "current", replaced_by: null });
    await expect(fileSettingsUpload(db.client, scope, { path: `${HOUSE_ORG}/${HOUSE_CO}/doc-x.pdf`, contentType: "application/pdf" }, "profile:p-owner")).rejects.toThrow("Upload the file again");
  });
});

describe("Twilio media fetch (PDFs too, SSRF guard, auth only to Twilio)", () => {
  it("downloads a PDF from Twilio with Basic auth; refuses other hosts and unknown types", async () => {
    process.env.TWILIO_ACCOUNT_SID = "AC1";
    process.env.TWILIO_AUTH_TOKEN = "secret";
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null });
      return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { "content-type": "application/pdf" } });
    }) as unknown as typeof fetch;
    const got = await fetchComplianceMedia(
      [
        { url: "https://evil.test/x.pdf", contentType: "application/pdf" },
        { url: "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME2", contentType: "video/mp4" },
        { url: "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1", contentType: "application/pdf" },
      ],
      { fetchImpl },
    );
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ contentType: "application/pdf" });
    expect(calls).toHaveLength(1);
    expect(calls[0].auth).toMatch(/^Basic /);
  });
});

// ── Review fixes ─────────────────────────────────────────────────────────────────────

describe("unreadable / non-certificate files never replace a live document", () => {
  async function linkFor() {
    const c = (await loadComplianceCompany(db.client, scope))!;
    const live = doc({ id: "dsub", kind: "wsib_clearance", issuer: "WSIB", holder_type: "subcontractor", subcontractor_id: SUB, expires_on: "2026-10-16", status: "expiring", reminded_30_at: "2026-10-01T00:00:00Z" });
    const res = await proposeSubDocsRequest(db.client, c, SUB, { documentId: live.id, nowMs: Date.now() });
    await decideApproval(db.client, String(res.approvalId), { approved: true, decidedVia: "sms", decidedBy: OWNER });
    const req = rows("compliance_upload_requests")[0];
    const upload = await createSubUploadUrl(db.client, String(req.token), "image/jpeg");
    files.set(upload!.path, new Uint8Array([7]));
    return { live, token: String(req.token), path: upload!.path };
  }

  it("a sub's selfie: saved as pending (not under the sub), nothing replaced, the owner asked, the chase goes on", async () => {
    const { live, token, path } = await linkFor();
    reading = { ...insurance(), isComplianceDocument: false, kind: null };
    const out = await submitSubUpload(db.client, token, { path, contentType: "image/jpeg", kind: "wsib_clearance" }, { ip: null, userAgent: null });
    expect(out?.result.read).toBe(false);
    const filed = rows("compliance_documents").find((d) => d.file_path === path)!;
    expect(filed).toMatchObject({ status: "pending", holder_type: null, subcontractor_id: SUB, kind: "wsib_clearance" });
    expect(live).toMatchObject({ status: "expiring", replaced_by: null });
    expect(ownerTexts().at(-1)).toContain("Mike's Electric sent a file for their WSIB clearance, but I couldn't read it as a certificate, so I haven't filed it");
    // Fri Oct 16: the chase still covers the live clearance (the request is pending → no 2nd ask, a plain line).
    await decideApproval(db.client, String(rows("owner_approvals")[0].id), { approved: true, decidedVia: "sms", decidedBy: OWNER }).catch(() => null);
    vi.setSystemTime(Date.parse("2026-10-16T14:00:00Z"));
    rows("compliance_upload_requests")[0].uploads = 1;
    await sweepExpiry(db.client, Date.now());
    expect(live.reminded_0_at).toBeTruthy();
    // The owner files it after a look: it replaces the old one only now, with a later date.
    const fixed = await runOwnerTool(ownerState(), "file_compliance_doc", { holder: "sub", name: "Mike's Electric", expires_on: "2027-01-09" });
    expect(fixed.tell_owner).toContain("It replaces the old one.");
    expect(live.status).toBe("replaced");
  });

  it("a sub's old copy (same date): filed but not newer, so the one on file stays current", async () => {
    const { live, token, path } = await linkFor();
    reading = insurance({ kind: "wsib_clearance", issuer: "WSIB", holderName: "Mike's Electric", expiresOn: "2026-10-16" });
    await submitSubUpload(db.client, token, { path, contentType: "image/jpeg" }, { ip: null, userAgent: null });
    expect(live).toMatchObject({ status: "expiring", replaced_by: null });
    const copy = rows("compliance_documents").find((d) => d.file_path === path)!;
    expect(copy).toMatchObject({ holder_type: "subcontractor", status: "replaced", replaced_by: "dsub" });
    expect(copy.reminded_7_at ?? null).toBeNull();
    expect(copy.reminded_0_at ?? null).toBeNull();
    expect(ownerTexts().at(-1)).toBe("CrankLeads: Mike's Electric sent a new WSIB clearance (expires Oct 16). It isn't newer than the one on file (expires Oct 16), so that one stays current.");
  });

  it("the same upload sent twice uses one slot", async () => {
    const { token, path } = await linkFor();
    reading = insurance({ kind: "wsib_clearance", issuer: "WSIB", holderName: "Mike's Electric", expiresOn: "2027-01-09" });
    await submitSubUpload(db.client, token, { path, contentType: "image/jpeg" }, { ip: null, userAgent: null });
    const again = await submitSubUpload(db.client, token, { path, contentType: "image/jpeg" }, { ip: null, userAgent: null });
    expect(again?.result).toEqual({ label: "WSIB clearance", expiresOn: "2027-01-09", read: true });
    expect(rows("compliance_upload_requests")[0].uploads).toBe(1);
    expect(rows("compliance_documents").filter((d) => d.file_path === path)).toHaveLength(1);
  });

  it("a receipt texted with \"truck insurance\" while the reader is down: the live vehicle insurance stays current and is still chased", async () => {
    const live = doc({ id: "dveh", kind: "vehicle_insurance", issuer: "Aviva", expires_on: "2026-10-19" });
    reading = null;
    const out = await handleComplianceMedia(db.client, mediaInput("truck insurance"));
    expect(out?.reply).toBe(`Saved: vehicle insurance. The one already on file (expires Oct 19, 2026) stays the current one until I know this one's date. I couldn't see an expiry date - text me "expires" and the date if it has one.`);
    expect(live).toMatchObject({ status: "current", replaced_by: null });
    await sweepExpiry(db.client, NOW);
    expect(ownerTexts().at(-1)).toContain("Vehicle insurance expires in 7 days");
  });
});

describe("handoff with the tax clerk: words alone", () => {
  it("never claims what the reader says isn't a certificate, whatever the words", async () => {
    reading = { ...insurance(), isComplianceDocument: false, kind: null };
    for (const [i, body] of ["building permit fee Jones job", "insurance payment", "our WSIB clearance"].entries()) {
      expect(await handleComplianceMedia(db.client, mediaInput(body, `log-r${i}`))).toBeNull();
    }
  });

  it("reader down: claims only a specific kind with no payment words", async () => {
    reading = null;
    for (const [i, body] of ["building permit fee Jones job", "insurance payment", "paid the insurance bill", "permit", "policy", "ticket", "cert", "fee"].entries()) {
      expect(await handleComplianceMedia(db.client, mediaInput(body, `log-n${i}`))).toBeNull();
    }
    expect((await handleComplianceMedia(db.client, mediaInput("Mike's working at heights ticket", "log-y1")))?.reply).toContain("Saved: Mike's certification.");
    expect(rows("compliance_documents")).toHaveLength(1);
  });
});

describe("front and back pages", () => {
  it("up to 3 files in one text are one document", async () => {
    fetchMedia.mockResolvedValueOnce([
      { bytes: new Uint8Array([1]), contentType: "image/jpeg" },
      { bytes: new Uint8Array([2]), contentType: "image/jpeg" },
    ]);
    read.mockResolvedValueOnce(insurance({ expiresOn: null, number: null })).mockResolvedValueOnce(insurance({ issuer: null, number: null, expiresOn: "2027-03-31" }));
    const out = await handleComplianceMedia(db.client, mediaInput("our insurance"));
    expect(out?.reply).toBe("Saved (2 pages): liability insurance (Intact), expires Mar 31, 2027. I'll remind you 30 days before.");
    const saved = rows("compliance_documents")[0];
    expect((saved.extra_file_paths as string[]).length).toBe(1);
    expect(rows("compliance_uploads") ?? []).toHaveLength(0);
  });
});

describe("no business number of its own: never the shared platform line", () => {
  beforeEach(() => {
    db.tables.voice_numbers = [];
  });

  it("subs: email when they have one, else the owner is told; customers: hand off", async () => {
    const out = await runOwnerTool(ownerState(), "ask_sub_for_docs", { sub: "Mike's Electric" });
    expect(out.error).toBe("Your business has no texting number of its own yet and there's no email for Mike's Electric, so I can't send them a link. Add their email (or cell) in Settings > AI front desk > Compliance.");
    (rows("subcontractors")[0] as Record<string, unknown>).email = "mike@electric.test";
    const ok = await runOwnerTool(ownerState(), "ask_sub_for_docs", { sub: "Mike's Electric" });
    expect(ok.tell_owner_exactly).toContain("Y emails Mike (mike@electric.test)");
    doc({ id: "dins" });
    const share = await complianceRole.agentTools[0].run(
      { admin: db.client, facts: { organizationId: ORG, companyId: CO, businessName: "Northshore Roofing", ownerFirstName: "Dana" }, contact: rows("contacts")[0], conversation: { id: "conv-1" }, services: { now: () => new Date() }, effects: newTurnEffects(), customerText: "insurance?" } as never,
      { document: "liability_insurance" } as never,
    );
    expect(String(share.error)).toContain("hand_off_to_owner");
    expect(sendSms.mock.calls.filter((c) => (c[0] as { to: string }).to !== OWNER)).toHaveLength(0);
  });

  it("a share approved earlier isn't sent once the number is gone", async () => {
    db.tables.voice_numbers = [{ organization_id: ORG, company_id: CO, provider: "twilio", active: true, phone_e164: BUSINESS_NUMBER, mode: "missed_call_catcher" }];
    doc({ id: "dins" });
    await complianceRole.agentTools[0].run(
      { admin: db.client, facts: { organizationId: ORG, companyId: CO, businessName: "Northshore Roofing", ownerFirstName: "Dana" }, contact: rows("contacts")[0], conversation: { id: "conv-1" }, services: { now: () => new Date() }, effects: newTurnEffects(), customerText: null } as never,
      { document: "liability_insurance" } as never,
    );
    db.tables.voice_numbers = [];
    const out = await decideApproval(db.client, String(rows("owner_approvals")[0].id), { approved: true, decidedVia: "sms", decidedBy: OWNER });
    expect(out.result?.message).toBe("Nothing sent: your business has no texting number of its own yet, so I can't text Dana Jones from it.");
    expect(smsTo(JONES_PHONE)).toHaveLength(0);
  });
});

describe("whose is it: the answer only ever lands on the waiting document", () => {
  it("a pending document weeks old is still the one answered; a filed one is never re-held without naming it", async () => {
    const filed = doc({ id: "dfiled", kind: "liability_insurance", created_at: "2026-10-11T12:00:00Z" });
    const waiting = doc({ id: "dwait", kind: "certification", title: "First Aid", holder_type: null, status: "pending", created_at: "2026-09-01T00:00:00Z" });
    expect(await briefingItems(db.client, scope, "2026-10-12")).toContain("1 certificate waiting - text me whose it is");
    const out = await runOwnerTool(ownerState(), "file_compliance_doc", { holder: "crew", name: "Mike" });
    expect(out.tell_owner).toContain("Saved: Mike's First Aid");
    expect(waiting).toMatchObject({ holder_type: "crew", profile_id: MIKE });
    expect(filed).toMatchObject({ holder_type: "company" });
    // Nothing pending now: "it's Mike's" without naming the document changes nothing.
    expect(await runOwnerTool(ownerState(), "file_compliance_doc", { holder: "crew", name: "Mike" })).toMatchObject({ error: expect.stringContaining("say which one") });
    expect(filed.holder_type).toBe("company");
  });

  it("a date given before whose it is: kept on the pending document, and asked again", async () => {
    const waiting = doc({ id: "dwait", kind: "certification", title: "First Aid", holder_type: null, status: "pending" });
    const out = await runOwnerTool(ownerState(), "file_compliance_doc", { expires_on: "2028-01-01" });
    expect(out).toMatchObject({ still_waiting: true });
    expect(waiting).toMatchObject({ status: "pending", expires_on: "2028-01-01" });
  });
});

describe("certificate links follow the document", () => {
  async function shared() {
    doc({ id: "dins", expires_on: "2026-11-30" });
    await complianceRole.agentTools[0].run(
      { admin: db.client, facts: { organizationId: ORG, companyId: CO, businessName: "Northshore Roofing", ownerFirstName: "Dana" }, contact: rows("contacts")[0], conversation: { id: "conv-1" }, services: { now: () => new Date() }, effects: newTurnEffects(), customerText: null } as never,
      { document: "liability_insurance" } as never,
    );
  }

  it("410 once the document is replaced or has expired", async () => {
    await shared();
    await decideApproval(db.client, String(rows("owner_approvals")[0].id), { approved: true, decidedVia: "sms", decidedBy: OWNER });
    const token = String(rows("compliance_shares")[0].token);
    expect((await openShare(db.client, token, { ip: null, userAgent: null })).ok).toBe(true);
    const d = rows("compliance_documents").find((x) => x.id === "dins")!;
    d.status = "replaced";
    expect(await openShare(db.client, token, { ip: null, userAgent: null })).toMatchObject({ ok: false, status: 410 });
    d.status = "current";
    d.expires_on = "2026-10-11";
    expect(await openShare(db.client, token, { ip: null, userAgent: null })).toMatchObject({ ok: false, status: 410 });
  });

  it("a queued share is re-checked before it goes: a replaced document isn't sent", async () => {
    await shared();
    vi.setSystemTime(Date.parse("2026-10-13T01:30:00Z")); // 9:30pm → queued
    await decideApproval(db.client, String(rows("owner_approvals")[0].id), { approved: true, decidedVia: "sms", decidedBy: OWNER });
    rows("compliance_documents").find((x) => x.id === "dins")!.status = "replaced";
    await sweepOutbox(db.client, Date.parse("2026-10-13T13:05:00Z"));
    expect(smsTo(JONES_PHONE)).toHaveLength(0);
    expect(rows("compliance_shares")[0]).toMatchObject({ status: "revoked", last_error: "replaced" });
  });
});

describe("orphan files", () => {
  it("an upload URL nobody files is deleted after 24 h; a filed one only forgotten", async () => {
    const c = (await loadComplianceCompany(db.client, scope))!;
    void c;
    const live = doc({ id: "dsub", kind: "wsib_clearance", holder_type: "subcontractor", subcontractor_id: SUB, expires_on: "2026-10-16" });
    const res = await proposeSubDocsRequest(db.client, (await loadComplianceCompany(db.client, scope))!, SUB, { documentId: live.id, nowMs: Date.now() });
    await decideApproval(db.client, String(res.approvalId), { approved: true, decidedVia: "sms", decidedBy: OWNER });
    const token = String(rows("compliance_upload_requests")[0].token);
    const abandoned = await createSubUploadUrl(db.client, token, "image/jpeg");
    files.set(abandoned!.path, new Uint8Array([1]));
    const used = await createSubUploadUrl(db.client, token, "image/jpeg");
    files.set(used!.path, new Uint8Array([2]));
    reading = insurance({ kind: "wsib_clearance", issuer: "WSIB", holderName: "Mike's Electric", expiresOn: "2027-01-09" });
    await submitSubUpload(db.client, token, { path: used!.path, contentType: "image/jpeg" }, { ip: null, userAgent: null });
    expect(rows("compliance_uploads").map((r) => r.path)).toEqual([abandoned!.path]);
    expect(await sweepOrphanUploads(db.client, NOW + HOUR)).toBe(0);
    expect(await sweepOrphanUploads(db.client, NOW + 25 * HOUR)).toBe(1);
    expect(files.has(abandoned!.path)).toBe(false);
    expect(files.has(used!.path)).toBe(true);
    expect(rows("compliance_uploads")).toHaveLength(0);
  });
});
