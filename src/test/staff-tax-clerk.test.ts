/**
 * The Tax Clerk — receipts by text and the HST worksheet (docs/ai-staff.md → "Receipts & HST"),
 * against the in-memory fake DB with the real owner channel underneath (handleOwnerInboundSms,
 * decideApproval, notifyOwnerOfApproval, runOwnerTool, the registry). Only the outside world is
 * faked: texts (deliverMessage), Resend (sendEmail), Storage, the Twilio media fetch and the
 * receipt reader (the model).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

const deliverMessage = vi.fn((..._a: unknown[]) => Promise.resolve({ status: "sent", body: "sent body" }));
const sendEmail = vi.fn((..._a: unknown[]) => Promise.resolve({ id: "re_1" }));
const runOwnerCommandAgent = vi.fn((..._a: unknown[]) => Promise.resolve({ reply: "agent reply", actions: [], rounds: 1, confirmationId: null }));
let db: FakeDb;

vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => db.client }));
vi.mock("@/server/services/workflow-engine/messaging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/services/workflow-engine/messaging")>()),
  deliverMessage: (...a: unknown[]) => deliverMessage(...a),
}));
vi.mock("@/server/outbound/email", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: vi.fn(), recordAiUsageSafe: vi.fn() }));
vi.mock("@/server/services/push/activity", () => ({ notifyActivityEvent: vi.fn() }));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({ emitActivityEventAndDispatch: vi.fn(() => Promise.resolve({ activityEvent: {}, workflowEventJob: null })) }));
vi.mock("@/server/services/sms-agent/approved", () => ({ executeApprovedAction: vi.fn(() => Promise.resolve({ ok: true, message: "ok" })) }));
vi.mock("@/server/services/owner-channel/agent", () => ({ runOwnerCommandAgent: (...a: unknown[]) => runOwnerCommandAgent(...a) }));

const aiCalls: Array<Record<string, unknown>> = [];
let aiAnswer = "{}";
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: vi.fn(async (req: Record<string, unknown>) => {
        aiCalls.push(req);
        return { id: "msg_1", model: "m", content: [{ type: "text", text: aiAnswer }], usage: { input_tokens: 10, output_tokens: 5 } };
      }),
    };
  },
}));

import { readReceipt } from "@/server/ai/receipt-reader";
import { replyInstruction } from "@/server/services/front-desk/approval-text";
import { decideApproval, expireApproval } from "@/server/services/owner-channel/approvals";
import { handleOwnerInboundSms } from "@/server/services/owner-channel/entry";
import { runOwnerTool, type ToolRunState } from "@/server/services/owner-channel/tools";
import { activeRolesFor, ownerMediaHandlersFor, roleApprovalExecutor, staffRoles } from "@/server/services/staff/registry";
import { taxClerkRole, briefingItems, TAX_CLERK_SWEEPS, resetTaxClerkCompanyCache } from "@/server/services/staff/tax-clerk";
import { computeWorksheet, lastEndedPeriod, periodContaining, reminderText, worksheetFor, type HstPeriod } from "@/server/services/staff/tax-clerk/hst";
import { expensesCsv, invoicesCsv } from "@/server/services/staff/tax-clerk/packet";
import { composeReply, handleReceiptMedia, setReceiptDeps, type ReadResult, type ReceiptDeps } from "@/server/services/staff/tax-clerk/receipts";
import { periodToRemind, runCompanyHstReminder, defaultReminderDeps } from "@/server/services/staff/tax-clerk/reminders";
import { runCompanyTip, runCompanyWeeklyNudge, TIP_TEXT, weeklyNudgeText } from "@/server/services/staff/tax-clerk/nudges";
import { loadTaxClerkCompanies, loadTaxClerkCompany, mergeTaxClerkSettings, readTaxClerkSettings, taxClerkActiveFor } from "@/server/services/staff/tax-clerk/settings";
import { emailPacketFromApp, finishReceipt, getTaxClerkView } from "@/server/services/staff/tax-clerk/view";
import { categoryIn, jobWordsIn, matchJob, namesComplianceDoc, paidWithIn, poReferenceIn } from "@/server/services/staff/tax-clerk/words";
import type { OwnerMediaInput } from "@/server/services/staff/types";

const TZ = "America/Toronto";
const ORG = "11111111-1111-4111-8111-111111111111";
const CO = "22222222-2222-4222-8222-222222222222";
const HOUSE_ORG = "33333333-3333-4333-8333-333333333333";
const HOUSE_CO = "44444444-4444-4444-8444-444444444444";
const OWNER = "+17055559999";
const HOUSE_OWNER = "+17055558888";
const PLATFORM = "+16475550000";
const P_OWNER = "a0000000-0000-4000-8000-000000000001";
const P_CREW = "a0000000-0000-4000-8000-000000000002";
const DANA = "c0000000-0000-4000-8000-000000000001";
const SAM = "c0000000-0000-4000-8000-000000000002";
const JONES_ROOF = "b0000000-0000-4000-8000-000000000001";
const SMITH_FENCE = "b0000000-0000-4000-8000-000000000002";
const HOUR = 3_600_000;
const DAY = 86_400_000;

// Wed Oct 14 2026, 11:00 in Toronto (EDT).
const NOW = Date.parse("2026-10-14T15:00:00Z");

/** A real 1x1 PNG (pdf-lib embeds it). */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const MEDIA: Record<string, { type: "image/jpeg" | "image/png" | "application/pdf" | "image/webp"; bytes: Buffer }> = {
  depot: { type: "image/jpeg", bytes: Buffer.from("RECEIPT-DEPOT") },
  esso: { type: "image/png", bytes: PNG },
  job: { type: "image/jpeg", bytes: Buffer.from("NOT-A-RECEIPT") },
  blurry: { type: "image/jpeg", bytes: Buffer.from("BLURRY") },
  pdf: { type: "application/pdf", bytes: Buffer.from("%PDF-RONA") },
  webp: { type: "image/webp", bytes: Buffer.from("WEBP-TIMS") },
  cert: { type: "image/jpeg", bytes: Buffer.from("CERTIFICATE") },
  broken: { type: "image/jpeg", bytes: Buffer.from("THROW") },
  novendor: { type: "image/jpeg", bytes: Buffer.from("NOVENDOR") },
};

function mediaUrl(key: string) {
  return { url: `https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/${key}`, contentType: MEDIA[key]?.type ?? "image/jpeg" };
}

const SCANS: Record<string, ReadResult> = {
  "RECEIPT-DEPOT": { kind: "receipt", scan: { vendor: "Home Depot", spentOn: "2026-10-14", amountCents: 8420, taxCents: 969, category: "materials", description: "Shingles" } },
  PNG: { kind: "receipt", scan: { vendor: "Esso", spentOn: "2026-10-13", amountCents: 6000, taxCents: 690, category: "fuel", description: null } },
  "NOT-A-RECEIPT": { kind: "not_receipt", scan: { vendor: null, spentOn: null, amountCents: null, taxCents: null, category: null, description: null } },
  BLURRY: { kind: "receipt", scan: { vendor: "Rona", spentOn: null, amountCents: null, taxCents: null, category: null, description: null } },
  "%PDF-RONA": { kind: "supplier_invoice", scan: { vendor: "Rona Pro", spentOn: null, amountCents: 22600, taxCents: 2600, category: "materials", description: "Lumber" } },
  CERTIFICATE: { kind: "not_receipt", scan: { vendor: null, spentOn: null, amountCents: null, taxCents: null, category: null, description: null } },
  NOVENDOR: { kind: "receipt", scan: { vendor: null, spentOn: "2026-10-14", amountCents: 2000, taxCents: 230, category: "meals", description: null } },
  "WEBP-TIMS": { kind: "receipt", scan: { vendor: "Tim Hortons", spentOn: "2026-10-14", amountCents: 1130, taxCents: 130, category: "meals", description: null } },
};

const uploads: Array<{ path: string; type: string; bytes: Uint8Array }> = [];
const removed: string[] = [];
const reads: string[] = [];
let readerOn = true;

