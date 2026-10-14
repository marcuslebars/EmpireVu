/**
 * D7: deliverMessage (workflows, the AI staff, digests, booking confirmations…) sends a
 * company's email from that company's own sender, looked up by companyId and cached, and
 * passes nothing new when the company has none, so sendEmail sees exactly the input it
 * did before. Platform mail passes `fromAddress: null` and never looks it up.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendEmail = vi.fn();
vi.mock("@/server/outbound/email", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));
vi.mock("@/server/outbound/sms", () => ({ sendSms: vi.fn() }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: () => Promise.resolve() }));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({ emitActivityEventAndDispatch: vi.fn() }));

import { resetCompanySenderCache } from "@/server/outbound/company-sender";
import { deliverMessage } from "@/server/services/workflow-engine/messaging";

function fakeContext(companies: Record<string, string | null>) {
  const companyReads: string[] = [];
  const supabase = {
    from(table: string) {
      let id = "";
      const api = {
        insert: () => Promise.resolve({ error: null }),
        select: () => api,
        eq: (col: string, value: string) => {
          if (col === "id") id = value;
          return api;
        },
        limit: () => Promise.resolve({ data: [], error: null }),
        maybeSingle: () => {
          if (table === "companies") {
            companyReads.push(id);
            return Promise.resolve({ data: id in companies ? { email_from_address: companies[id] } : null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return api;
    },
  };
  return { context: { organizationId: "org-1", actorProfileId: null, supabase } as never, companyReads };
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
  resetCompanySenderCache();
});

describe("deliverMessage From address", () => {
  it("a company with its own sender: passes it (once per company, cached)", async () => {
    const { context, companyReads } = fakeContext({ "co-a1": "quotes@a1marinecare.ca" });
    await deliverMessage({ context, companyId: "co-a1", ...email({}) });
    await deliverMessage({ context, companyId: "co-a1", ...email({ to: "bob@example.com" }) });
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ fromAddress: "quotes@a1marinecare.ca", fromName: "A1 Marine Care", replyTo: "office@a1marinecare.ca" });
    expect(sendEmail.mock.calls[1][0]).toMatchObject({ fromAddress: "quotes@a1marinecare.ca" });
    expect(companyReads).toEqual(["co-a1"]);
  });

  it("a company without one: sendEmail gets exactly the input it got before (no fromAddress key)", async () => {
    const { context } = fakeContext({ "co-b": null });
    await deliverMessage({ context, companyId: "co-b", ...email({ fromName: "Bob's Roofing", replyTo: null }) });
    expect(sendEmail.mock.calls[0][0]).toEqual({ to: "jane@example.com", subject: "Your booking", body: "See you Tuesday.", html: undefined, fromName: "Bob's Roofing", replyTo: undefined });
  });

  it("platform mail (fromAddress: null) never uses the company's sender and doesn't look it up", async () => {
    const { context, companyReads } = fakeContext({ "co-a1": "quotes@a1marinecare.ca" });
    await deliverMessage({ context, companyId: "co-a1", ...email({ fromName: "Everdoer", fromAddress: null }) });
    expect(sendEmail.mock.calls[0][0]).not.toHaveProperty("fromAddress");
    expect(companyReads).toEqual([]);
  });

  it("SMS never looks the sender up", async () => {
    const { context, companyReads } = fakeContext({ "co-a1": "quotes@a1marinecare.ca" });
    await deliverMessage({ context, companyId: "co-a1", channel: "sms", to: "+17055550100", body: "Hi", contactId: null, consentContact: null }).catch(() => undefined);
    expect(companyReads).toEqual([]);
  });
});
