/**
 * D7: deliverMessage (workflows, the AI staff, digests, booking confirmations…) sends a company's
 * email from that company's sender, read with the SERVICE-ROLE client by companyId and cached; it
 * passes nothing new when that is the platform sender anyway, so sendEmail sees exactly the input
 * it did before. Platform mail passes `fromAddress: null` and never looks it up. A failed lookup
 * with EVERDOER_DEFAULT_FROM_EMAIL set fails the send visibly (status "failed", message_log row).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendEmail = vi.fn();
const adminReads: string[] = [];
let adminFails = false;
const COMPANIES: Record<string, { organization_id: string; email_from_address: string | null }> = {
  "co-a1": { organization_id: "org-a1", email_from_address: null },
  "co-a1-own": { organization_id: "org-a1", email_from_address: "care@a1marinecare.ca" },
  "co-b": { organization_id: "org-b", email_from_address: null },
};
const ORGS: Record<string, { plan: string; slug: string }> = { "org-a1": { plan: "internal", slug: "a1-group" }, "org-b": { plan: "operate", slug: "bobs" } };

vi.mock("@/server/outbound/email", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));
vi.mock("@/server/outbound/sms", () => ({ sendSms: vi.fn() }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: () => Promise.resolve() }));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({ emitActivityEventAndDispatch: vi.fn() }));
vi.mock("@/server/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from(table: string) {
      let id = "";
      const api = {
        select: () => api,
        eq: (_c: string, v: string) => {
          id = v;
          return api;
        },
        maybeSingle: () => {
          adminReads.push(`${table}:${id}`);
          if (adminFails) return Promise.resolve({ data: null, error: { message: "db down" } });
          return Promise.resolve({ data: (table === "companies" ? COMPANIES[id] : ORGS[id]) ?? null, error: null });
        },
      };
      return api;
    },
  }),
}));

import { resetCompanySenderCache } from "@/server/outbound/company-sender";
import { deliverMessage } from "@/server/services/workflow-engine/messaging";

function fakeContext() {
  const logs: Array<Record<string, unknown>> = [];
  const supabase = {
    from(table: string) {
      const api = {
        insert: (row: Record<string, unknown>) => {
          if (table === "message_log") logs.push(row);
          return Promise.resolve({ error: null });
        },
        select: () => api,
        eq: () => api,
        limit: () => Promise.resolve({ data: [], error: null }),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      };
      return api;
    },
  };
  return { context: { organizationId: "org-1", actorProfileId: null, supabase } as never, logs };
}

const email = (over: Record<string, unknown>) => ({
  channel: "email" as const,
  to: "jane@example.com",
  subject: "Your booking",
  body: "See you Tuesday.",
  contactId: null,
  consentContact: null,
  fromName: "A1 Marine Care",
  replyTo: "office@a1marinecare.ca",
  ...over,
});

beforeEach(() => {
  sendEmail.mockReset().mockResolvedValue({ id: "re_1" });
  adminReads.length = 0;
  adminFails = false;
  vi.stubEnv("OUTBOUND_FROM_EMAIL", "A1 Marine Storage <quotes@a1marinestorage.ca>");
  vi.stubEnv("LEAD_FROM_EMAIL", "");
  vi.stubEnv("EVERDOER_DEFAULT_FROM_EMAIL", "");
  vi.stubEnv("LEAD_INTAKE_ORG_SLUG", "a1-group");
  resetCompanySenderCache();
});

afterEach(() => vi.unstubAllEnvs());

describe("deliverMessage From", () => {
  it("nothing new set: sendEmail gets exactly the input it got before", async () => {
    const { context } = fakeContext();
    await deliverMessage({ context, companyId: "co-b", ...email({ fromName: "Bob's Roofing", replyTo: null }) });
    await deliverMessage({ context, companyId: "co-a1", ...email({}) });
    expect(sendEmail.mock.calls[0][0]).toEqual({ to: "jane@example.com", subject: "Your booking", body: "See you Tuesday.", html: undefined, fromName: "Bob's Roofing", replyTo: undefined });
    expect(sendEmail.mock.calls[1][0]).not.toHaveProperty("fromAddress");
  });

  it("with EVERDOER_DEFAULT_FROM_EMAIL set: A1 keeps OUTBOUND_FROM_EMAIL verbatim, a company's own address wins, read once per company", async () => {
    vi.stubEnv("EVERDOER_DEFAULT_FROM_EMAIL", "hello@everdoer.com");
    const { context } = fakeContext();
    await deliverMessage({ context, companyId: "co-a1", ...email({}) });
    await deliverMessage({ context, companyId: "co-a1", ...email({ to: "bob@example.com" }) });
    await deliverMessage({ context, companyId: "co-a1-own", ...email({}) });
    await deliverMessage({ context, companyId: "co-b", ...email({ fromName: "Bob's Roofing" }) });
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ fromAddress: "A1 Marine Storage <quotes@a1marinestorage.ca>", replyTo: "office@a1marinecare.ca" });
    expect(sendEmail.mock.calls[1][0]).toMatchObject({ fromAddress: "A1 Marine Storage <quotes@a1marinestorage.ca>" });
    expect(sendEmail.mock.calls[2][0]).toMatchObject({ fromAddress: "care@a1marinecare.ca" });
    expect(sendEmail.mock.calls[3][0]).not.toHaveProperty("fromAddress"); // → hello@everdoer.com in sendEmail
    expect(adminReads.filter((r) => r === "companies:co-a1")).toHaveLength(1);
  });

  it("platform mail (fromAddress: null) never looks the company up", async () => {
    vi.stubEnv("EVERDOER_DEFAULT_FROM_EMAIL", "hello@everdoer.com");
    const { context } = fakeContext();
    await deliverMessage({ context, companyId: "co-a1", ...email({ fromName: "Everdoer", fromAddress: null }) });
    expect(sendEmail.mock.calls[0][0]).not.toHaveProperty("fromAddress");
    expect(adminReads).toEqual([]);
  });

  it("lookup fails, EVERDOER_DEFAULT_FROM_EMAIL unset: sends as before", async () => {
    adminFails = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { context } = fakeContext();
    const r = await deliverMessage({ context, companyId: "co-a1", ...email({}) });
    expect(r.status).toBe("sent");
    expect(sendEmail.mock.calls[0][0]).not.toHaveProperty("fromAddress");
    err.mockRestore();
  });

  it("lookup fails, EVERDOER_DEFAULT_FROM_EMAIL set: nothing is sent, the failure is returned and logged", async () => {
    vi.stubEnv("EVERDOER_DEFAULT_FROM_EMAIL", "hello@everdoer.com");
    adminFails = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { context, logs } = fakeContext();
    const r = await deliverMessage({ context, companyId: "co-a1", ...email({}) });
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/not sending rather than guessing/);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(logs[0]).toMatchObject({ status: "failed", channel: "email" });
    err.mockRestore();
  });

  it("SMS never looks the sender up", async () => {
    const { context } = fakeContext();
    await deliverMessage({ context, companyId: "co-a1", channel: "sms", to: "+17055550100", body: "Hi", contactId: null, consentContact: null }).catch(() => undefined);
    expect(adminReads).toEqual([]);
  });
});