const testDeps: Partial<ReceiptDeps> = {
  fetchMedia: async (media) =>
    media.flatMap((m, index) => {
      const key = m.url.split("/").pop() as string;
      return MEDIA[key] ? [{ index, type: MEDIA[key].type, bytes: MEDIA[key].bytes }] : [];
    }),
  read: async (file) => {
    if (!readerOn) return null;
    const key = file.type === "image/png" ? "PNG" : file.bytes.toString();
    reads.push(key);
    if (key === "THROW") throw new Error("model down");
    return SCANS[key] ?? null;
  },
  storage: () => ({
    upload: async (_org, path, bytes, type) => {
      uploads.push({ path, type, bytes });
    },
    signedUrls: async (_org, paths) => new Map(paths.map((p) => [p, `https://signed.test/${p}`])),
    remove: async (_org, path) => {
      removed.push(path);
    },
  }),
};

function company(over: Record<string, unknown> = {}) {
  return {
    id: CO, organization_id: ORG, name: "Northshore Roofing", brand_from_name: null, timezone: TZ, ai_settings: {}, stage: "active",
    owner_phone_e164: OWNER, owner_phone_verified_at: "2026-10-01T00:00:00Z", owner_email: "dana@northshore.test", tax_registration_number: "123456789 RT0001",
    created_at: "2026-01-01T00:00:00Z",
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
      companies: [company(), company({ id: HOUSE_CO, organization_id: HOUSE_ORG, name: "A1 Marine Care", owner_phone_e164: HOUSE_OWNER, owner_email: "a1@a1.test" })],
      organization_memberships: [
        { organization_id: ORG, profile_id: P_CREW, role: "member", phone_e164: null },
        { organization_id: ORG, profile_id: P_OWNER, role: "owner", phone_e164: OWNER },
        { organization_id: HOUSE_ORG, profile_id: "a0000000-0000-4000-8000-000000000009", role: "owner", phone_e164: HOUSE_OWNER },
      ],
      profiles: [
        { id: P_OWNER, full_name: "Dana Whitfield", email: "dana@northshore.test" },
        { id: P_CREW, full_name: "Mike Dunn", email: "mike@northshore.test" },
      ],
      contacts: [
        { id: DANA, organization_id: ORG, company_id: CO, first_name: "Dana", last_name: "Jones" },
        { id: SAM, organization_id: ORG, company_id: CO, first_name: "Sam", last_name: "Smith" },
      ],
      bookings: [
        { id: JONES_ROOF, organization_id: ORG, company_id: CO, contact_id: DANA, title: "Roof repair", scheduled_for: "2026-10-14T13:00:00Z", status: "confirmed" },
        { id: SMITH_FENCE, organization_id: ORG, company_id: CO, contact_id: SAM, title: "Fence", scheduled_for: "2026-10-10T13:00:00Z", status: "completed" },
      ],
      expenses: [],
      invoices: [],
      receipt_texts: [],
      hst_periods: [],
      tax_clerk_notices: [],
      owner_approvals: [],
      owner_command_log: [],
      platform_sms_opt_outs: [],
    },
    {
      owner_command_log: [["provider_ref"]],
      receipt_texts: [["log_id", "media_index"]],
      hst_periods: [["company_id", "period_start", "period_end"]],
      tax_clerk_notices: [["company_id", "kind", "key"]],
    },
  );
}

/** Fake Supabase Storage on the fake client (the packet signs receipt links through it). */
function withStorage() {
  (db.client as unknown as { storage: unknown }).storage = {
    from: () => ({
      createSignedUrls: async (paths: string[]) => ({ data: paths.map((p) => ({ path: p, signedUrl: `https://signed.test/${p}?ttl=30d` })), error: null }),
      upload: async () => ({ error: null }),
      remove: async () => ({ error: null }),
    }),
  };
}

const rows = (table: string) => db.tables[table] as Array<Record<string, unknown>>;
const replies = () => deliverMessage.mock.calls.map((c) => (c[0] as { body: string }).body);
let sid = 0;
function text(body: string, media: Array<{ url: string; contentType: string | null }>, from = OWNER) {
  return handleOwnerInboundSms(db.client, { from, to: PLATFORM, body, media, providerRef: `SM${++sid}`, viaPlatformNumber: true, companyId: null });
}
function input(body: string, keys: string[], logId = "e0000000-0000-4000-8000-000000000001", nowMs = NOW): OwnerMediaInput {
  return { scope: { organizationId: ORG, companyId: CO, companyName: "Northshore Roofing", timeZone: TZ }, ownerPhone: OWNER, body, media: keys.map(mediaUrl), logId, nowMs };
}
function ownerState(nowMs = NOW): ToolRunState {
  return { admin: db.client, scope: { organizationId: ORG, companyId: CO, companyName: "Northshore Roofing", timeZone: TZ }, ownerPhone: OWNER, nowMs, confirmation: null, actions: [] };
}

beforeEach(() => {
  process.env.PLATFORM_SMS_NUMBER = PLATFORM;
  db = seed();
  withStorage();
  deliverMessage.mockClear();
  sendEmail.mockClear();
  runOwnerCommandAgent.mockClear();
  uploads.length = 0;
  removed.length = 0;
  reads.length = 0;
  readerOn = true;
  sid = 0;
  setReceiptDeps(testDeps);
  resetTaxClerkCompanyCache();
});

afterEach(() => {
  setReceiptDeps(null);
});

// ── Words ─────────────────────────────────────────────────────────────────────

describe("the owner's words", () => {
  it("compliance words pass to the Compliance role", () => {
    for (const t of ["insurance certificate", "WSIB clearance", "my COI", "new licence", "license renewal", "building permit", "working at heights ticket", "cert", "the policy"]) expect(namesComplianceDoc(t)).toBe(true);
    for (const t of ["Jones job", "fuel", "PO-12 materials", "personal card"]) expect(namesComplianceDoc(t)).toBe(false);
  });

  it("PO, paid with, category", () => {
    expect(poReferenceIn("PO-12")).toBe("PO-12");
    expect(poReferenceIn("po 7 for Jones")).toBe("PO-7");
    expect(poReferenceIn("P.O. #0045")).toBe("PO-45");
    expect(poReferenceIn("Jones job")).toBeNull();
    expect(paidWithIn("personal card")).toBe("personal");
    expect(paidWithIn("paid it myself")).toBe("personal");
    expect(paidWithIn("company card")).toBe("business");
    expect(paidWithIn("Jones job")).toBeNull();
    expect(categoryIn("fuel")).toBe("fuel");
    expect(categoryIn("lunch for the crew")).toBe("meals");
    expect(categoryIn("gas and lunch")).toBeNull();
    expect(categoryIn("Jones job")).toBeNull();
  });

  it("job words match a customer by name; two customers tied is ambiguous; title words only break ties", () => {
    const jobs = [
      { bookingId: "1", title: "Roof repair", scheduledFor: "2026-10-14T13:00:00Z", contactId: "c1", firstName: "Dana", lastName: "Jones" },
      { bookingId: "2", title: "Deck", scheduledFor: "2026-10-20T13:00:00Z", contactId: "c1", firstName: "Dana", lastName: "Jones" },
      { bookingId: "3", title: "Roof", scheduledFor: "2026-10-12T13:00:00Z", contactId: "c2", firstName: "Pat", lastName: "Jones" },
      { bookingId: "4", title: "Cottage dock", scheduledFor: "2026-10-12T13:00:00Z", contactId: "c3", firstName: "Lee", lastName: "Ng" },
    ];
    expect(jobWordsIn("Jones job, personal card PO-12")).toEqual(["jones"]);
    expect(matchJob(jobWordsIn("Dana Jones"), jobs, "2026-10-14")).toMatchObject({ kind: "one", job: { bookingId: "1" } });
    expect(matchJob(jobWordsIn("Jones deck"), jobs, "2026-10-14")).toMatchObject({ kind: "one", job: { bookingId: "2" } });
    expect(matchJob(jobWordsIn("Jones"), jobs, "2026-10-14").kind).toBe("ambiguous");
    expect(matchJob(jobWordsIn("cottage dock"), jobs, "2026-10-14")).toMatchObject({ kind: "one", job: { bookingId: "4" } });
    expect(matchJob(jobWordsIn("Wilson"), jobs, "2026-10-14").kind).toBe("none");
  });
});

