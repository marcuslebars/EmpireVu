/**
 * Keep your number (docs/ai-staff.md → "Keep your number"), against the in-memory fake DB with the
 * real services underneath. Only the outside world is faked: the owner text (sendOwnerSms),
 * Supabase Storage (the PortingStorage seam) and Twilio (the provision client).
 */
import { randomBytes, randomUUID } from "node:crypto";

import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

const h = vi.hoisted(() => ({ db: null as unknown as { client: unknown }, twilio: null as unknown }));
const sendOwnerSms = vi.fn((..._a: unknown[]) => Promise.resolve({ status: "sent" as "sent" | "failed" | "blocked" }));
vi.mock("@/server/services/owner-channel/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/owner-channel/common")>();
  return { ...actual, sendOwnerSms: (...a: unknown[]) => sendOwnerSms(...a) };
});
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.db.client }));
// The Twilio numbers client every default path builds (markSubmitted's snapshot, the sweep).
vi.mock("@/server/services/twilio/provision", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/twilio/provision")>();
  return { ...actual, getTwilioCredentials: () => ({ accountSid: "AC1", authToken: "t" }), createTwilioNumbersClient: () => h.twilio };
});
vi.mock("@/server/services/rate-limit", () => ({
  enforceRateLimit: () => Promise.resolve(null),
  enforceWebhookBackstop: () => Promise.resolve(null),
  trustedClientIp: () => "203.0.113.9",
}));
vi.mock("@/server/outbound/sms", () => ({ sendSms: vi.fn(() => Promise.resolve({ sid: "SM1" })) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: vi.fn(), recordAiUsageSafe: vi.fn() }));

import { runConciergeAction } from "@/server/services/concierge/register-all";
import { getConciergeAction } from "@/server/services/concierge/actions";
import { roleOwnerTools, staffRoles } from "@/server/services/staff/registry";
import { portingRole } from "@/server/services/staff/porting";
import { decryptSecret, encryptSecret, portingKey } from "@/server/services/staff/porting/crypto";
import { attachBusinessLine, PURGE_AFTER_MS, sweepPortCompletions, sweepPortNotifications, sweepPortPurge } from "@/server/services/staff/porting/completion";
import { buildLoaPdf } from "@/server/services/staff/porting/loa";
import { listOperatorPorts } from "@/server/services/staff/porting/operator";
import { portingOwnerTools } from "@/server/services/staff/porting/owner-tools";
import {
  cancelPort,
  createBillUpload,
  getPortView,
  isPoBox,
  markRejected,
  markSubmitted,
  revealSecrets,
  setFocDate,
  startPort,
  submitPortForm,
} from "@/server/services/staff/porting/service";
import { mergePortingSettings, portingActiveFor, readPortingSettings } from "@/server/services/staff/porting/settings";
import { canTransition, ownerStatusText } from "@/server/services/staff/porting/status";
import type { PortingStorage } from "@/server/services/staff/porting/storage";
import type { TwilioIncomingNumber, TwilioNumbersClient } from "@/server/services/twilio/provision";
import { getPortingView, updatePortingSettings } from "@/server/services/staff/porting/view";
import type { ToolRunState } from "@/server/services/owner-channel/tools";
import { GET as publicGet, POST as publicPost } from "@/app/api/public/port/[token]/route";
import { ABANDON_AFTER_MS } from "@/server/services/staff/porting/completion";
import { twilioSideOk } from "@/server/services/staff/porting/guards";

const ORG = "11111111-1111-4111-8111-111111111111";
const CO = "22222222-2222-4222-8222-222222222222";
const HOUSE_ORG = "33333333-3333-4333-8333-333333333333";
const HOUSE_CO = "44444444-4444-4444-8444-444444444444";
const OTHER_CO = "55555555-5555-4555-8555-555555555555";
const OWNER = "+17055559999";
const LINE = "+17055550142";
const TZ = "America/Toronto";
/** Tue Oct 13 2026, 11:00 Toronto. */
const NOW = Date.parse("2026-10-13T15:00:00Z");
/** 23:00 Toronto (quiet hours). */
const NIGHT = Date.parse("2026-10-14T03:00:00Z");
const KEY = randomBytes(32).toString("base64");
const ACCOUNT = "123456789012";
const PIN = "4821";

let db: FakeDb;

class FakeStorage implements PortingStorage {
  files = new Map<string, Uint8Array>();
  removed: string[] = [];
  async createUploadUrl(path: string) {
    return { path, token: "upload-token" };
  }
  async exists(path: string) {
    return this.files.has(path);
  }
  async upload(path: string, bytes: Uint8Array) {
    this.files.set(path, bytes);
  }
  async signedUrl(path: string) {
    return `https://storage.test/${path}`;
  }
  async listFolder(folder: string) {
    return [...this.files.keys()].filter((p) => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes("/"));
  }
  async remove(paths: string[]) {
    for (const p of paths) {
      this.files.delete(p);
      this.removed.push(p);
    }
  }
}
let storage: FakeStorage;
const deps = () => ({ storage: () => storage });

function seed(extra: Record<string, Array<Record<string, unknown>>> = {}) {
  db = createFakeDb(
    {
      organizations: [
        { id: ORG, platform_brand: "crankleads", name: "Northshore" },
        { id: HOUSE_ORG, platform_brand: "empirevu", name: "A1" },
      ],
      companies: [
        {
          id: CO,
          organization_id: ORG,
          name: "Northshore Plumbing",
          timezone: TZ,
          owner_phone_e164: OWNER,
          owner_phone_verified_at: "2026-10-01T00:00:00Z",
          brand_reply_phone: "705-555-0142",
          business_phone_kind: "landline",
          business_phone_carrier: "Bell",
          ai_settings: {},
        },
        { id: HOUSE_CO, organization_id: HOUSE_ORG, name: "A1 Marine Care", timezone: TZ, owner_phone_e164: "+17055558888", owner_phone_verified_at: "2026-10-01T00:00:00Z", brand_reply_phone: "+17055557777", ai_settings: {} },
      ],
      voice_numbers: [{ id: "vn-catcher", organization_id: ORG, company_id: CO, phone_e164: "+17055550100", provider: "twilio", mode: "missed_call_catcher", active: true }],
      organization_memberships: [{ organization_id: ORG, profile_id: "p-1", role: "owner", phone_e164: null }],
      number_port_requests: [],
      operator_actions: [],
      crankleads_purchases: [],
      ...extra,
    },
    { number_port_requests: [["token"]], voice_numbers: [["phone_e164"]], business_line_calls: [["call_sid"]] },
  );
  h.db = db as unknown as { client: unknown };
}

