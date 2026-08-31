import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A send that succeeded must not report failure.
 *
 * sendQuote writes the status to 'sent' BEFORE the email goes out. The email
 * step used to throw, so a quote came back numbered, stamped and payable while
 * the API answered 500 — observed in production as Q-2026-0001. An operator
 * seeing that error would reasonably press Send again, or conclude a live quote
 * does not exist.
 *
 * These pin the two failures that must NOT fail the send: no address on the
 * contact, and the mail provider erroring.
 */

const deliver = vi.fn();
const recorded: Array<{ type: string; meta: unknown }> = [];

let contactEmail: string | null = "pat@example.com";

vi.mock("@/server/outbound/email", () => ({
  sendEmail: (...a: unknown[]) => deliver(...a),
}));

vi.mock("@/server/services/quotes/public-service", () => ({
  recordPublicEvent: async (_org: string, _id: string, type: string, meta: unknown) => {
    recorded.push({ type, meta });
  },
}));

vi.mock("@/server/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from(table: string) {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () =>
          Promise.resolve({
            data:
              table === "quotes"
                ? {
                    id: "q1",
                    organization_id: "org1",
                    company_id: "c1",
                    contact_id: "ct1",
                    public_token: "tok",
                    quote_number: "Q-2026-0001",
                    title: "Winter storage",
                    currency: "CAD",
                    total_cents: 400,
                    deposit_cents: 100,
                    intro_message: null,
                    valid_until: "2026-09-30T00:00:00.000Z",
                    expires_at: "2026-09-30T00:00:00.000Z",
                  }
                : table === "companies"
                  ? { id: "c1", name: "A1 Marine Storage", brand_reply_email: "quotes@example.ca" }
                  : { email: contactEmail, first_name: "Pat" },
            error: null,
          }),
      };
      return chain;
    },
  }),
}));

const { sendQuoteEmail } = await import("@/server/services/quotes/notify");

beforeEach(() => {
  deliver.mockReset();
  deliver.mockResolvedValue(undefined);
  recorded.length = 0;
  contactEmail = "pat@example.com";
});

describe("a missing email address does not fail the send", () => {
  it("resolves instead of throwing", async () => {
    contactEmail = null;
    // The throw here was the production 500. The quote was already sent.
    await expect(sendQuoteEmail("q1")).resolves.toBeTruthy();
  });

  it("reports not-delivered with a reason an operator can act on", async () => {
    contactEmail = null;
    const out = await sendQuoteEmail("q1");
    expect(out.delivered).toBe(false);
    // Not a stack trace, and it says what to do instead.
    expect(out.reason).toMatch(/no email address/i);
    expect(out.reason).toMatch(/link/i);
  });

  it("still records why, so the audit trail explains the silence", async () => {
    contactEmail = null;
    await sendQuoteEmail("q1");
    expect(recorded.map((r) => r.type)).toContain("quote_email_skipped");
  });

  it("does not attempt delivery with no recipient", async () => {
    contactEmail = null;
    await sendQuoteEmail("q1");
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe("a provider outage does not fail the send either", () => {
  it("resolves, reports the reason, and records the failure", async () => {
    deliver.mockRejectedValue(new Error("Resend 503"));
    const out = await sendQuoteEmail("q1");
    // The customer's quote exists and is payable; hiding it behind a 500 because
    // our mail provider is down would be the wrong trade.
    expect(out.delivered).toBe(false);
    expect(out.reason).toMatch(/could not be delivered/i);
    expect(recorded.map((r) => r.type)).toContain("quote_email_failed");
  });

  it("does not leak the rendered body into the event or the reason", async () => {
    deliver.mockRejectedValue(new Error("x".repeat(2000)));
    const out = await sendQuoteEmail("q1");
    // Bodies carry customer detail. The cap is what keeps them out of the log.
    expect((out.reason ?? "").length).toBeLessThan(300);
    const failed = recorded.find((r) => r.type === "quote_email_failed");
    expect(String((failed?.meta as { error: string }).error).length).toBeLessThanOrEqual(500);
  });
});

describe("the happy path still reports delivery", () => {
  it("delivers and says so", async () => {
    const out = await sendQuoteEmail("q1");
    expect(out).toEqual({ delivered: true, reason: null });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(recorded.map((r) => r.type)).toContain("quote_email_sent");
  });
});