// ── Settings / registry ───────────────────────────────────────────────────────

describe("settings and registry", () => {
  it("defaults: on for done-for-you, off for house orgs; registrant follows the HST number", () => {
    const cl = readTaxClerkSettings({}, { doneForYou: true, hasHstNumber: true });
    expect(cl).toMatchObject({ receipts: { enabled: true }, hst: { registrant: true, frequency: "quarterly", fiscalYearEndMonth: 12, filer: "corporation", reminders: true, accountantEmail: null }, nudges: { weekly: true, tip: true } });
    expect(readTaxClerkSettings({}, { doneForYou: true, hasHstNumber: false }).hst.registrant).toBe(false);
    const house = readTaxClerkSettings({}, { doneForYou: false, hasHstNumber: true });
    expect(house).toMatchObject({ receipts: { enabled: false }, hst: { reminders: false }, nudges: { weekly: false, tip: false } });
    const merged = mergeTaxClerkSettings({ other: 1 }, { receipts: { enabled: true }, hst: { accountantEmail: " Books@Acct.CA ", frequency: "monthly", registrant: false } });
    expect(merged.other).toBe(1);
    expect(readTaxClerkSettings(merged, { doneForYou: false, hasHstNumber: true })).toMatchObject({ receipts: { enabled: true }, hst: { accountantEmail: "books@acct.ca", frequency: "monthly", registrant: false } });
    expect((merged.tax_clerk as Record<string, unknown>).any_on).toBe(true);
    const cleared = mergeTaxClerkSettings(merged, { hst: { registrant: null, accountantEmail: "" } });
    expect(readTaxClerkSettings(cleared, { doneForYou: true, hasHstNumber: true }).hst).toMatchObject({ registrantSetting: null, registrant: true, accountantEmail: null });
  });

  it("the role is registered with its media handler, kind, tools and sweeps; house orgs never see it", async () => {
    expect(staffRoles().map((r) => r.role).indexOf("tax_clerk")).toBe(staffRoles().map((r) => r.role).indexOf("recruiter") + 1);
    expect(taxClerkRole.ownerMedia).toBeDefined();
    expect(roleApprovalExecutor("accountant_packet")).toBeTypeOf("function");
    expect(taxClerkRole.ownerTools.map((t) => t.tool.name)).toEqual(["fix_receipt", "receipts_summary", "hst_summary", "send_hst_packet"]);
    expect(TAX_CLERK_SWEEPS.map((s) => s.name)).toEqual(["tax_clerk:hst", "tax_clerk:nudges"]);
    expect(await taxClerkActiveFor(db.client, { organizationId: ORG, companyId: CO })).toBe(true);
    expect(await taxClerkActiveFor(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO })).toBe(false);
    expect((await activeRolesFor(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO })).map((r) => r.role)).not.toContain("tax_clerk");
    expect((await ownerMediaHandlersFor(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO })).map((h) => h.role)).not.toContain("tax_clerk");
    expect((await loadTaxClerkCompanies(db.client)).map((c) => c.companyId)).toEqual([CO]);
    expect(replyInstruction("accountant_packet", 12)).toBe("Reply Y 12 to email it, N 12 to skip.");
  });
});

// ── Receipts by text ──────────────────────────────────────────────────────────