const scope = { organizationId: ORG, companyId: CO };
const ports = () => db.tables.number_port_requests;
const texts = () => sendOwnerSms.mock.calls.map((c) => (c[1] as { body: string }).body);

beforeEach(() => {
  process.env.PORTING_ENCRYPTION_KEY = KEY;
  process.env.APP_BASE_URL = "https://app.test";
  process.env.CRANKLEADS_APP_BASE_URL = "https://app.crankleads.test";
  process.env.TWILIO_WEBHOOK_BASE_URL = "https://hooks.test";
  storage = new FakeStorage();
  h.twilio = fakeTwilio([]);
  delete process.env.PLATFORM_SMS_NUMBER;
  process.env.TWILIO_FROM_NUMBER = "+16475550000";
  sendOwnerSms.mockReset();
  sendOwnerSms.mockImplementation(() => Promise.resolve({ status: "sent" }));
  seed();
});

afterEach(() => {
  delete process.env.PORTING_ENCRYPTION_KEY;
  delete process.env.TWILIO_WEBHOOK_BASE_URL;
});

async function startedPort() {
  const result = await startPort(db.client, scope, { createdVia: "settings", nowMs: NOW }, deps());
  return result;
}

function validForm(over: Record<string, unknown> = {}) {
  return {
    numbers: ["(705) 555-0142"],
    carrier: "Bell",
    businessName: "Northshore Plumbing Inc",
    authorizedName: "Dana Smith",
    serviceAddress: { line1: "12 Bay St", line2: null, city: "Midland", province: "ON", postalCode: "l4r 1a1", country: "CA" },
    accountNumber: ACCOUNT,
    pin: PIN,
    billIsRecent: true,
    signature: { typedName: "dana smith", agree: true },
    ...over,
  };
}

async function readyPort() {
  const { port } = await startedPort();
  // Real rows have uuid ids (the concierge actions validate them).
  ports()[0].id = randomUUID();
  const upload = await createBillUpload(db.client, port.token, "image/jpeg", deps());
  storage.files.set(upload!.path, new Uint8Array([1, 2, 3]));
  await submitPortForm(db.client, port.token, validForm({ billPath: upload!.path, billContentType: "image/jpeg" }), { ip: "203.0.113.9", userAgent: "Mozilla/5.0 Test", nowMs: NOW }, deps());
  return ports()[0] as Record<string, unknown> & { id: string; token: string };
}

describe("encryption", () => {
  it("round-trips with AES-256-GCM, bound to the row id, and fails closed on the wrong key or row", () => {
    const key = portingKey()!;
    expect(key).toHaveLength(32);
    const enc = encryptSecret(ACCOUNT, "row-1", key);
    expect(enc).toMatch(/^v1\./);
    expect(enc).not.toContain(ACCOUNT);
    expect(decryptSecret(enc, "row-1", key)).toBe(ACCOUNT);
    expect(decryptSecret(enc, "row-2", key)).toBeNull();
    expect(decryptSecret(enc, "row-1", randomBytes(32))).toBeNull();
    expect(decryptSecret(enc.replace(/.$/, (c) => (c === "A" ? "B" : "A")), "row-1", key)).toBeNull();
  });

  it("no key or a key that isn't 32 bytes → no in-app collection", () => {
    expect(portingKey({})).toBeNull();
    expect(portingKey({ PORTING_ENCRYPTION_KEY: Buffer.from("short").toString("base64") })).toBeNull();
  });
});

describe("settings", () => {
  it("on for CrankLeads, off for house orgs; ring defaults 20 s, screened, owner only", () => {
    expect(readPortingSettings({}, { crankleads: true })).toMatchObject({ enabled: true, enabledIsDefault: true, ring: { enabled: true, seconds: 20, crew: false, screen: true } });
    expect(readPortingSettings({}, { crankleads: false }).enabled).toBe(false);
    expect(readPortingSettings({ porting: { ring: { seconds: 99 } } }, { crankleads: true }).ring.seconds).toBe(40);
  });

  it("merges only ai_settings.porting", () => {
    const next = mergePortingSettings({ sms_agent: { enabled: true }, porting: { ring: { crew: true } } }, { enabled: false, ring: { seconds: 15 } });
    expect(next).toEqual({ sms_agent: { enabled: true }, porting: { enabled: false, ring: { crew: true, seconds: 15 } } });
  });

  it("activeFor: CrankLeads on, house org off (no owner tools / notes for A1)", async () => {
    expect(await portingActiveFor(db.client, scope)).toBe(true);
    expect(await portingActiveFor(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO })).toBe(false);
    expect(portingRole.activeFor).toBe(portingActiveFor);
  });

  it("the settings view + PATCH (ring settings) never expose secrets", async () => {
    await readyPort();
    const view = await updatePortingSettings(db.client, scope, { ring: { seconds: 25, crew: true } });
    expect(view).toMatchObject({ enabled: true, ring: { seconds: 25, crew: true, screen: true }, businessLine: "(705) 555-0142", port: { status: "ready", ownerCanCancel: true } });
    expect(JSON.stringify(view)).not.toContain(ACCOUNT);
    expect(JSON.stringify(view)).not.toContain(PIN);
    expect((db.tables.companies[0].ai_settings as Record<string, unknown>).porting).toEqual({ ring: { seconds: 25, crew: true } });
  });
});

describe("status machine + owner texts", () => {
  it("only allowed moves", () => {
    expect(canTransition("collecting", "ready")).toBe(true);
    expect(canTransition("collecting", "submitted")).toBe(false);
    expect(canTransition("submitted", "completed")).toBe(true);
    expect(canTransition("completed", "cancelled")).toBe(false);
    expect(canTransition("rejected", "ready")).toBe(true);
  });

  it("the submit text carries both warnings; nothing carries account details", () => {
    const ctx = { link: "https://x/port/t", ringEnabled: true, ringSeconds: 20, answering: "ai" as const };
    const port = { numbers: [LINE], foc_date: "2026-10-20", rejection_reason: "Name doesn't match" };
    expect(ownerStatusText(port, "submitted", ctx)).toBe(
      "Your number move for (705) 555-0142 is in with the carrier (usually 5-7 business days). Don't cancel your old phone service - the move ends it for you. Your carrier may text you asking to approve the transfer: answer YES within 90 minutes or it gets rejected.",
    );
    expect(ownerStatusText(port, "foc_scheduled", ctx)).toContain("moves over on Tue, Oct 20");
    expect(ownerStatusText(port, "rejected", ctx)).toBe("Your carrier sent back the move for (705) 555-0142: Name doesn't match. Fix it here and we'll send it again: https://x/port/t");
    expect(ownerStatusText(port, "completed", ctx)).toBe(
      "Done: (705) 555-0142 now rings through us. Calls ring your cell first for 20 seconds (press 1 to take one), then your AI answers. You can turn call forwarding off now - it isn't needed any more.",
    );
    expect(ownerStatusText(port, "completed", { ...ctx, ringEnabled: false, answering: "voicemail" })).toContain("Calls go straight to voicemail, with a text back.");
  });
});

describe("starting a port", () => {
  it("settings start: one request with the business line, the owner texted the /port link", async () => {
    const result = await startedPort();
    expect(result.created).toBe(true);
    expect(result.texted).toBe(true);
    expect(result.url).toMatch(/^https:\/\/app\.crankleads\.test\/port\/[A-Za-z0-9_-]{32}$/);
    expect(ports()[0]).toMatchObject({ organization_id: ORG, company_id: CO, status: "collecting", numbers: [LINE], carrier: "Bell", created_via: "settings" });
    expect(sendOwnerSms).toHaveBeenCalledWith(db.client, expect.objectContaining({ to: OWNER, organizationId: ORG, companyId: CO, platformBrand: "crankleads" }));
    expect(texts()[0]).toBe(`Keep your number: to move (705) 555-0142 over we need a few details (about 5 minutes - have a recent phone bill handy): ${result.url} Your calls keep working the whole time.`);
    // Asking again returns the same request, no second text.
    const again = await startedPort();
    expect(again).toMatchObject({ created: false, url: result.url });
    expect(ports()).toHaveLength(1);
    expect(sendOwnerSms).toHaveBeenCalledTimes(1);
  });

  it("off for a house org unless an operator starts it", async () => {
    await expect(startPort(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO }, { createdVia: "settings", nowMs: NOW }, deps())).rejects.toThrow(/isn't switched on/);
    const op = await startPort(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO }, { createdVia: "operator", nowMs: NOW }, deps());
    expect(op.created).toBe(true);
  });

  it("owner tool start_number_port: the reply carries the link (no separate text); status tool", async () => {
    const [start, status] = portingOwnerTools();
    const state: ToolRunState = { admin: db.client, scope: { organizationId: ORG, companyId: CO, companyName: "Northshore Plumbing", timeZone: TZ } as ToolRunState["scope"], ownerPhone: OWNER, nowMs: NOW, confirmation: null, actions: [] };
    const res = await start.run(state, {});
    expect(res.ok).toBe(true);
    expect(String(res.tell_owner_exactly)).toMatch(/^Here's the form to move \(705\) 555-0142 over \(about 5 minutes - have a recent phone bill handy\): https:\/\/app\.crankleads\.test\/port\/\S+ Your calls keep working/);
    expect(sendOwnerSms).not.toHaveBeenCalled();
    expect(ports()[0]).toMatchObject({ created_via: "owner_text" });
    // Nothing owed: the reply was the text.
    expect(ports()[0].notify_status).toBeNull();
    const st = await status.run(state, {});
    expect(st).toMatchObject({ ok: true, port: { numbers: ["(705) 555-0142"], status: "Waiting for your details" } });
    // Registered with the staff registry.
    expect(roleOwnerTools().map((t) => t.tool.name)).toEqual(expect.arrayContaining(["start_number_port", "number_port_status"]));
    expect(staffRoles()).toContain(portingRole);
  });
});