describe("receipts by text (through the owner channel)", () => {
  // The owner channel reads the clock itself.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a receipt that only names a Purchasing PO is filed on that PO's job", async () => {
    db.tables.purchase_orders = [{ id: "po-1", organization_id: ORG, company_id: CO, po_number: "PO-12", booking_id: SMITH_FENCE }];
    await text("PO-12", [mediaUrl("depot")]);
    expect(rows("expenses")[0]).toMatchObject({ booking_id: SMITH_FENCE });
    expect(rows("receipt_texts")[0]).toMatchObject({ status: "filed", po_reference: "PO-12" });
    expect(replies().at(-1)).toContain("Smith Fence");
  });

  it("E2E: a receipt with words is filed as an expense on the job and the owner gets one reply", async () => {
    await text("Jones job, personal card PO-12", [mediaUrl("depot")]);
    expect(rows("expenses")).toHaveLength(1);
    const e = rows("expenses")[0];
    expect(e).toMatchObject({
      organization_id: ORG, company_id: CO, booking_id: JONES_ROOF, spent_on: "2026-10-14", vendor: "Home Depot", category: "materials",
      amount_cents: 8420, tax_cents: 969, paid_with: "personal", billable: false, receipt_type: "image/jpeg", created_by: P_OWNER,
    });
    expect(String(e.receipt_path)).toMatch(new RegExp(`^${ORG}/[0-9a-f-]{36}\\.jpg$`));
    expect(uploads[0]).toMatchObject({ path: e.receipt_path, type: "image/jpeg" });
    expect(rows("receipt_texts")[0]).toMatchObject({ status: "filed", expense_id: e.id, po_reference: "PO-12", owner_words: "Jones job, personal card PO-12" });
    expect(replies().at(-1)).toContain('Got it: Home Depot $84.20 (HST $9.69), Materials, Jones Roof repair (Oct 14), your own card, PO-12. Reply "fix" to change it.');
    expect(rows("owner_command_log").at(-1)!.intent).toBe("receipt");
    expect(runOwnerCommandAgent).not.toHaveBeenCalled();
  });

  it("a duplicate (same vendor, date, total) is not filed twice", async () => {
    await text("", [mediaUrl("depot")]);
    await text("", [mediaUrl("depot")]);
    expect(rows("expenses")).toHaveLength(1);
    expect(rows("receipt_texts")[1]).toMatchObject({ status: "duplicate", duplicate_of: rows("expenses")[0].id });
    expect(replies().at(-1)).toContain("Already have that one: Home Depot $84.20 on Oct 14 - not added again.");
    expect(uploads).toHaveLength(1);
  });

  it("a picture that isn't a receipt passes: the old reply, nothing filed", async () => {
    await text("", [mediaUrl("job")]);
    expect(replies().at(-1)).toContain("Got the picture");
    expect(rows("expenses")).toHaveLength(0);
    expect(rows("receipt_texts")[0].status).toBe("not_receipt");
  });

  it("compliance words with a certificate picture: read, not a receipt, passed (the Compliance role, next in line, takes it)", async () => {
    await text("insurance certificate renewal", [mediaUrl("cert")]);
    expect(reads).toEqual(["CERTIFICATE"]);
    expect(rows("receipt_texts")[0].status).toBe("not_receipt");
    expect(rows("expenses")).toHaveLength(0);
    const intent = String(rows("owner_command_log").at(-1)?.intent ?? "");
    expect(intent).not.toBe("receipt");
    expect(intent === "command" || intent.startsWith("media:compliance") || intent.startsWith("compliance")).toBe(true);
  });

  it("compliance words with a real receipt ('building permit fee', 'insurance payment'): filed anyway", async () => {
    await text("building permit fee Jones job", [mediaUrl("depot")]);
    expect(rows("expenses")).toHaveLength(1);
    expect(rows("expenses")[0]).toMatchObject({ booking_id: JONES_ROOF, vendor: "Home Depot" });
    expect(rows("owner_command_log").at(-1)!.intent).toBe("receipt");
    await text("insurance payment", [mediaUrl("pdf")]);
    expect(rows("expenses")).toHaveLength(2);
    for (const w of ["g2 ticket", "309A", "first aid course", "working at heights", "bonded"]) expect(namesComplianceDoc(w)).toBe(true);
  });

  it("the reader fails (model outage): a bare photo or compliance words pass; only clear receipt words keep it to finish", async () => {
    await text("", [mediaUrl("broken")]);
    expect(replies().at(-1)).toContain("Got the picture");
    expect(rows("receipt_texts")[0].status).toBe("not_receipt");
    await text("wsib clearance receipt", [mediaUrl("broken")]);
    expect(rows("receipt_texts")[1].status).toBe("not_receipt");
    expect(String(rows("owner_command_log").at(-1)!.intent)).not.toBe("receipt");
    await text("receipt for the Jones job", [mediaUrl("broken")]);
    expect(rows("receipt_texts")[2].status).toBe("needs_review");
    expect(rows("expenses")).toHaveLength(0);
  });

  it("house org (A1): exactly as before - no reading, no rows, the old reply", async () => {
    await text("", [mediaUrl("depot")], HOUSE_OWNER);
    expect(reads).toHaveLength(0);
    expect(rows("receipt_texts")).toHaveLength(0);
    expect(rows("expenses")).toHaveLength(0);
    expect(replies().at(-1)).toContain("Got the picture");
  });

  it("an unreadable receipt is kept to finish; 'fix $84.20' files it", async () => {
    await text("", [mediaUrl("blurry")]);
    expect(rows("expenses")).toHaveLength(0);
    expect(rows("receipt_texts")[0]).toMatchObject({ status: "needs_review", vendor: "Rona", missing: ["total", "date"] });
    expect(uploads).toHaveLength(1);
    expect(replies().at(-1)).toContain("Saved the picture (Rona) but I couldn't read the total or the date. Text \"fix $84.20 Oct 14\"");
    const fixed = await runOwnerTool(ownerState(NOW + HOUR), "fix_receipt", { amount: "$56.50", tax: "$6.50", category: "materials", job: "Smith" });
    expect(fixed).toMatchObject({ ok: true });
    expect(String(fixed.tell_owner)).toContain("Filed: Rona $56.50 (HST $6.50) on Oct 14, Materials, Smith Fence (Oct 10)");
    expect(rows("expenses")[0]).toMatchObject({ amount_cents: 5650, tax_cents: 650, booking_id: SMITH_FENCE, created_by: P_OWNER, receipt_path: rows("receipt_texts")[0].file_path });
    expect(rows("receipt_texts")[0]).toMatchObject({ status: "filed", expense_id: rows("expenses")[0].id });
  });

  it("PNG screenshots are stored as a PDF; PDFs are kept as is; webp is filed without a copy", async () => {
    await text("fuel", [mediaUrl("esso"), mediaUrl("pdf")]);
    expect(rows("expenses")).toHaveLength(2);
    expect(uploads.map((u) => u.type)).toEqual(["application/pdf", "application/pdf"]);
    expect(Buffer.from(uploads[0].bytes).subarray(0, 5).toString()).toBe("%PDF-");
    expect(rows("expenses")[0]).toMatchObject({ vendor: "Esso", category: "fuel", receipt_type: "application/pdf" });
    // "fuel" applies to both (one clear category word)
    expect(rows("expenses")[1]).toMatchObject({ vendor: "Rona Pro", spent_on: "2026-10-14", category: "fuel" });
    expect(replies().at(-1)).toMatch(/^.*Got 2 receipts: Esso \$60 \(HST \$6\.90\), Fuel; Rona Pro \$226 \(HST \$26\), Fuel\. Dated today \(couldn't read the date\)\. Reply "fix" to change the last one\.$/);
    await text("", [mediaUrl("webp")]);
    expect(rows("expenses")[2]).toMatchObject({ vendor: "Tim Hortons", receipt_path: null });
    expect(replies().at(-1)).toContain("couldn't keep a copy of that picture type");
  });

  it("no reader (ANTHROPIC_API_KEY unset): a bare picture passes; 'receipt' in the words keeps it to finish", async () => {
    readerOn = false;
    await text("", [mediaUrl("depot")]);
    expect(replies().at(-1)).toContain("Got the picture");
    await text("receipt for Jones", [mediaUrl("depot")]);
    expect(rows("receipt_texts").map((r) => r.status)).toEqual(["not_receipt", "needs_review"]);
    expect(replies().at(-1)).toContain("couldn't read the total");
  });

  it("idempotent per owner_command_log id: a redelivered text files nothing again and gets the same reply", async () => {
    const first = await handleReceiptMedia(db.client, input("", ["depot"]));
    const again = await handleReceiptMedia(db.client, input("", ["depot"]));
    expect(again?.reply).toBe(first?.reply);
    expect(rows("expenses")).toHaveLength(1);
    expect(rows("receipt_texts")).toHaveLength(1);
  });

  it("ambiguous job: filed without a job and the owner is asked which", async () => {
    db.tables.contacts.push({ id: "c0000000-0000-4000-8000-000000000003", organization_id: ORG, company_id: CO, first_name: "Pat", last_name: "Jones" });
    db.tables.bookings.push({ id: "b0000000-0000-4000-8000-000000000003", organization_id: ORG, company_id: CO, contact_id: "c0000000-0000-4000-8000-000000000003", title: "Eavestrough", scheduled_for: "2026-10-16T13:00:00Z", status: "confirmed" });
    const out = await handleReceiptMedia(db.client, input("Jones", ["depot"]));
    expect(rows("expenses")[0].booking_id).toBeNull();
    expect(out?.reply).toContain("Which job: Jones Roof repair (Oct 14) or Jones Eavestrough (Oct 16)?");
  });

  it("composeReply keeps it to one text", () => {
    const line = "X".repeat(300);
    const filed = [1, 2, 3].map(() => ({ row: { status: "filed" } as never, line, notes: [] }));
    expect(composeReply(filed, 0).length).toBeLessThanOrEqual(600);
  });
});

describe("fix_receipt / receipts_summary", () => {
  it("changes category, job and paid-with; with nothing to change it says what's on file", async () => {
    await handleReceiptMedia(db.client, input("", ["depot"]));
    const shown = await runOwnerTool(ownerState(), "fix_receipt", {});
    expect(String(shown.tell_owner)).toContain("Last receipt: Home Depot $84.20 (HST $9.69) on Oct 14, Materials, no job.");
    const fixed = await runOwnerTool(ownerState(), "fix_receipt", { category: "tools", job: "Dana Jones", paid_with: "personal", po: "po 9" });
    expect(String(fixed.tell_owner)).toBe("Fixed: Home Depot $84.20 (HST $9.69) on Oct 14, Tools, Jones Roof repair (Oct 14), your own card, PO-9.");
    expect(rows("expenses")[0]).toMatchObject({ category: "tools", booking_id: JONES_ROOF, paid_with: "personal" });
    expect(rows("receipt_texts")[0].po_reference).toBe("PO-9");
    expect(await runOwnerTool(ownerState(), "fix_receipt", { amount: "$5", tax: "$9" })).toMatchObject({ error: "The HST can't be more than the total." });
  });

  it("delete within 24 h; not after", async () => {
    await handleReceiptMedia(db.client, input("", ["depot"]));
    expect(await runOwnerTool(ownerState(NOW + 25 * HOUR), "fix_receipt", { delete: true })).toMatchObject({ error: expect.stringContaining("more than a day old") });
    const out = await runOwnerTool(ownerState(NOW + HOUR), "fix_receipt", { delete: true });
    expect(out).toMatchObject({ ok: true, tell_owner: "Deleted: Home Depot $84.20." });
    expect(rows("expenses")).toHaveLength(0);
    expect(rows("receipt_texts")[0].status).toBe("deleted");
    expect(removed).toHaveLength(1);
  });

  it("receipts_summary: this month by category, what's missing", async () => {
    await handleReceiptMedia(db.client, input("", ["depot"]));
    db.tables.expenses.push({ id: "x1", organization_id: ORG, company_id: CO, booking_id: null, spent_on: "2026-10-02", vendor: "Shell", category: "fuel", amount_cents: 5650, tax_cents: 650, paid_with: "business", receipt_path: null, created_by: P_OWNER, reimbursed_at: null });
    const out = await runOwnerTool(ownerState(), "receipts_summary", {});
    expect(out).toMatchObject({ ok: true, month: "October", count: 2, total: "$140.70", hst_paid: "$16.19", without_a_receipt: 1 });
    expect(String(out.tell_owner)).toContain("1 materials buy with no job.");
  });
});

// ── HST ───────────────────────────────────────────────────────────────────────