describe("the owner's form (/port/:token)", () => {
  it("encrypts the account number + PIN, signs the LOA, moves to ready, texts the owner", async () => {
    const port = await readyPort();
    expect(port).toMatchObject({
      status: "ready",
      numbers: [LINE],
      authorized_name: "Dana Smith",
      business_name: "Northshore Plumbing Inc",
      service_address: { line1: "12 Bay St", city: "Midland", province: "ON", postalCode: "L4R 1A1", country: "CA" },
      account_number_last4: "9012",
      pin_status: "stored",
      loa_signed_name: "dana smith",
      loa_signed_ip: "203.0.113.9",
      loa_signed_user_agent: "Mozilla/5.0 Test",
      loa_signed_at: new Date(NOW).toISOString(),
    });
    // Ciphertext only, never the values (anywhere in the row).
    const row = JSON.stringify(port);
    expect(row).not.toContain(ACCOUNT);
    expect(row).not.toContain(`"${PIN}"`);
    expect(decryptSecret(String(port.account_number_enc), port.id, portingKey()!)).toBe(ACCOUNT);
    // The LOA PDF is in the request's own folder and doesn't hold the account number.
    const loa = storage.files.get(String(port.loa_path))!;
    expect(String(port.loa_path).startsWith(`${ORG}/${port.id}/loa-`)).toBe(true);
    expect(Buffer.from(loa).subarray(0, 5).toString()).toBe("%PDF-");
    expect(Buffer.from(loa).toString("latin1")).not.toContain(ACCOUNT);
    expect((await PDFDocument.load(loa)).getPageCount()).toBe(1);
    expect(port.loa_sha256).toMatch(/^[0-9a-f]{64}$/);
    // Owner: "Got it" (no secrets in any text).
    expect(texts().at(-1)).toBe("Got it - everything's in for moving (705) 555-0142. We'll send it to your carrier within 1 business day and text you when it's in.");
    for (const t of texts()) {
      expect(t).not.toContain(ACCOUNT);
      expect(t).not.toContain(PIN);
    }
    // The view never returns them either.
    const view = await getPortView(db.client, port.token);
    expect(view).toMatchObject({ status: "ready", accountOnFile: "ending 9012", pinStatus: "stored", billOnFile: true, editable: true });
    expect(JSON.stringify(view)).not.toContain(ACCOUNT);
  });

  it("refuses PO boxes, a signature that isn't the authorized name, and a bill from outside the folder", async () => {
    const { port } = await startedPort();
    const up = await createBillUpload(db.client, port.token, "application/pdf", deps());
    storage.files.set(up!.path, new Uint8Array([1]));
    const submit = (over: Record<string, unknown>) => submitPortForm(db.client, port.token, validForm({ billPath: up!.path, ...over }), { ip: null, userAgent: null, nowMs: NOW }, deps());
    await expect(submit({ serviceAddress: { line1: "PO Box 123", city: "Midland", province: "ON", postalCode: "L4R1A1", country: "CA" } })).rejects.toThrow(/not a PO box/);
    await expect(submit({ signature: { typedName: "Someone Else", agree: true } })).rejects.toThrow(/authorized person's name/);
    await expect(submit({ billPath: `${ORG}/other-port/bill-x.jpg` })).rejects.toThrow(/Upload the bill again/);
    await expect(submit({ billPath: null })).rejects.toThrow(/recent phone bill/);
    await expect(submit({ numbers: ["123"] })).rejects.toThrow(/10-digit/);
    expect(ports()[0].status).toBe("collecting");
    expect(isPoBox("P.O. Box 9")).toBe(true);
    expect(isPoBox("Case postale 12")).toBe(true);
    expect(isPoBox("12 Boxwood Cres")).toBe(false);
    expect(await createBillUpload(db.client, port.token, "text/html", deps()).catch((e: Error) => e.message)).toMatch(/photo/);
  });

  it("no encryption key → neither the account number nor the PIN is stored ('we'll call you')", async () => {
    delete process.env.PORTING_ENCRYPTION_KEY;
    const port = await readyPort();
    expect(port).toMatchObject({ status: "ready", account_number_enc: null, account_number_last4: null, pin_enc: null, pin_status: "call" });
    expect(JSON.stringify(port)).not.toContain(ACCOUNT);
    const view = await getPortView(db.client, port.token);
    expect(view?.collectsAccountDetails).toBe(false);
  });

  it("once it's with the carrier the link shows only the status; 30 days after it ends the link stops working", async () => {
    const port = await readyPort();
    await markSubmitted(db.client, scope, port.id, { twilioRequestId: "PX1", nowMs: NOW });
    const view = await getPortView(db.client, port.token, NOW);
    expect(view).toMatchObject({ status: "submitted", editable: false, authorizedName: null, serviceAddress: null, formBusinessName: null });
    await expect(submitPortForm(db.client, port.token, validForm(), { ip: null, userAgent: null, nowMs: NOW }, deps())).rejects.toThrow(/started sending this to your carrier/);
    Object.assign(ports()[0], { status: "completed", completed_at: new Date(NOW).toISOString() });
    expect(await getPortView(db.client, port.token, NOW + 29 * 86_400_000)).not.toBeNull();
    expect(await getPortView(db.client, port.token, NOW + 31 * 86_400_000)).toBeNull();
  });

  it("public route: GET the view, POST the form; bad tokens 404; secrets never echoed", async () => {
    const { port } = await startedPort();
    const up = await createBillUpload(db.client, port.token, "image/jpeg", deps());
    // The route uses the real storage seam: give the fake client a storage API.
    (db.client as unknown as Record<string, unknown>).storage = {
      from: () => ({
        list: () => Promise.resolve({ data: [{ name: up!.path.split("/").pop() }], error: null }),
        upload: () => Promise.resolve({ error: null }),
      }),
    };
    const ctx = { params: { token: port.token } };
    const got = await publicGet(new Request(`https://app.test/api/public/port/${port.token}`), ctx);
    expect(got.status).toBe(200);
    expect(((await got.json()) as { data: { status: string } }).data.status).toBe("collecting");
    const res = await publicPost(
      new Request(`https://app.test/api/public/port/${port.token}`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "Phone Safari" },
        body: JSON.stringify(validForm({ billPath: up!.path, billContentType: "image/jpeg" })),
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(ACCOUNT);
    expect(text).not.toContain(PIN);
    expect(ports()[0]).toMatchObject({ status: "ready", loa_signed_ip: "203.0.113.9", loa_signed_user_agent: "Phone Safari" });
    expect((await publicGet(new Request("https://app.test/api/public/port/nope"), { params: { token: "nope" } })).status).toBe(404);
    expect((await publicGet(new Request("https://app.test/x"), { params: { token: "a".repeat(32) } })).status).toBe(404);
  });
});

describe("operator steps", () => {
  it("submit → FOC → (rejected → fixed → ready) with an owner text at each, the 90-minute warning even at night", async () => {
    const port = await readyPort();
    sendOwnerSms.mockClear();
    await markSubmitted(db.client, scope, port.id, { twilioRequestId: "PX123", nowMs: NIGHT });
    expect(ports()[0]).toMatchObject({ status: "submitted", twilio_port_request_id: "PX123" });
    expect(texts()[0]).toContain("answer YES within 90 minutes");
    expect(texts()[0]).toContain("Don't cancel your old phone service");
    await setFocDate(db.client, scope, port.id, { focDate: "2026-10-20", nowMs: NOW });
    expect(ports()[0]).toMatchObject({ status: "foc_scheduled", foc_date: "2026-10-20" });
    expect(texts()[1]).toContain("moves over on Tue, Oct 20");
    // Same date again → no new text.
    await setFocDate(db.client, scope, port.id, { focDate: "2026-10-20", nowMs: NOW });
    expect(sendOwnerSms).toHaveBeenCalledTimes(2);
    await markRejected(db.client, scope, port.id, { reason: "Service address doesn't match", nowMs: NOW });
    expect(texts()[2]).toMatch(/^Your carrier sent back the move for \(705\) 555-0142: Service address doesn't match\. Fix it here and we'll send it again: https:\/\/app\.crankleads\.test\/port\//);
    // The owner fixes it on the same link → ready again.
    await submitPortForm(db.client, port.token, validForm({ accountNumber: null, pin: null }), { ip: null, userAgent: null, nowMs: NOW + 1000 }, deps());
    expect(ports()[0]).toMatchObject({ status: "ready", account_number_last4: "9012", pin_status: "stored" });
    await expect(markSubmitted(db.client, { organizationId: ORG, companyId: OTHER_CO }, port.id, { twilioRequestId: "PX9" })).rejects.toThrow(/isn't on this account/);
  });

  it("non-urgent texts wait out quiet hours; the notify sweep sends them once", async () => {
    const port = await readyPort();
    sendOwnerSms.mockClear();
    await markSubmitted(db.client, scope, port.id, { twilioRequestId: "PX1", nowMs: NOW });
    sendOwnerSms.mockClear();
    await markRejected(db.client, scope, port.id, { reason: "Wrong PIN", nowMs: NIGHT });
    expect(sendOwnerSms).not.toHaveBeenCalled();
    await sweepPortNotifications(db.client, NIGHT + 60_000);
    expect(sendOwnerSms).not.toHaveBeenCalled();
    await sweepPortNotifications(db.client, NOW + 86_400_000);
    await sweepPortNotifications(db.client, NOW + 86_400_000 + 60_000);
    expect(sendOwnerSms).toHaveBeenCalledTimes(1);
    expect(texts()[0]).toContain("Wrong PIN");
  });

  it("a failed owner text is retried by the notify sweep", async () => {
    const port = await readyPort();
    sendOwnerSms.mockClear();
    sendOwnerSms.mockImplementationOnce(() => Promise.resolve({ status: "failed" }));
    await markSubmitted(db.client, scope, port.id, { twilioRequestId: "PX1", nowMs: NOW });
    await sweepPortNotifications(db.client, NOW + 300_000);
    expect(sendOwnerSms).toHaveBeenCalledTimes(2);
    await sweepPortNotifications(db.client, NOW + 600_000);
    expect(sendOwnerSms).toHaveBeenCalledTimes(2);
  });

  it("the owner can cancel before it's submitted, not after", async () => {
    const port = await readyPort();
    await markSubmitted(db.client, scope, port.id, { twilioRequestId: "PX1", nowMs: NOW });
    await expect(cancelPort(db.client, scope, port.id, { by: "owner", nowMs: NOW })).rejects.toThrow(/already with the carrier/);
    await cancelPort(db.client, scope, port.id, { by: "operator", nowMs: NOW });
    expect(ports()[0]).toMatchObject({ status: "cancelled" });
    expect(texts().at(-1)).toBe("Your number move for (705) 555-0142 was cancelled. Nothing changes: your phone works as before.");
  });

  it("concierge: the queue shows masked details; reveal is audited without the values; status actions run", async () => {
    const port = await readyPort();
    const list = await listOperatorPorts(db.client, NOW);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "ready", companyName: "Northshore Plumbing", accountLast4: "9012", pinStatus: "stored", hasLoa: true, hasBill: true });
    const form = Object.fromEntries(list[0].twilioForm.map((f) => [f.label, f.value]));
    expect(form).toMatchObject({
      "Numbers to port": LINE,
      "Billing telephone number (BTN)": LINE,
      "Losing carrier": "Bell",
      "Authorized representative": "Dana Smith",
      "Service address - street": "12 Bay St",
      "Postal / ZIP code": "L4R 1A1",
      "Account number": "ending 9012 - reveal",
    });
    expect(JSON.stringify(list)).not.toContain(ACCOUNT);

    const operator = { email: "ops@crankleads.test", userId: "u-op" };
    const revealed = await runConciergeAction(db.client, operator, ORG, { action: "port_reveal_secrets", companyId: CO, input: { portId: port.id } }, NOW);
    expect(revealed.result).toEqual({ accountNumber: ACCOUNT, pin: PIN, pinStatus: "stored" });
    expect(revealed.message).not.toContain(ACCOUNT);
    const audit = db.tables.operator_actions;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ operator_email: "ops@crankleads.test", organization_id: ORG, company_id: CO, action: "port_reveal_secrets" });
    expect(JSON.stringify(audit)).not.toContain(ACCOUNT);
    expect(JSON.stringify(audit)).not.toContain(`"${PIN}"`);
    expect(audit[0].detail).toMatchObject({ status: "ok", portId: port.id, revealed: { accountNumber: true, pin: true } });

    await runConciergeAction(db.client, operator, ORG, { action: "port_mark_submitted", companyId: CO, input: { portId: port.id, twilioRequestId: "KW123abc" } }, NOW);
    expect(ports()[0]).toMatchObject({ status: "submitted", twilio_port_request_id: "KW123abc" });
    await expect(runConciergeAction(db.client, operator, ORG, { action: "port_set_foc", companyId: CO, input: { portId: port.id, focDate: "Oct 20" } }, NOW)).rejects.toThrow();
    // A port of another company can't be reached through this account.
    await expect(runConciergeAction(db.client, operator, HOUSE_ORG, { action: "port_cancel", companyId: HOUSE_CO, input: { portId: port.id } }, NOW)).rejects.toThrow(/isn't on this account/);
    expect(getConciergeAction("port_start")).not.toBeNull();
  });

  it("revealSecrets refuses once purged", async () => {
    const port = await readyPort();
    ports()[0].secrets_purged_at = new Date(NOW).toISOString();
    await expect(revealSecrets(db.client, scope, port.id)).rejects.toThrow(/purged/);
  });
});

function fakeTwilio(numbers: TwilioIncomingNumber[]): TwilioNumbersClient & { updates: Array<{ sid: string; input: unknown }> } {
  const updates: Array<{ sid: string; input: unknown }> = [];
  return {
    updates,
    searchAvailableLocal: () => Promise.resolve([]),
    listIncoming: (filter) => Promise.resolve(numbers.filter((n) => n.phone_number === filter.phoneNumber)),
    purchase: () => Promise.reject(new Error("never buys")),
    updateWebhooks: (sid, input) => {
      updates.push({ sid, input });
      return Promise.resolve({ sid, phone_number: "", voice_url: input.voiceUrl, sms_url: input.smsUrl, friendly_name: input.friendlyName });
    },
  };
}

describe("completion sweep", () => {
  it("waits until the number lands, then attaches it as a business_line, completes the port and texts the owner", async () => {
    const port = await readyPort();
    await markSubmitted(db.client, scope, port.id, { twilioRequestId: "PX1", nowMs: NOW });
    sendOwnerSms.mockClear();

    expect(await sweepPortCompletions(db.client, NOW, { client: fakeTwilio([]) })).toEqual([]);
    expect(ports()[0].status).toBe("submitted");

    const twilio = fakeTwilio([{ sid: "PN1", phone_number: LINE, voice_url: null, sms_url: null }]);
    expect(await sweepPortCompletions(db.client, NOW + 3_600_000, { client: twilio })).toEqual([port.id]);
    expect(twilio.updates).toEqual([
      { sid: "PN1", input: { voiceUrl: "https://hooks.test/api/twilio/voice/business-line", smsUrl: "https://hooks.test/api/twilio/sms/inbound", friendlyName: `EmpireVu line ${CO}` } },
    ]);
    const line = db.tables.voice_numbers.find((v) => v.phone_e164 === LINE);
    expect(line).toMatchObject({ organization_id: ORG, company_id: CO, provider: "twilio", mode: "business_line", provider_number_sid: "PN1", active: true });
    // The catcher number is untouched.
    expect(db.tables.voice_numbers.find((v) => v.id === "vn-catcher")).toMatchObject({ mode: "missed_call_catcher", active: true });
    expect(ports()[0]).toMatchObject({ status: "completed", attached_numbers: [LINE] });
    expect(texts()).toEqual([
      "Done: (705) 555-0142 now rings through us. Calls ring your cell first for 20 seconds (press 1 to take one), then your AI answers. You can turn call forwarding off now - it isn't needed any more.",
    ]);
    // Idempotent: another pass does nothing.
    expect(await sweepPortCompletions(db.client, NOW + 7_200_000, { client: twilio })).toEqual([]);
    expect(db.tables.voice_numbers.filter((v) => v.phone_e164 === LINE)).toHaveLength(1);
    expect(sendOwnerSms).toHaveBeenCalledTimes(1);
    // Settings shows it.
    expect((await getPortingView(db.client, scope))?.portedLines).toEqual(["(705) 555-0142"]);
  });

  it("never takes a number connected to another company", async () => {
    seed({ voice_numbers: [{ id: "vn-x", organization_id: HOUSE_ORG, company_id: HOUSE_CO, phone_e164: LINE, provider: "twilio", mode: "missed_call_catcher", active: true }] });
    const twilio = fakeTwilio([{ sid: "PN1", phone_number: LINE }]);
    const outcome = await attachBusinessLine(db.client, { organization_id: ORG, company_id: CO, business_name: "x" }, { sid: "PN1", phone_number: LINE }, twilio, "https://hooks.test");
    expect(outcome).toBe("taken");
    expect(twilio.updates).toEqual([]);
    expect(db.tables.voice_numbers[0]).toMatchObject({ company_id: HOUSE_CO, mode: "missed_call_catcher" });
  });

  it("purges the account number, PIN and bill 14 days after completion (not before); keeps the LOA", async () => {
    const port = await readyPort();
    const bill = String(ports()[0].bill_path);
    Object.assign(ports()[0], { status: "completed", completed_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString() });
    expect(await sweepPortPurge(db.client, NOW + PURGE_AFTER_MS - 3_600_000, deps())).toBe(0);
    expect(ports()[0].account_number_enc).toBeTruthy();
    expect(await sweepPortPurge(db.client, NOW + PURGE_AFTER_MS + 60_000, deps())).toBe(1);
    expect(ports()[0]).toMatchObject({ account_number_enc: null, pin_enc: null, bill_path: null });
    expect(ports()[0].loa_path).toBeTruthy();
    expect(ports()[0].secrets_purged_at).toBeTruthy();
    expect(storage.removed).toEqual([bill]);
    expect(await sweepPortPurge(db.client, NOW + PURGE_AFTER_MS + 120_000, deps())).toBe(0);
    void port;
  });

  it("registers three sweeps and no approval kinds", () => {
    expect(portingRole.sweeps.map((s) => [s.name, s.intervalMs])).toEqual([
      ["porting:completion", 3_600_000],
      ["porting:notify", 300_000],
      ["porting:purge", 3_600_000],
    ]);
    expect(Object.keys(portingRole.approvalExecutors)).toEqual([]);
  });
});

describe("the LOA", () => {
  it("is a one-page PDF with the signature record", async () => {
    const bytes = await buildLoaPdf({
      businessName: "Northshore Plumbing",
      authorizedName: "Dana Smith",
      serviceAddress: { line1: "12 Bay St", line2: "Unit 2", city: "Midland", province: "ON", postalCode: "L4R 1A1", country: "CA" },
      carrier: "Bell",
      numbers: [LINE, "+17055550143"],
      signedName: "Dana Smith",
      signedAtIso: new Date(NOW).toISOString(),
      signedIp: "203.0.113.9",
      signedUserAgent: "Mozilla/5.0",
      timeZone: TZ,
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toBe("Letter of Authorization - number port");
  });
});

describe("review fixes: what a port may touch, bills, abandoned ports, locking, texts", () => {
  const A1_LINE = "+17055557777";
  const PLATFORM = "+16475550000";
  const CATCHER = "+17055550100";

  async function submitWith(token: string, numbers: string[]) {
    const up = await createBillUpload(db.client, token, "image/jpeg", deps());
    storage.files.set(up!.path, new Uint8Array([1]));
    return submitPortForm(db.client, token, validForm({ numbers, billPath: up!.path }), { ip: null, userAgent: null, nowMs: NOW }, deps());
  }

  it("the form refuses the platform number, TWILIO_FROM_NUMBER (A1's line, with no voice_numbers row) and the company's own catcher", async () => {
    process.env.TWILIO_FROM_NUMBER = A1_LINE;
    process.env.PLATFORM_SMS_NUMBER = PLATFORM;
    const { port } = await startedPort();
    await expect(submitWith(port.token, [PLATFORM])).rejects.toThrow(/can't be moved here/);
    await expect(submitWith(port.token, [A1_LINE])).rejects.toThrow(/can't be moved here/);
    await expect(submitWith(port.token, [CATCHER])).rejects.toThrow(/already connected/);
    expect(ports()[0].status).toBe("collecting");
  });

  it("start never prefills or accepts a number that's already ours", async () => {
    process.env.TWILIO_FROM_NUMBER = A1_LINE;
    db.tables.companies[0].brand_reply_phone = A1_LINE;
    await expect(startPort(db.client, scope, { createdVia: "settings", number: CATCHER, nowMs: NOW }, deps())).rejects.toThrow(/already connected/);
    const { port } = await startPort(db.client, scope, { createdVia: "settings", nowMs: NOW }, deps());
    expect(port.numbers).toEqual([]);
  });

  it("the sweep never touches A1's line, the platform number or a catcher row, even when a port names them", async () => {
    process.env.TWILIO_FROM_NUMBER = A1_LINE;
    process.env.PLATFORM_SMS_NUMBER = PLATFORM;
    db.tables.number_port_requests.push({
      id: randomUUID(),
      organization_id: ORG,
      company_id: CO,
      token: "t".repeat(32),
      status: "submitted",
      numbers: [A1_LINE, PLATFORM, CATCHER],
      attached_numbers: [],
      preexisting_numbers: [],
      twilio_snapshot_at: new Date(NOW).toISOString(),
      pin_status: "none",
      created_at: new Date(NOW).toISOString(),
      updated_at: new Date(NOW).toISOString(),
    });
    const twilio = fakeTwilio([
      { sid: "PN-A1", phone_number: A1_LINE, voice_url: null, sms_url: null },
      { sid: "PN-P", phone_number: PLATFORM, voice_url: null, sms_url: null },
      { sid: "PN-C", phone_number: CATCHER, voice_url: "https://hooks.test/api/twilio/voice/inbound", sms_url: "https://hooks.test/api/twilio/sms/inbound", friendly_name: `EmpireVu catcher ${CO}` },
    ]);
    expect(await sweepPortCompletions(db.client, NOW, { client: twilio })).toEqual([]);
    expect(twilio.updates).toEqual([]);
    expect(db.tables.voice_numbers).toEqual([expect.objectContaining({ id: "vn-catcher", phone_e164: CATCHER, mode: "missed_call_catcher" })]);
    expect(ports()[0]).toMatchObject({ status: "submitted", attached_numbers: [] });
    // A1 (house org) is never touched either way.
    expect(db.tables.voice_numbers.some((v) => v.company_id === HOUSE_CO)).toBe(false);
  });

  it("refuses catcher-tagged numbers and numbers webhooked elsewhere; a fresh or already-ours number is fine", async () => {
    const url = "https://hooks.test/api/twilio/voice/business-line";
    expect(twilioSideOk({ sid: "x", phone_number: LINE }, CO, url)).toBe(true);
    expect(twilioSideOk({ sid: "x", phone_number: LINE, voice_url: "https://demo.twilio.com/welcome/voice/" }, CO, url)).toBe(true);
    expect(twilioSideOk({ sid: "x", phone_number: LINE, voice_url: url, friendly_name: `EmpireVu line ${CO}` }, CO, url)).toBe(true);
    expect(twilioSideOk({ sid: "x", phone_number: LINE, friendly_name: `EmpireVu catcher ${CO}` }, CO, url)).toBe(false);
    expect(twilioSideOk({ sid: "x", phone_number: LINE, friendly_name: `EmpireVu line ${OTHER_CO}` }, CO, url)).toBe(false);
    expect(twilioSideOk({ sid: "x", phone_number: LINE, voice_url: "https://other.example/voice" }, CO, url)).toBe(false);
    expect(twilioSideOk({ sid: "x", phone_number: LINE, sms_url: "https://hooks.test/api/twilio/sms/inbound" }, CO, url)).toBe(false);
    const twilio = fakeTwilio([]);
    const port = { organization_id: ORG, company_id: CO, business_name: "x" };
    expect(await attachBusinessLine(db.client, port, { sid: "PN1", phone_number: LINE, friendly_name: `EmpireVu catcher ${OTHER_CO}` }, twilio, "https://hooks.test")).toBe("taken");
    expect(await attachBusinessLine(db.client, port, { sid: "PN1", phone_number: LINE, voice_url: "https://elsewhere.test/v" }, twilio, "https://hooks.test")).toBe("taken");
    expect(await attachBusinessLine(db.client, port, { sid: "PN1", phone_number: CATCHER }, twilio, "https://hooks.test")).toBe("taken");
    expect(twilio.updates).toEqual([]);
    expect(db.tables.voice_numbers).toHaveLength(1);
  });

  it("only numbers that ARRIVE after 'Mark submitted' are attached (a number already in the account never is)", async () => {
    const port = await readyPort();
    const present = fakeTwilio([{ sid: "PN1", phone_number: LINE, voice_url: null, sms_url: null }]);
    h.twilio = present;
    await markSubmitted(db.client, scope, port.id, { twilioRequestId: "PX1", nowMs: NOW });
    expect(ports()[0]).toMatchObject({ preexisting_numbers: [LINE], twilio_snapshot_at: new Date(NOW).toISOString() });
    expect(await sweepPortCompletions(db.client, NOW + 3_600_000, { client: present })).toEqual([]);
    expect(present.updates).toEqual([]);
    expect(ports()[0].status).toBe("submitted");
    expect((await listOperatorPorts(db.client, NOW))[0].warnings.join(" ")).toContain("already in the Twilio account");
    // A port without a snapshot is never auto-attached.
    Object.assign(ports()[0], { preexisting_numbers: [], twilio_snapshot_at: null });
    expect(await sweepPortCompletions(db.client, NOW + 7_200_000, { client: present })).toEqual([]);
    expect(present.updates).toEqual([]);
  });

  it("markSubmitted refuses when Twilio can't be checked", async () => {
    const port = await readyPort();
    h.twilio = null;
    await expect(markSubmitted(db.client, scope, port.id, { twilioRequestId: "PX1", nowMs: NOW })).rejects.toThrow(/Twilio isn't configured/);
    h.twilio = { ...fakeTwilio([]), listIncoming: () => Promise.reject(new Error("503")) };
    await expect(markSubmitted(db.client, scope, port.id, { twilioRequestId: "PX1", nowMs: NOW })).rejects.toThrow(/Couldn't check the Twilio account/);
    expect(ports()[0].status).toBe("ready");
  });

  it("a replaced bill is deleted; the purge deletes every bill file in the folder (abandoned uploads too), keeping the LOA", async () => {
    const port = await readyPort();
    const first = String(ports()[0].bill_path);
    await markRejected(db.client, scope, port.id, { reason: "Bill too old", nowMs: NOW });
    const up = await createBillUpload(db.client, port.token, "application/pdf", deps());
    storage.files.set(up!.path, new Uint8Array([2]));
    await submitPortForm(db.client, port.token, validForm({ accountNumber: null, pin: null, billPath: up!.path }), { ip: null, userAgent: null, nowMs: NOW }, deps());
    expect(storage.removed).toEqual([first]);
    // An upload that was never submitted.
    const stray = await createBillUpload(db.client, port.token, "image/png", deps());
    storage.files.set(stray!.path, new Uint8Array([3]));
    Object.assign(ports()[0], { status: "cancelled", cancelled_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString() });
    expect(await sweepPortPurge(db.client, NOW + PURGE_AFTER_MS + 60_000, deps())).toBe(1);
    expect([...storage.removed].sort()).toEqual([first, up!.path, stray!.path].sort());
    expect([...storage.files.keys()].every((p) => /\/loa-/.test(p))).toBe(true);
  });

  it("ports left unfinished for 60 days are cancelled (owner texted), then purged 14 days later", async () => {
    await readyPort();
    ports()[0].updated_at = new Date(NOW - ABANDON_AFTER_MS - 60_000).toISOString();
    sendOwnerSms.mockClear();
    await sweepPortPurge(db.client, NOW, deps());
    expect(ports()[0]).toMatchObject({ status: "cancelled", cancelled_at: new Date(NOW).toISOString() });
    expect(texts()[0]).toContain("was cancelled");
    expect(ports()[0].account_number_enc).toBeTruthy();
    await sweepPortPurge(db.client, NOW + PURGE_AFTER_MS + 60_000, deps());
    expect(ports()[0]).toMatchObject({ account_number_enc: null, pin_enc: null, bill_path: null });
  });

  it("the owner's form locks once an operator starts on it (copy / reveal / submit) and reopens on rejection", async () => {
    const port = await readyPort();
    const operator = { email: "ops@crankleads.test", userId: "u-op" };
    await runConciergeAction(db.client, operator, ORG, { action: "port_opened", companyId: CO, input: { portId: port.id } }, NOW);
    expect(ports()[0].operator_opened_at).toBeTruthy();
    expect(await getPortView(db.client, port.token, NOW)).toMatchObject({ status: "ready", editable: false, serviceAddress: null });
    await expect(submitPortForm(db.client, port.token, validForm(), { ip: null, userAgent: null, nowMs: NOW }, deps())).rejects.toThrow(/started sending this to your carrier/);
    await expect(createBillUpload(db.client, port.token, "image/jpeg", deps())).rejects.toThrow(/started sending/);
    await markRejected(db.client, scope, port.id, { reason: "Name mismatch", nowMs: NOW });
    expect((await getPortView(db.client, port.token, NOW))?.editable).toBe(true);
    await submitPortForm(db.client, port.token, validForm({ accountNumber: null, pin: null }), { ip: null, userAgent: null, nowMs: NOW }, deps());
    expect(ports()[0]).toMatchObject({ status: "ready", operator_opened_at: null });
    await runConciergeAction(db.client, operator, ORG, { action: "port_reveal_secrets", companyId: CO, input: { portId: port.id } }, NOW);
    expect(ports()[0].operator_opened_at).toBeTruthy();
  });

  it("a sent owner text is cleared, so the notify sweep only ever sees pending ones", async () => {
    await startedPort();
    expect(ports()[0].notify_status).toBeNull();
    expect(ports()[0].notified_status).toMatch(/^collecting@/);
    sendOwnerSms.mockClear();
    await sweepPortNotifications(db.client, NOW + 300_000);
    expect(sendOwnerSms).not.toHaveBeenCalled();
  });

  it("decryption refuses a truncated GCM tag", () => {
    const key = portingKey()!;
    const [v, iv, tag, data] = encryptSecret(ACCOUNT, "row-1", key).split(".");
    const short = Buffer.from(tag, "base64url").subarray(0, 12).toString("base64url");
    expect(decryptSecret([v, iv, short, data].join("."), "row-1", key)).toBeNull();
    expect(decryptSecret([v, iv, tag, data].join("."), "row-1", key)).toBe(ACCOUNT);
  });
});