describe("HST periods and due dates", () => {
  const q = { frequency: "quarterly" as const, fiscalYearEndMonth: 12, filer: "corporation" as const };
  it("quarterly from a Dec 31 year end: Q3 is Jul-Sep, due Oct 31", () => {
    expect(periodContaining("2026-08-15", q)).toMatchObject({ start: "2026-07-01", end: "2026-09-30", label: "Q3", dueDate: "2026-10-31", paymentDueDate: "2026-10-31", range: "Jul 1 - Sep 30, 2026" });
    expect(lastEndedPeriod("2026-10-14", q)).toMatchObject({ label: "Q3", start: "2026-07-01" });
    expect(periodContaining("2026-12-31", q)).toMatchObject({ label: "Q4", dueDate: "2027-01-31" });
  });
  it("quarterly from a Mar 31 year end: Q1 is Apr-Jun", () => {
    expect(periodContaining("2026-05-01", { ...q, fiscalYearEndMonth: 3 })).toMatchObject({ start: "2026-04-01", end: "2026-06-30", label: "Q1", dueDate: "2026-07-31" });
    expect(periodContaining("2027-02-01", { ...q, fiscalYearEndMonth: 3 })).toMatchObject({ start: "2027-01-01", end: "2027-03-31", label: "Q4" });
  });
  it("monthly: due at the end of the next month", () => {
    expect(periodContaining("2026-02-10", { ...q, frequency: "monthly" })).toMatchObject({ start: "2026-02-01", end: "2026-02-28", label: "Feb", dueDate: "2026-03-31" });
  });
  it("annual: individuals with a Dec 31 year end pay Apr 30, file Jun 15; others 3 months after", () => {
    expect(periodContaining("2026-06-01", { frequency: "annual", fiscalYearEndMonth: 12, filer: "individual" })).toMatchObject({ start: "2026-01-01", end: "2026-12-31", label: "2026", dueDate: "2027-06-15", paymentDueDate: "2027-04-30" });
    expect(periodContaining("2026-06-01", { frequency: "annual", fiscalYearEndMonth: 12, filer: "corporation" })).toMatchObject({ dueDate: "2027-03-31", paymentDueDate: "2027-03-31" });
    expect(periodContaining("2026-06-01", { frequency: "annual", fiscalYearEndMonth: 6, filer: "individual" })).toMatchObject({ start: "2025-07-01", end: "2026-06-30", label: "FY2026", dueDate: "2026-09-30" });
  });
});

// Q3 2026 records (Jul 1 - Sep 30).
function seedQ3() {
  const inv = (id: string, over: Record<string, unknown>) => ({
    id, organization_id: ORG, company_id: CO, invoice_number: id, status: "sent", issue_date: "2026-08-01", subtotal_cents: 0, tax_cents: 0, total_cents: 0,
    credit_cents: 0, amount_paid_cents: 0, balance_due_cents: 0, bill_to: { name: "Dana Jones" }, title: null, imported_at: null, ...over,
  });
  db.tables.invoices.push(
    inv("INV-1", { subtotal_cents: 100000, tax_cents: 13000, total_cents: 113000, balance_due_cents: 113000 }),
    inv("INV-2", { status: "paid", issue_date: "2026-09-15", subtotal_cents: 50000, tax_cents: 6500, total_cents: 56500, credit_cents: 10000, amount_paid_cents: 46500 }),
    inv("INV-3", { status: "draft", issue_date: "2026-08-10", subtotal_cents: 99999, tax_cents: 13000 }),
    inv("INV-4", { status: "void", subtotal_cents: 70000, tax_cents: 9100 }),
    inv("OLD-1", { issue_date: "2026-07-05", subtotal_cents: 20000, tax_cents: 2600, imported_at: "2026-09-01T00:00:00Z" }),
    inv("CN-1", { issue_date: "2026-09-20", subtotal_cents: -10000, tax_cents: -1300, total_cents: -11300 }),
    inv("INV-5", { issue_date: "2026-10-02", subtotal_cents: 40000, tax_cents: 5200 }),
  );
  const exp = (id: string, over: Record<string, unknown>) => ({
    id, organization_id: ORG, company_id: CO, booking_id: null, spent_on: "2026-08-03", vendor: "Home Depot", description: null, category: "materials",
    amount_cents: 26100, tax_cents: 3000, paid_with: "business", receipt_path: `${ORG}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg`, receipt_type: "image/jpeg", created_by: P_OWNER, created_at: "2026-08-03T12:00:00Z", ...over,
  });
  db.tables.expenses.push(
    exp("e1", {}),
    exp("e2", { spent_on: "2026-09-02", vendor: "Swiss Chalet", category: "meals", amount_cents: 8700, tax_cents: 1000, receipt_path: null, receipt_type: null }),
    exp("e3", { spent_on: "2026-10-05", vendor: "Shell", category: "fuel", tax_cents: 700 }),
    exp("e4", { spent_on: "2026-07-10", category: "materials", amount_cents: 1740, tax_cents: 200, paid_with: "personal", booking_id: JONES_ROOF, receipt_path: null, receipt_type: null }),
  );
}

describe("the worksheet", () => {
  it("lines 101/103/106/109: issued invoices only (no draft / void / imported), credit notes lower it, meals at 50%", () => {
    seedQ3();
    const w = computeWorksheet(db.tables.invoices as never, db.tables.expenses as never, { start: "2026-07-01", end: "2026-09-30" });
    expect(w).toEqual({
      salesCents: 140000, collectedCents: 18200, itcCents: 3700, netCents: 14500, invoiceCount: 3, creditNoteCount: 1, importedExcluded: 1,
      lateItcCents: 0, lateExpenseCount: 0, expenseCount: 3, mealsDisallowedCents: 500, missingReceipts: 2,
    });
    const period = lastEndedPeriod("2026-10-21", { frequency: "quarterly", fiscalYearEndMonth: 12, filer: "corporation" }) as HstPeriod;
    expect(reminderText(period, w, 2026)).toBe("Q3 HST: collected $182, ITCs $37, owing about $145. Due Oct 31.");
    expect(reminderText(period, { ...w, netCents: -1200 }, 2026)).toContain("refund about $12.");
  });

  it("CSV files: receipt links, ITC claimed, formula-safe cells", () => {
    seedQ3();
    const csv = expensesCsv(db.tables.expenses.slice(0, 2) as never, new Map(), new Map([[`${ORG}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg`, "https://signed.test/r1"]]));
    expect(csv.split("\r\n")[0]).toBe("Date,Vendor,Description,Category,Total,HST,ITC claimed,Before tax,Job,Paid with,Receipt link,Claimed late (from)");
    expect(csv).toContain("2026-08-03,Home Depot,,Materials & supplies,261.00,30.00,30.00,231.00,,Business,https://signed.test/r1,");
    expect(csv).toContain("2026-09-02,Swiss Chalet,,Meals,87.00,10.00,5.00,77.00,,Business,No receipt,");
    const inv = invoicesCsv([{ ...(db.tables.invoices[0] as Record<string, unknown>), bill_to: { name: "=HYPERLINK(1)" } } as never]);
    expect(inv).toContain("'=HYPERLINK(1)");
    const credit = invoicesCsv([db.tables.invoices.find((i) => i.id === "CN-1") as never]);
    expect(credit).toContain("CN-1,2026-09-20,Dana Jones,credit note,-100.00,-13.00,-113.00,");
    expect(credit).not.toContain("'-");
  });
});

// Thu Oct 21 2026, 10:00 Toronto: 10 days before Q3's Oct 31 due date.
const REMIND = Date.parse("2026-10-21T14:00:00Z");

describe("the HST reminder and the accountant packet", () => {
  async function dfyCompany() {
    return (await loadTaxClerkCompany(db.client, ORG, CO))!;
  }

  it("only inside the 10-day window, daytime, registrants with reminders on", async () => {
    const c = await dfyCompany();
    expect(periodToRemind("2026-10-20", c)).toBeNull();
    expect(periodToRemind("2026-10-21", c)?.label).toBe("Q3");
    expect(periodToRemind("2026-10-31", c)?.label).toBe("Q3");
    expect(periodToRemind("2026-11-01", c)).toBeNull();
    expect(await runCompanyHstReminder(db.client, c, Date.parse("2026-10-21T11:00:00Z"))).toBe("not_due"); // 07:00 local
    db.tables.companies[0].tax_registration_number = null;
    expect(await runCompanyHstReminder(db.client, await dfyCompany(), REMIND)).toBe("off");
    expect(rows("hst_periods")).toHaveLength(0);
  });

  it("E2E: the reminder asks accountant_packet; Y through decideApproval emails the packet once", async () => {
    seedQ3();
    db.tables.companies[0].ai_settings = mergeTaxClerkSettings({}, { hst: { accountantEmail: "books@acct.ca" } });
    expect(await runCompanyHstReminder(db.client, await dfyCompany(), REMIND)).toBe("asked");
    expect(await runCompanyHstReminder(db.client, await dfyCompany(), REMIND + HOUR)).toBe("claimed_elsewhere");
    const approval = rows("owner_approvals")[0];
    expect(approval).toMatchObject({ kind: "accountant_packet", status: "pending", requested_by: "tax_clerk" });
    expect(approval.payload).toMatchObject({ periodStart: "2026-07-01", periodEnd: "2026-09-30", label: "Q3", to: "books@acct.ca", toWho: "accountant" });
    const owner = replies().at(-1)!;
    expect(owner).toContain(
      `#${approval.short_code} Q3 HST: collected $182, ITCs $37, owing about $145. Due Oct 31. Prepared figures - you or your accountant file the return. Y emails the Q3 packet to books@acct.ca. Text 'hst' for the breakdown. Reply Y ${approval.short_code} to email it, N ${approval.short_code} to skip.`,
    );
    expect(rows("hst_periods")[0]).toMatchObject({ status: "reminded", approval_id: approval.id, figures: { collectedCents: 18200, itcCents: 3700, netCents: 14500 } });

    const out = await decideApproval(db.client, String(approval.id), { approved: true, decidedVia: "sms", decidedBy: OWNER }, { organizationId: ORG, nowMs: REMIND + HOUR });
    expect(out.message).toBe("Emailed the Q3 HST packet to books@acct.ca: $182 collected, $37 ITCs, owing about $145. Prepared figures - you or your accountant file the return.");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0] as { to: string; subject: string; body: string; fromName: string; replyTo: string; attachments: Array<{ filename: string; content: string }> };
    expect(mail).toMatchObject({ to: "books@acct.ca", fromName: "Northshore Roofing", replyTo: "dana@northshore.test", subject: "Q3 HST packet: Jul 1 - Sep 30, 2026 (Northshore Roofing)" });
    expect(mail.body).toContain("Line 101 sales and other revenue: $1,400");
    expect(mail.body).toContain("Line 109 net tax: $145 (owing about $145)");
    expect(mail.body).toContain("Prepared figures - you or your accountant file the return.");
    expect(mail.attachments.map((a) => a.filename)).toEqual([
      "hst-summary-northshore-roofing-2026-07-01-to-2026-09-30.pdf",
      "expenses-northshore-roofing-2026-07-01-to-2026-09-30.csv",
      "invoices-northshore-roofing-2026-07-01-to-2026-09-30.csv",
    ]);
    expect(Buffer.from(mail.attachments[0].content, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    const expCsv = Buffer.from(mail.attachments[1].content, "base64").toString();
    expect(expCsv).toContain(`https://signed.test/${ORG}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg?ttl=30d`);
    expect(expCsv).toContain("Roof repair");
    expect(expCsv).not.toContain("Shell"); // October: next quarter
    const invCsv = Buffer.from(mail.attachments[2].content, "base64").toString();
    expect(invCsv).toContain("INV-1");
    expect(invCsv).toContain("credit note");
    expect(invCsv).not.toContain("OLD-1");
    expect(invCsv).not.toContain("INV-3");
    expect(rows("hst_periods")[0]).toMatchObject({ packet_emailed_to: "books@acct.ca" });
    expect(rows("owner_approvals")[0].status).toBe("executed");

    const again = await decideApproval(db.client, String(approval.id), { approved: true, decidedVia: "sms", decidedBy: OWNER });
    expect(again.outcome).toBe("already");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("no accountant email: the packet goes to the owner; N sends nothing; expiry sends nothing", async () => {
    seedQ3();
    await runCompanyHstReminder(db.client, await dfyCompany(), REMIND);
    expect(rows("owner_approvals")[0].payload).toMatchObject({ to: "dana@northshore.test", toWho: "owner" });
    const no = await decideApproval(db.client, String(rows("owner_approvals")[0].id), { approved: false, decidedVia: "sms", decidedBy: OWNER });
    expect(no.message).toBe('OK, not sent. Text "hst packet" when you want it.');
    expect(sendEmail).not.toHaveBeenCalled();

    const asked = await runOwnerTool(ownerState(REMIND), "send_hst_packet", {});
    expect(String(asked.tell_owner_exactly)).toMatch(/^#\d+ Email the Q3 HST packet \(Jul 1 - Sep 30, 2026\) to dana@northshore\.test: .* Reply Y \d+ to email it, N \d+ to skip\.$/);
    const pending = rows("owner_approvals").at(-1)!;
    expect(pending.notified_to).toBe(OWNER);
    const expired = await expireApproval(db.client, { ...(pending as Record<string, unknown>), expires_at: new Date(REMIND - 1).toISOString() } as never, REMIND + 10 * DAY);
    expect(expired.outcome).toBe("expired");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a note on the Y is never guessed at; an email the owner typed is used as given", async () => {
    seedQ3();
    const asked = await runOwnerTool(ownerState(REMIND), "send_hst_packet", { email: "Pat@Books.ca" });
    expect(String(asked.tell_owner_exactly)).toContain("to pat@books.ca:");
    const id = String(rows("owner_approvals")[0].id);
    const noted = await decideApproval(db.client, id, { approved: true, ownerNote: "to my wife", decidedVia: "sms", decidedBy: OWNER });
    expect(noted.result?.ok).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await runOwnerTool(ownerState(REMIND), "send_hst_packet", { email: "not an email" })).toMatchObject({ error: "That email doesn't look right." });
  });

  it("hst_summary: the breakdown with CRA lines and the disclaimer", async () => {
    seedQ3();
    const out = await runOwnerTool(ownerState(REMIND), "hst_summary", {});
    expect(String(out.tell_owner)).toBe(
      "Q3 HST (Jul 1 - Sep 30, 2026): 101 sales $1,400 103 HST collected $182 106 ITCs $37 109 net $145 (owing about $145). Due Oct 31. Notes: 2 expenses without a receipt, 1 imported invoice left out, meals at 50%. Prepared figures - you or your accountant file the return.",
    );
    const after = await runOwnerTool(ownerState(Date.parse("2026-11-03T15:00:00Z")), "hst_summary", {});
    expect(String(after.tell_owner)).toContain("Q4 HST (Oct 1 - Dec 31, 2026, so far)");
  });

  it("briefing items: 'Q3 HST due in 10 days (about $145)' inside the window only; house orgs get nothing", async () => {
    seedQ3();
    expect(await briefingItems(db.client, { organizationId: ORG, companyId: CO }, "2026-10-21")).toEqual(["Q3 HST due in 10 days (about $145)"]);
    expect(await briefingItems(db.client, { organizationId: ORG, companyId: CO }, "2026-10-31")).toEqual(["Q3 HST due today (about $145)"]);
    expect(await briefingItems(db.client, { organizationId: ORG, companyId: CO }, "2026-10-14")).toEqual([]);
    expect(await briefingItems(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO }, "2026-10-21")).toEqual([]);
  });

  it("the sweep: done-for-you registrants only, once", async () => {
    seedQ3();
    const sweep = TAX_CLERK_SWEEPS[0];
    await sweep.run(db.client, REMIND);
    resetTaxClerkCompanyCache();
    await sweep.run(db.client, REMIND + 20 * 60_000);
    expect(rows("owner_approvals")).toHaveLength(1);
    expect(rows("hst_periods").map((r) => r.company_id)).toEqual([CO]);
  });

  it("no email anywhere: a plain reminder text", async () => {
    seedQ3();
    db.tables.companies[0].owner_email = null;
    db.tables.profiles = [];
    const sent: string[] = [];
    const out = await runCompanyHstReminder(db.client, await dfyCompany(), REMIND, { ...defaultReminderDeps, sendOwnerSms: async (_a, i) => (sent.push(i.body), { status: "sent" }) });
    expect(out).toBe("texted");
    expect(sent[0]).toContain("Q3 HST: collected $182, ITCs $37, owing about $145. Due Oct 31. Prepared figures");
    expect(rows("owner_approvals")).toHaveLength(0);
  });
});

// ── Nudges ────────────────────────────────────────────────────────────────────

describe("nudges", () => {
  const MONDAY = Date.parse("2026-10-19T14:00:00Z"); // Mon 10:00 local
  const sender = () => {
    const sent: string[] = [];
    return { sent, deps: { sendOwnerSms: async (_a: unknown, i: { body: string }) => (sent.push(i.body), { status: "sent" as const }) } };
  };

  it("weekly: Monday morning, only when something's missing, once", async () => {
    const c = (await loadTaxClerkCompany(db.client, ORG, CO))!;
    const s = sender();
    expect(await runCompanyWeeklyNudge(db.client, c, MONDAY, s.deps)).toBe("nothing");
    expect(s.sent).toHaveLength(0);
    db.tables.tax_clerk_notices = [];
    db.tables.expenses.push({ id: "n1", organization_id: ORG, company_id: CO, booking_id: null, spent_on: "2026-10-10", category: "materials", receipt_path: null });
    expect(await runCompanyWeeklyNudge(db.client, c, MONDAY + DAY, s.deps)).toBe("not_due"); // Tuesday
    expect(await runCompanyWeeklyNudge(db.client, c, MONDAY, s.deps)).toBe("sent");
    expect(s.sent[0]).toBe('Receipts check (last 30 days): 1 expense has no receipt and 1 materials buy has no job. Text me a photo of any receipt, or "receipts" for the list.');
    expect(await runCompanyWeeklyNudge(db.client, c, MONDAY + HOUR, s.deps)).toBe("claimed_elsewhere");
    expect(weeklyNudgeText({ noReceipt: 0, noJob: 0, toFinish: 2 })).toBe('Receipts check: 2 receipt pictures still need their total. Text me a photo of any receipt, or "receipts" for the list.');
  });

  it("tip: once, a day after the Tax Clerk first sees the company, weekday daytime, not if receipts already came in", async () => {
    const c = (await loadTaxClerkCompany(db.client, ORG, CO))!;
    const s = sender();
    expect(await runCompanyTip(db.client, c, NOW, s.deps)).toBe("not_due");
    expect(rows("tax_clerk_notices")[0]).toMatchObject({ kind: "first_seen" });
    expect(await runCompanyTip(db.client, c, NOW + HOUR, s.deps)).toBe("not_due");
    expect(await runCompanyTip(db.client, c, NOW + DAY, s.deps)).toBe("sent");
    expect(s.sent).toEqual([TIP_TEXT]);
    expect(await runCompanyTip(db.client, c, NOW + 2 * DAY, s.deps)).toBe("not_due");
    // A house org is never offered it (not loaded by the sweep, and receipts are off).
    const house = (await loadTaxClerkCompany(db.client, HOUSE_ORG, HOUSE_CO))!;
    expect(await runCompanyTip(db.client, house, NOW + DAY, s.deps)).toBe("not_due");
  });
});

// ── Settings view ─────────────────────────────────────────────────────────────

describe("settings view", () => {
  it("members see the switches only; owners/admins get figures, pictures to finish and can file or discard them", async () => {
    seedQ3();
    db.tables.companies[0].ai_settings = mergeTaxClerkSettings({}, { hst: { accountantEmail: "books@acct.ca" } });
    await handleReceiptMedia(db.client, input("", ["blurry"]));
    await handleReceiptMedia(db.client, input("", ["blurry"], "e0000000-0000-4000-8000-000000000002"));
    const deps = { storage: testDeps.storage!, packet: { storage: testDeps.storage!, sendEmail: (i: never) => sendEmail(i), orgOwnerEmail: async () => null } };
    const member = await getTaxClerkView(db.client, ORG, CO, { manage: false, nowMs: REMIND }, deps as never);
    expect(member).toMatchObject({ hst: null, toFinish: null, settings: { hst: { accountantEmail: null } } });
    const view = (await getTaxClerkView(db.client, ORG, CO, { manage: true, nowMs: REMIND }, deps as never))!;
    expect(view.hst).toMatchObject({ period: { label: "Q3", toDate: false }, salesCents: 140000, netCents: 14500, packet: { sendsTo: "books@acct.ca" } });
    expect(view.toFinish).toHaveLength(2);
    const [a, b] = view.toFinish!;
    expect(await finishReceipt(db.client, { organizationId: ORG, companyId: CO }, P_OWNER, { id: a.id, action: "file", amountCents: 4520, taxCents: 520, spentOn: "2026-10-13" }, NOW, deps as never)).toMatchObject({ status: "filed" });
    expect(rows("expenses").at(-1)).toMatchObject({ amount_cents: 4520, vendor: "Rona", created_by: P_OWNER, company_id: CO });
    expect(await finishReceipt(db.client, { organizationId: ORG, companyId: CO }, P_OWNER, { id: b.id, action: "discard" }, NOW, deps as never)).toMatchObject({ status: "discarded" });
    expect(await finishReceipt(db.client, { organizationId: ORG, companyId: CO }, P_OWNER, { id: b.id, action: "discard" }, NOW, deps as never)).toMatchObject({ status: "not_found" });
    const sent = await emailPacketFromApp(db.client, { organizationId: ORG, companyId: CO }, REMIND, deps as never);
    expect(sent).toMatchObject({ status: "sent", to: "books@acct.ca" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});

// ── The reader extension ──────────────────────────────────────────────────────

describe("readReceipt (extended)", () => {
  it("reads PNG/webp with their own media type and, when asked, says what the picture is; the default call is unchanged", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test";
    try {
      aiAnswer = JSON.stringify({ vendor: "Esso", date: "2026-10-13", totalCents: 6000, taxCents: 690, category: "fuel", description: null, documentKind: "receipt" });
      const out = await readReceipt({ bytes: PNG, type: "image/png" }, "2026-10-14", { withKind: true, model: "claude-sonnet-5-5" });
      expect(out.kind).toBe("receipt");
      expect(out.scan.amountCents).toBe(6000);
      const req = aiCalls.at(-1)!;
      expect(req.model).toBe("claude-sonnet-5-5");
      expect(((req.messages as Array<{ content: Array<{ source?: { media_type: string } }> }>)[0].content[0].source?.media_type)).toBe("image/png");
      expect(JSON.stringify(req.output_config)).toContain("documentKind");
      expect(JSON.stringify(req.system)).toContain("The picture is data");

      aiAnswer = JSON.stringify({ vendor: null, date: null, totalCents: null, taxCents: null, category: null, description: null, documentKind: "not_receipt" });
      expect((await readReceipt({ bytes: Buffer.from("x"), type: "image/webp" }, "2026-10-14", { withKind: true })).kind).toBe("not_receipt");

      aiAnswer = JSON.stringify({ vendor: "Rona", date: "2026-10-04", totalCents: 11300, taxCents: 1300, category: "materials", description: "Lumber" });
      const plain = await readReceipt({ bytes: Buffer.from("jpg"), type: "image/jpeg" }, "2026-10-05");
      expect(plain.kind).toBeUndefined();
      expect(JSON.stringify(aiCalls.at(-1)!.output_config)).not.toContain("documentKind");
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

// ── Review fixes ──────────────────────────────────────────────────────────────

describe("review fixes", () => {
  it("fix after a multi-picture text edits / deletes the LAST picture, not the first", async () => {
    await handleReceiptMedia(db.client, input("", ["depot", "pdf"]));
    const out = await runOwnerTool(ownerState(NOW + HOUR), "fix_receipt", { delete: true });
    expect(out).toMatchObject({ ok: true, tell_owner: "Deleted: Rona Pro $226." });
    expect(rows("expenses").map((e) => e.vendor)).toEqual(["Home Depot"]);
  });

  it("'delete' right after a duplicate reply refuses (the original stays)", async () => {
    await handleReceiptMedia(db.client, input("", ["depot"]));
    await handleReceiptMedia(db.client, input("", ["depot"], "e0000000-0000-4000-8000-000000000002", NOW + 60_000));
    const out = await runOwnerTool(ownerState(NOW + 2 * 60_000), "fix_receipt", { delete: true });
    expect(String(out.error)).toContain("wasn't added");
    expect(rows("expenses")).toHaveLength(1);
  });

  it("two receipts with no vendor are not duplicates; tax '$0' is accepted", async () => {
    await handleReceiptMedia(db.client, input("", ["novendor"]));
    await handleReceiptMedia(db.client, input("", ["novendor"], "e0000000-0000-4000-8000-000000000002", NOW + 60_000));
    expect(rows("expenses")).toHaveLength(2);
    const out = await runOwnerTool(ownerState(NOW + 2 * 60_000), "fix_receipt", { tax: "$0.00" });
    expect(out).toMatchObject({ ok: true });
    expect(rows("expenses")[1].tax_cents).toBe(0);
  });

  it("no reader: 'paid' alone doesn't claim a picture", async () => {
    readerOn = false;
    expect(await handleReceiptMedia(db.client, input("paid personal card", ["depot"]))).toBeNull();
    expect(await handleReceiptMedia(db.client, input("PO-12", ["depot"], "e0000000-0000-4000-8000-000000000002"))).not.toBeNull();
  });

  it("an owner with several businesses is told which one the receipt went to", async () => {
    db.tables.companies.push(company({ id: "22222222-2222-4222-8222-222222222299", name: "Northshore Snow" }));
    const out = await handleReceiptMedia(db.client, input("", ["depot"]));
    expect(out?.reply.startsWith("Northshore Roofing: Got it: Home Depot")).toBe(true);
  });

  it("a PO's job is loaded directly, even far from the receipt date", async () => {
    db.tables.bookings.push({ id: "b0000000-0000-4000-8000-000000000009", organization_id: ORG, company_id: CO, contact_id: SAM, title: "Deck", scheduled_for: "2027-03-01T14:00:00Z", status: "confirmed" });
    db.tables.purchase_orders = [{ id: "po-9", organization_id: ORG, company_id: CO, po_number: "PO-9", booking_id: "b0000000-0000-4000-8000-000000000009" }];
    const out = await handleReceiptMedia(db.client, input("PO-9", ["depot"]));
    expect(rows("expenses")[0].booking_id).toBe("b0000000-0000-4000-8000-000000000009");
    expect(out?.reply).toContain("Smith Deck (Mar 1)");
  });

  it("a receipt waiting for another reason (with its total) isn't called 'needs a total'", async () => {
    db.tables.receipt_texts.push({ id: "rt-x", organization_id: ORG, company_id: CO, status: "needs_review", amount_cents: 4520, missing: ["owner_profile"], created_at: "2026-10-14T12:00:00Z" });
    expect(await briefingItems(db.client, { organizationId: ORG, companyId: CO }, "2026-10-14")).toEqual(["1 texted receipt to finish in Settings"]);
    expect(weeklyNudgeText({ noReceipt: 0, noJob: 0, toFinish: 0, otherWaiting: 1 })).toContain("1 texted receipt is waiting in Settings");
  });

  it("a failed reminder text is retried with the same ask; a pass stuck in 'reminding' is retried", async () => {
    seedQ3();
    const c = (await loadTaxClerkCompany(db.client, ORG, CO))!;
    let ok = false;
    const deps = { ...defaultReminderDeps, approvals: { notify: async () => ({ notified: ok }) } };
    expect(await runCompanyHstReminder(db.client, c, REMIND, deps)).toBe("failed");
    expect(rows("hst_periods")[0]).toMatchObject({ status: "failed", attempts: 1 });
    expect(await runCompanyHstReminder(db.client, c, REMIND + 10 * 60_000, deps)).toBe("claimed_elsewhere");
    ok = true;
    expect(await runCompanyHstReminder(db.client, c, REMIND + 31 * 60_000, deps)).toBe("asked");
    expect(rows("owner_approvals")).toHaveLength(1);
    expect(rows("hst_periods")[0]).toMatchObject({ status: "reminded", attempts: 2 });

    rows("hst_periods")[0].status = "reminding";
    rows("hst_periods")[0].updated_at = new Date(REMIND).toISOString();
    expect(await runCompanyHstReminder(db.client, c, REMIND + 2 * HOUR, deps)).toBe("asked");
    expect(rows("owner_approvals")).toHaveLength(1);
  });

  it("a failed Monday nudge is retried", async () => {
    const c = (await loadTaxClerkCompany(db.client, ORG, CO))!;
    db.tables.expenses.push({ id: "n1", organization_id: ORG, company_id: CO, booking_id: null, spent_on: "2026-10-10", category: "materials", receipt_path: null });
    const MONDAY = Date.parse("2026-10-19T14:00:00Z");
    let status: "sent" | "failed" = "failed";
    const deps = { sendOwnerSms: async () => ({ status }) };
    expect(await runCompanyWeeklyNudge(db.client, c, MONDAY, deps)).toBe("failed");
    status = "sent";
    expect(await runCompanyWeeklyNudge(db.client, c, MONDAY + 15 * 60_000, deps)).toBe("sent");
    expect(await runCompanyWeeklyNudge(db.client, c, MONDAY + 30 * 60_000, deps)).toBe("claimed_elsewhere");
  });

  it("late receipts: an earlier period's receipt that came in after it closed is claimed in the next return (once)", async () => {
    seedQ3();
    const exp = (id: string, spent: string, created: string, tax: number) => ({
      id, organization_id: ORG, company_id: CO, booking_id: null, spent_on: spent, vendor: `V-${id}`, description: null, category: "materials",
      amount_cents: tax * 10, tax_cents: tax, paid_with: "business", receipt_path: null, receipt_type: null, created_by: P_OWNER, created_at: created,
    });
    db.tables.expenses.push(
      exp("late-q2", "2026-06-15", "2026-09-10T12:00:00Z", 500), // Q2 closed Aug 1 (due Jul 31): late → Q3
      exp("ontime-q2", "2026-06-20", "2026-07-10T12:00:00Z", 900), // came in before Q2 closed: Q2's own
    );
    const c = (await loadTaxClerkCompany(db.client, ORG, CO))!;
    const q3 = { start: "2026-07-01", end: "2026-09-30" };
    const w = await worksheetFor(db.client, c, q3);
    expect(w).toMatchObject({ itcCents: 4200, lateItcCents: 500, lateExpenseCount: 1, netCents: 14000 });
    const period = lastEndedPeriod("2026-10-21", c.settings.hst);
    expect(reminderText(period, w, 2026)).toBe("Q3 HST: collected $182, ITCs $42 (incl. $5 from earlier periods), owing about $140. Due Oct 31.");

    // The Q3 packet goes out; a Q3 receipt texted after that is next quarter's (late), not Q3's.
    db.tables.companies[0].ai_settings = mergeTaxClerkSettings({}, { hst: { accountantEmail: "books@acct.ca" } });
    await runCompanyHstReminder(db.client, c, REMIND);
    await decideApproval(db.client, String(rows("owner_approvals")[0].id), { approved: true, decidedVia: "sms", decidedBy: OWNER }, { organizationId: ORG, nowMs: REMIND + HOUR });
    const csv = Buffer.from((sendEmail.mock.calls[0][0] as { attachments: Array<{ content: string }> }).attachments[1].content, "base64").toString();
    expect(csv).toMatch(/V-late-q2,.*,Q2 2026\r\n/);
    rows("hst_periods")[0].packet_emailed_at = new Date(REMIND + HOUR).toISOString();
    db.tables.expenses.push(exp("late-q3", "2026-09-25", new Date(REMIND + 2 * HOUR).toISOString(), 300));
    expect((await worksheetFor(db.client, c, q3)).itcCents).toBe(4200);
    const q4 = await worksheetFor(db.client, c, { start: "2026-10-01", end: "2026-10-22" });
    expect(q4).toMatchObject({ lateItcCents: 300, lateExpenseCount: 1 });
  });
});
